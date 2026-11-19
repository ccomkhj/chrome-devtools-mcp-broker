import { pathToFileURL } from 'node:url';

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function createMockState() {
  return {
    workers: [],
    events: [],
    active: 0,
    maxActive: 0,
    gates: new Map(),
    gate(name) {
      if (!this.gates.has(name)) {
        this.gates.set(name, { started: deferred(), released: deferred() });
      }
      return this.gates.get(name);
    },
  };
}

export const mockTools = [
  { name: 'echo', description: 'Return the supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'write', description: 'Write session-local state.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
  { name: 'read', description: 'Read session-local state.', inputSchema: { type: 'object', properties: {} } },
  { name: 'hold', description: 'Wait for a test-controlled gate.', inputSchema: { type: 'object', properties: { gate: { type: 'string' }, delayMs: { type: 'number' } } } },
  { name: 'large', description: 'Return long, escaped Unicode text.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Return an upstream tool error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'process_id', description: 'Identify the executable test worker.', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Report named environment variables of the worker.', inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] } },
];

export const largeText = 'quote:" backslash:\\ emoji:💡\n'.repeat(600);

function waitForSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export function createMockUpstreamFactory(state = createMockState()) {
  return async ({ sessionId, label }) => {
    let value = '';
    const worker = {
      sessionId,
      label,
      closed: false,
      async listTools() { return mockTools; },
      async callTool(name, args = {}, { signal } = {}) {
        if (worker.closed) throw new Error('Worker is closed');
        state.events.push({ type: 'start', sessionId, name, args });
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          let text;
          switch (name) {
            case 'echo': text = args.text; break;
            case 'write': value = args.value; text = value; break;
            case 'read': text = value; break;
            case 'large': text = largeText; break;
            case 'process_id': text = process.pid; break;
            case 'env': text = JSON.stringify(Object.fromEntries(args.names.map((key) => [key, process.env[key] ?? null]))); break;
            case 'fail': return { isError: true, content: [{ type: 'text', text: 'Deliberate upstream failure' }] };
            case 'hold': {
              if (args.delayMs !== undefined) {
                let timer;
                try {
                  await waitForSignal(new Promise((resolve) => { timer = setTimeout(resolve, args.delayMs); }), signal);
                } finally { clearTimeout(timer); }
              } else {
                const gate = state.gate(args.gate);
                gate.started.resolve();
                await waitForSignal(gate.released.promise, signal);
              }
              text = 'released';
              break;
            }
            default: throw new Error(`Unknown mock tool: ${name}`);
          }
          return { content: [{ type: 'text', text: String(text) }] };
        } finally {
          state.active -= 1;
          state.events.push({ type: 'end', sessionId, name, args });
        }
      },
      async close() { worker.closed = true; },
    };
    state.workers.push(worker);
    return worker;
  };
}

// Executable fixture for testing a real stdio MCP worker process. Like upstream, it only warns about flags it does not know.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2);
  if (flags.length) process.stderr.write(`Unknown arguments: ${flags.join(',')}\n`);
  const [{ Server }, { StdioServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const worker = await createMockUpstreamFactory()({ sessionId: 'stdio-test', label: 'fixture' });
  const server = new Server({ name: 'mock-chrome-devtools', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await worker.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => worker.callTool(params.name, params.arguments, { signal: extra.signal }));
  await server.connect(new StdioServerTransport());
}
