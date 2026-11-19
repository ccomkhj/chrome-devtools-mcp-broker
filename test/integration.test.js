import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { defaultPort, startHttp } from '../src/http.js';
import { SessionManager } from '../src/sessions.js';
import { createUpstreamFactory, workerFlags } from '../src/upstream.js';
import { createMockState, createMockUpstreamFactory, deferred, largeText } from './mock-upstream.js';

function parse(result) {
  const block = result.content?.find((item) => item.type === 'text');
  assert.ok(block, 'MCP tool response contains a text block');
  return JSON.parse(block.text);
}

async function within(promise, ms = 2500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent operation did not make progress')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function until(check, ms = 2500) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'expected queue state did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const testToken = 'integration-test-token-not-a-real-secret';
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const testDir = fileURLToPath(new URL('.', import.meta.url)); // an existing directory that does not contain the OS temp dir
const auth = { Authorization: `Bearer ${testToken}` };

async function fixture(t, options = {}, overrides = {}) {
  const state = createMockState();
  const app = createApp({ upstreamFactory: createMockUpstreamFactory(state), ...options });
  const httpOptions = { token: testToken, ...overrides };
  const http = await startHttp(app, { host: '127.0.0.1', port: 0, ...httpOptions });
  const clients = [];
  t.after(async () => {
    for (const gate of state.gates.values()) gate.released.resolve();
    await Promise.allSettled(clients.map((client) => client.close()));
    await http.close();
    await app.close();
  });
  async function client(token = httpOptions.token) {
    const instance = new Client({ name: 'wrapper-integration', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    await instance.connect(transport);
    clients.push(instance);
    return instance;
  }
  return { state, app, http, client };
}

async function open(client, label) {
  const result = parse(await client.callTool({ name: 'chrome_session', arguments: { action: 'open', label } }));
  assert.equal(typeof result.sessionId, 'string');
  return result.sessionId;
}

function call(client, sessionId, tool, args = {}, output = {}) {
  return client.callTool({ name: 'chrome_call', arguments: { sessionId, tool, args, ...output } });
}

test('HTTP exposes a small tool surface and discovers exact upstream schemas on demand', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((item) => item.name).sort(), ['chrome_call', 'chrome_read', 'chrome_session', 'chrome_tools']);
  assert.equal(f.state.workers.length, 0, 'listing wrapper tools does not launch Chrome workers');
  const sessionId = await open(client, 'schema-reader');
  const named = parse(await client.callTool({ name: 'chrome_tools', arguments: { sessionId, name: 'echo' } }));
  assert.equal(named.name, 'echo');
  assert.equal(named.inputSchema.properties.text.type, 'string');
  assert.deepEqual(named.inputSchema.required, ['text']);
  assert.equal(f.state.events.length, 0, 'schema discovery does not execute browser tools');
});

test('every tool rejects unknown top-level keys and lists the accepted ones; chrome_call adds that upstream arguments go inside args', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const { tools } = await client.listTools();
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  const { properties } = tools.find((tool) => tool.name === 'chrome_call').inputSchema;
  assert.match(properties.tool.description, /chrome_tools/);
  assert.match(properties.args.description, /^Arguments for the upstream tool, exactly as its schema \(from chrome_tools\) defines\.$/);
  const sessionId = await open(client, 'strict');
  const accepted = 'This tool accepts only: sessionId, tool, args, maxChars, select, filter, includeImages. Upstream tool arguments go inside args.';
  const misplaced = await client.callTool({ name: 'chrome_call', arguments: { sessionId, tool: 'echo', text: 'misplaced' } });
  assert.equal(misplaced.isError, true);
  assert.ok(misplaced.content[0].text.endsWith(`Unknown argument text. ${accepted}`), misplaced.content[0].text);
  // A typo of a broker key is not an upstream argument: the accepted keys show the right spelling.
  const typo = await client.callTool({ name: 'chrome_call', arguments: { session: sessionId, tool: 'echo', args: { text: 'typo' } } });
  assert.equal(typo.isError, true);
  assert.ok(typo.content[0].text.includes(`Unknown argument session. ${accepted}`), typo.content[0].text);
  assert.equal(f.state.events.length, 0, 'a misplaced argument is not silently dropped and run without it');
  for (const [name, args] of [
    ['chrome_session', { action: 'info', sessionId, pageId: 2 }],
    ['chrome_tools', { sessionId, pageId: 2 }],
    ['chrome_read', { sessionId, resultId: 'r_x', pageId: 2 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /Unknown argument pageId\. This tool accepts only: \w+, [\w, ]+\.$/, name);
  }
});

test('chrome_session and chrome_tools describe every parameter', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  for (const tool of (await client.listTools()).tools.filter(({ name }) => ['chrome_session', 'chrome_tools'].includes(name))) {
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) assert.ok(schema.description, `${tool.name}.${key}`);
  }
});

test('agents are told to close their session: slots are limited and an idle one expires only after the TTL', async (t) => {
  const f = await fixture(t, { maxSessions: 3 });
  const client = await f.client();
  assert.match(client.getInstructions(), /Only 3 sessions can be open at once: close yours \(chrome_session action "close"\) when done; an idle session holds its slot until it expires after idleTtlMs\./);
  const session = (await client.listTools()).tools.find((tool) => tool.name === 'chrome_session');
  assert.match(session.description, /Close it when done: .*idleTtlMs/);
});

test('one chrome_tools call lists up to 50 upstream tools', async (t) => {
  const upstreamTools = Array.from({ length: 51 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: 'object', properties: {} } }));
  const upstreamFactory = async () => ({ async listTools() { return upstreamTools; }, async callTool() {}, async close() {} });
  const f = await fixture(t, { upstreamFactory });
  const client = await f.client();
  const sessionId = await open(client, 'lister');
  const listed = parse(await client.callTool({ name: 'chrome_tools', arguments: { sessionId } }));
  assert.equal(listed.tools.length, 50);
  assert.equal(listed.total, 51);
  assert.equal(listed.nextOffset, 50);
});

test('two independent MCP clients execute in parallel and maintain separate state', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.client(), f.client()]);
  const [sa, sb] = await Promise.all([open(a, 'agent-a'), open(b, 'agent-b')]);
  assert.notEqual(sa, sb);
  const ga = f.state.gate('agent-a');
  const gb = f.state.gate('agent-b');
  const tasks = [call(a, sa, 'hold', { gate: 'agent-a' }), call(b, sb, 'hold', { gate: 'agent-b' })];
  try {
    await within(Promise.all([ga.started.promise, gb.started.promise]));
    assert.equal(f.state.active, 2, 'both upstream calls are simultaneously active');
  } finally { ga.released.resolve(); gb.released.resolve(); }
  await Promise.all(tasks);
  await Promise.all([call(a, sa, 'write', { value: 'alpha' }), call(b, sb, 'write', { value: 'beta' })]);
  const [va, vb] = await Promise.all([call(a, sa, 'read'), call(b, sb, 'read')]);
  assert.equal(parse(va).data, 'alpha');
  assert.equal(parse(vb).data, 'beta');
});

test('same-session commands remain FIFO while an independent session makes progress', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.client(), f.client()]);
  const [sa, sb] = await Promise.all([open(a, 'ordered-agent'), open(b, 'free-agent')]);
  const gate = f.state.gate('ordering');
  const held = call(a, sa, 'hold', { gate: 'ordering' });
  await within(gate.started.promise);
  const queued = call(a, sa, 'echo', { text: 'second' });
  const independent = await within(call(b, sb, 'echo', { text: 'independent' }));
  assert.equal(parse(independent).data, 'independent');
  assert.equal(f.state.events.some((event) => event.type === 'start' && event.sessionId === sa && event.name === 'echo'), false);
  gate.released.resolve();
  await held;
  assert.equal(parse(await queued).data, 'second');
  const events = f.state.events.filter((event) => event.sessionId === sa).map((event) => `${event.type}:${event.name}`);
  assert.deepEqual(events, ['start:hold', 'end:hold', 'start:echo', 'end:echo']);
});

test('large responses are bounded and can be read without repeating the browser action', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const sessionId = await open(client, 'reader');
  const initial = await call(client, sessionId, 'large', {}, { maxChars: 512 });
  assert.ok(initial.content[0].text.length <= 512);
  let page = parse(initial);
  assert.equal(page.truncated, true);
  assert.equal(typeof page.resultId, 'string');
  const resultId = page.resultId;
  let text = page.data;
  let pages = 1;
  while (page.nextOffset !== undefined && page.nextOffset !== null) {
    const response = await client.callTool({
      name: 'chrome_read', arguments: { sessionId, resultId, offset: page.nextOffset, maxChars: 4096 },
    });
    assert.ok(response.content[0].text.length <= 4096);
    page = parse(response);
    text += page.data;
    assert.ok(++pages < 100, 'paging advances');
  }
  assert.equal(text, largeText);
  assert.equal(f.state.events.filter((event) => event.type === 'start' && event.name === 'large').length, 1);
});

test('results cannot be fetched using another browser session', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const sa = await open(client, 'owner');
  const sb = await open(client, 'other');
  const original = parse(await call(client, sa, 'echo', { text: 'private-session-result' }));
  const foreign = await client.callTool({ name: 'chrome_read', arguments: { sessionId: sb, resultId: original.resultId } });
  assert.equal(foreign.isError, true);
  assert.doesNotMatch(JSON.stringify(foreign), /private-session-result/);
});

test('upstream failures remain visible and unknown tools never execute', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const sessionId = await open(client, 'errors');
  const failed = await call(client, sessionId, 'fail');
  assert.equal(failed.isError, true);
  assert.equal(parse(failed).ok, false);
  assert.match(parse(failed).data, /Deliberate upstream failure/);
  const unknown = await call(client, sessionId, 'not_a_tool');
  assert.equal(unknown.isError, true);
  assert.equal(f.state.events.some((event) => event.name === 'not_a_tool'), false);
});

test('invalid output options are rejected before browser side effects execute', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const sessionId = await open(client, 'invalid-options');
  const invalid = [
    { filter: '' },
    { filter: 'x'.repeat(257) },
    { select: 'missing-leading-slash' },
    { select: '/invalid~2escape' },
    { select: '/__proto__/polluted' },
  ];
  for (const output of invalid) {
    const response = await call(client, sessionId, 'write', { value: 'must-not-run' }, output);
    assert.equal(response.isError, true, JSON.stringify(output));
  }
  assert.equal(f.state.events.length, 0, 'invalid formatting options never reach an upstream tool');
  assert.equal(f.app.results.stats().entries, 0);
});

test('a missing selection reports execution and supports cached recovery without repeating a side effect', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const sessionId = await open(client, 'recover-output');
  const response = await call(client, sessionId, 'write', { value: 'written-once' }, {
    select: '/structuredContent/missing', maxChars: 512,
  });
  assert.equal(response.isError, true);
  assert.ok(response.content[0].text.length <= 512, 'formatting diagnostics respect the output budget');
  const error = parse(response);
  assert.equal(error.executed, true);
  assert.equal(error.upstreamIsError, false);
  assert.equal(error.stored, true);
  assert.equal(typeof error.resultId, 'string');
  assert.equal(error.error.code, 'INVALID_SELECTION');
  const recovered = await client.callTool({
    name: 'chrome_read', arguments: { sessionId, resultId: error.resultId, maxChars: 512 },
  });
  assert.ok(recovered.content[0].text.length <= 512);
  assert.equal(parse(recovered).data, 'written-once');
  assert.equal(f.state.events.filter((event) => event.type === 'start' && event.name === 'write').length, 1);
});

test('long escaped upstream errors respect the requested response budget', async (t) => {
  const upstreamFactory = async () => ({
    async listTools() { return [{ name: 'throw_error', inputSchema: { type: 'object', properties: {} } }]; },
    async callTool() { throw Object.assign(new Error('quoted:"\\\n💡'.repeat(1000)), { code: 'UPSTREAM_' + 'X'.repeat(100) }); },
    async close() {},
  });
  const f = await fixture(t, { upstreamFactory });
  const client = await f.client();
  const sessionId = await open(client, 'long-error');
  const response = await call(client, sessionId, 'throw_error', {}, { maxChars: 512 });
  assert.equal(response.isError, true);
  assert.ok(response.content[0].text.length <= 512);
  const error = parse(response);
  assert.equal(error.ok, false);
  assert.ok(error.error.code.length <= 80);
  assert.ok(error.error.message.length > 0);
});

test('capacity is bounded and closing a session releases its slot', async (t) => {
  const f = await fixture(t, { maxSessions: 2 });
  const client = await f.client();
  const first = await open(client, 'first');
  await open(client, 'second');
  const full = await client.callTool({ name: 'chrome_session', arguments: { action: 'open', label: 'third' } });
  assert.equal(full.isError, true);
  assert.equal(parse(full).error.code, 'CAPACITY');
  assert.match(parse(full).error.message, /0 busy, 2 idle, 0 closing\. The soonest idle session expires in 600s\./);
  await client.callTool({ name: 'chrome_session', arguments: { action: 'close', sessionId: first } });
  const replacement = await open(client, 'replacement');
  assert.notEqual(replacement, first);
  assert.equal(f.state.workers.find((worker) => worker.sessionId === first).closed, true);
});

test('concurrent opens reserve capacity before initializing workers', async (t) => {
  const f = await fixture(t, { maxSessions: 2 });
  const client = await f.client();
  const attempts = await Promise.all(Array.from({ length: 5 }, (_, i) => client.callTool({
    name: 'chrome_session', arguments: { action: 'open', label: `racer-${i}` },
  })));
  assert.equal(attempts.filter((result) => !result.isError).length, 2);
  assert.equal(attempts.filter((result) => result.isError).length, 3);
  assert.equal(f.state.workers.length, 2);
});

test('queue limits reject excess calls without blocking another agent', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { maxQueue: 1 });
  const [a, b] = await Promise.all([f.client(), f.client()]);
  const [sa, sb] = await Promise.all([open(a, 'busy-agent'), open(b, 'free-agent')]);
  const gate = f.state.gate('queue-limit');
  const active = call(a, sa, 'hold', { gate: 'queue-limit' });
  await within(gate.started.promise);
  const queued = call(a, sa, 'echo', { text: 'queued' });
  await until(() => f.app.manager.getInfo(sa).queued === 1);
  const rejected = await within(call(a, sa, 'echo', { text: 'overflow' }));
  assert.equal(rejected.isError, true);
  assert.equal(parse(rejected).error.code, 'QUEUE_FULL');
  assert.equal(parse(await within(call(b, sb, 'echo', { text: 'available' }))).data, 'available');
  gate.released.resolve();
  await active;
  assert.equal(parse(await queued).data, 'queued');
  assert.equal(f.state.events.some((event) => event.args?.text === 'overflow'), false);
});

test('a timed-out browser action retires its session and never runs queued side effects', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { callTimeoutMs: 300 });
  const [a, b] = await Promise.all([f.client(), f.client()]);
  const [sa, sb] = await Promise.all([open(a, 'timed-out-agent'), open(b, 'healthy-agent')]);
  const gate = f.state.gate('timeout');
  const active = call(a, sa, 'hold', { gate: 'timeout' });
  await within(gate.started.promise);
  const queued = call(a, sa, 'write', { value: 'must-not-run' });
  await until(() => f.app.manager.getInfo(sa).queued === 1);
  const timeout = await active;
  assert.equal(timeout.isError, true);
  assert.equal(parse(timeout).error.code, 'CALL_TIMEOUT');
  assert.equal((await queued).isError, true);
  assert.equal(f.state.workers.find((worker) => worker.sessionId === sa).closed, true);
  assert.equal(f.state.events.some((event) => event.name === 'write' && event.sessionId === sa), false);
  assert.equal((await call(a, sa, 'read')).isError, true);
  assert.equal(parse(await call(b, sb, 'echo', { text: 'still-healthy' })).data, 'still-healthy');
});

test('closing a busy session cancels its active action and discards its queue', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const sessionId = await open(client, 'closing-agent');
  const gate = f.state.gate('close');
  const active = call(client, sessionId, 'hold', { gate: 'close' });
  await within(gate.started.promise);
  const queued = call(client, sessionId, 'write', { value: 'must-not-run' });
  await until(() => f.app.manager.getInfo(sessionId).queued === 1);
  const close = await within(client.callTool({ name: 'chrome_session', arguments: { action: 'close', sessionId } }));
  assert.notEqual(close.isError, true);
  assert.equal((await active).isError, true);
  assert.equal((await queued).isError, true);
  assert.equal(f.state.events.some((event) => event.name === 'write'), false);
});

test('late results from a closed worker cannot recreate cached session data', { timeout: 10000 }, async (t) => {
  const started = deferred();
  const finish = deferred();
  const returned = deferred();
  const upstreamFactory = async () => ({
    async listTools() { return [{ name: 'late_result', inputSchema: { type: 'object', properties: {} } }]; },
    async callTool() {
      started.resolve();
      await finish.promise; // Deliberately ignore cancellation, as a hung dependency might.
      returned.resolve();
      return { content: [{ type: 'text', text: 'must-not-reappear-after-close' }] };
    },
    async close() {},
  });
  const f = await fixture(t, { upstreamFactory });
  const client = await f.client();
  const sessionId = await open(client, 'late-worker');
  const active = call(client, sessionId, 'late_result');
  await within(started.promise);
  await client.callTool({ name: 'chrome_session', arguments: { action: 'close', sessionId } });
  assert.equal((await active).isError, true);
  finish.resolve();
  await returned.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.app.results.stats().entries, 0);
  assert.equal(f.app.results.stats().bytes, 0);
});

test('HTTP rejects foreign Origin and Host headers plus unsupported transport methods', async (t) => {
  const f = await fixture(t);
  const origin = await fetch(f.http.url, { method: 'POST', headers: { ...auth, Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(origin.status, 403);
  // Node's fetch may normalize/ignore Host; node:http preserves it for this test.
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(f.http.url, {
      method: 'POST', headers: { ...auth, Host: 'untrusted.invalid', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(hostStatus, 403);
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await fetch(f.http.url, { method, headers: auth });
    assert.equal(response.status, 405, method);
  }
  const missing = await fetch(new URL('/missing', f.http.url), { headers: auth });
  assert.equal(missing.status, 404);
});

test('bearer authentication is enforced for every HTTP client', async (t) => {
  const f = await fixture(t);
  const status = async (authorization) => (await fetch(f.http.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: '{}',
  })).status;
  for (const authorization of [undefined, 'Bearer incorrect', testToken, `Basic ${testToken}`, `Bearer ${testToken}x`, `Bearer ${testToken.slice(1)}`]) {
    assert.equal(await status(authorization), 401, authorization);
  }
  // The scheme is case-insensitive (RFC 7235); the token is not.
  for (const scheme of ['bearer', 'BEARER']) assert.notEqual(await status(`${scheme} ${testToken}`), 401, scheme);
  assert.equal(await status(`Bearer ${testToken.toUpperCase()}`), 401);
  const client = await f.client(testToken);
  assert.equal((await client.listTools()).tools.length, 4);
});

test('HTTP refuses to start without a token unless noAuth is explicit', async (t) => {
  const app = createApp({ upstreamFactory: createMockUpstreamFactory() });
  t.after(() => app.close());
  for (const options of [{}, { token: '' }, { token: testToken, noAuth: true }, { noAuth: 'yes' }]) {
    await assert.rejects(startHttp(app, { port: 0, ...options }), JSON.stringify(options));
  }
  // Too short, or a token Node's header parsing could never match (surrounding whitespace, non-ASCII).
  for (const token of ['0123456789abcde', ` ${testToken}`, `${testToken}\t`, `${testToken} x`, `${testToken}é`]) {
    await assert.rejects(startHttp(app, { port: 0, token }), /The bearer token must be/, JSON.stringify(token));
  }
  const f = await fixture(t, {}, { token: undefined, noAuth: true });
  const unauthenticated = await f.client();
  assert.equal((await unauthenticated.listTools()).tools.length, 4);
});

test('aborting an HTTP connection retires the affected worker', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const sessionId = await open(client, 'disconnected-agent');
  const gate = f.state.gate('disconnect');
  const active = call(client, sessionId, 'hold', { gate: 'disconnect' });
  const rejected = assert.rejects(active);
  await within(gate.started.promise);
  await client.close();
  await rejected;
  await until(() => f.state.workers.find((worker) => worker.sessionId === sessionId).closed);
  const observer = await f.client();
  assert.equal((await call(observer, sessionId, 'read')).isError, true);
});

test('real stdio workers launch separately and closing one preserves the other', { timeout: 15000 }, async (t) => {
  const upstreamFactory = createUpstreamFactory({
    command: process.execPath,
    args: [fileURLToPath(new URL('./mock-upstream.js', import.meta.url))],
  });
  const f = await fixture(t, { upstreamFactory });
  const [a, b] = await Promise.all([f.client(), f.client()]);
  const [sa, sb] = await Promise.all([open(a, 'process-a'), open(b, 'process-b')]);
  const [ra, rb] = await Promise.all([call(a, sa, 'process_id'), call(b, sb, 'process_id')]);
  const pa = Number(parse(ra).data);
  const pb = Number(parse(rb).data);
  assert.ok(Number.isInteger(pa) && Number.isInteger(pb));
  assert.notEqual(pa, pb);
  assert.notEqual(pa, process.pid);
  await Promise.all([call(a, sa, 'write', { value: 'worker-a' }), call(b, sb, 'write', { value: 'worker-b' })]);
  assert.equal(parse(await call(a, sa, 'read')).data, 'worker-a');
  assert.equal(parse(await call(b, sb, 'read')).data, 'worker-b');
  await a.callTool({ name: 'chrome_session', arguments: { action: 'close', sessionId: sa } });
  function isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  await until(() => !isAlive(pa));
  assert.equal(isAlive(pb), true);
  assert.equal(parse(await call(b, sb, 'echo', { text: 'survivor' })).data, 'survivor');
});

test('the actual stdio CLI initializes and advertises tools without stdout noise or Chrome startup', { timeout: 10000 }, async (t) => {
  const client = new Client({ name: 'stdio-cli-test', version: '1.0.0' });
  const protocolErrors = [];
  client.onerror = (error) => { protocolErrors.push(error); };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--transport', 'stdio'],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.listTools();
  assert.deepEqual(result.tools.map((item) => item.name).sort(), ['chrome_call', 'chrome_read', 'chrome_session', 'chrome_tools']);
  assert.deepEqual(protocolErrors, [], 'stdout contains valid MCP messages only');
});

test('workers block file: navigation unless allowFileUrls is set', () => {
  assert.equal(workerFlags().includes('--no-file-navigations'), true);
  assert.equal(workerFlags({ allowFileUrls: true }).includes('--no-file-navigations'), false);
});

test('workers run without page-ID routing unless --page-id-routing after -- restores it (upstream takes the last flag)', () => {
  assert.equal(workerFlags().includes('--no-page-id-routing'), true);
  const restored = workerFlags({ upstreamArgs: ['--page-id-routing'] });
  assert.ok(restored.lastIndexOf('--page-id-routing') > restored.indexOf('--no-page-id-routing'));
});

test('flags after -- reach every worker verbatim, after the broker flags', () => {
  const upstreamArgs = [
    '--viewport=1280x720', `--workspace=${testDir}`, '--slim', '--no-category-performance', '--proxy-server=http://127.0.0.1:8080',
    '--chrome-arg=--lang=de', '--blocked-url-pattern=*://ads.example/*', '--no-javascript-evaluation', '--redact-network-headers',
    '--channel=beta', '--screenshot-max-width=800', '--isolated-extra-is-unknown', '--screenshot-quality=-1',
  ];
  const flags = workerFlags({ chromePath: process.execPath, upstreamArgs });
  assert.deepEqual(flags.slice(-upstreamArgs.length), upstreamArgs);
  assert.deepEqual(flags.slice(0, -upstreamArgs.length), workerFlags({ chromePath: process.execPath }));
  assert.throws(() => workerFlags({ upstreamArgs: '--slim' }), TypeError);
});

test('a --chrome-path that is not an executable file is rejected, naming the binary inside a macOS app bundle', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'broker-chrome-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = join(dir, 'Google Chrome.app');
  const binary = join(bundle, 'Contents', 'MacOS', 'Google Chrome');
  await mkdir(dirname(binary), { recursive: true });
  const plain = join(dir, 'chrome.txt');
  await writeFile(plain, '', { mode: 0o644 });
  const message = (chromePath) => { try { workerFlags({ chromePath }); } catch (error) { return error.message; } return ''; };
  for (const app of [bundle, `${bundle}/`]) {
    assert.equal(message(app), `--chrome-path ${JSON.stringify(app)} is not an executable file; pass the executable inside the app bundle, e.g. ${JSON.stringify(binary)}.`);
  }
  assert.equal(message(dir), `--chrome-path ${JSON.stringify(dir)} is not an executable file.`);
  assert.equal(message(join(dir, 'missing')), `--chrome-path ${JSON.stringify(join(dir, 'missing'))} must name an executable file (ENOENT).`);
  assert.equal(message(plain), `--chrome-path ${JSON.stringify(plain)} must name an executable file (EACCES).`);
  assert.equal(message(''), '--chrome-path "" must name an executable file (ENOENT).', 'an empty path is not silently ignored');
  assert.ok(workerFlags({ chromePath: process.execPath }).includes(`--executable-path=${process.execPath}`));
  assert.equal(workerFlags().some((flag) => flag.startsWith('--executable-path')), false, 'without it, upstream finds Chrome');
});

test('passthrough rejects isolation-breaking and broker-owned upstream flags in every yargs long form', () => {
  const denied = {
    '--browserUrl': ['--browserUrl=http://127.0.0.1:9222', '--browser-url', '--no-browser-url', '--browser-url\t=http://x', '--\u00a0browser-url=http://x'],
    '--wsEndpoint': ['--wsEndpoint=ws://x', '--ws-endpoint'],
    '--wsHeaders': ['--wsHeaders={}', '--ws-headers'],
    '--autoConnect': ['--autoConnect', '--auto-connect', '--auto-connect=true', '--no-auto-connect', '---auto-connect', '--AUTO-CONNECT'],
    '--userDataDir': ['--userDataDir', '--user-data-dir=/p', '--USER-DATA-DIR=/p', '--user_data-dir=/p', '--userDataDir.x=1'],
    '--config': ['--config=c.json', '--config'],
    '--watchConfig': ['--watchConfig', '--watch-config', '--no-watch-config'],
    '--isolated': ['--isolated', '--no-isolated', '--isolated=false', '---isolated'],
    '--headless': ['--headless', '--no-headless', '--headless=false'],
    '--executablePath': ['--executablePath=/c', '--executable-path'],
    '--usageStatistics': ['--usage-statistics', '--usageStatistics=true'],
    '--performanceCrux': ['--performance-crux', '--performanceCrux'],
    '--fileNavigations': ['--file-navigations', '--no-file-navigations', '--fileNavigations=true'],
    '--viaCli': ['--viaCli', '--via-cli', '--via-cli=true'],
    '--allowUnrestrictedPaths': ['--allow-unrestricted-paths', '--allowUnrestrictedPaths=true'],
  };
  for (const [canonical, forms] of Object.entries(denied)) {
    for (const form of forms) {
      assert.throws(() => workerFlags({ upstreamArgs: ['--slim', form] }), (error) => {
        assert.match(error.message, /^Upstream flag \S+/u, form);
        assert.ok(error.message.includes(canonical), `${form}: ${error.message}`);
        return true;
      });
    }
  }
  const message = (...forms) => { try { workerFlags({ upstreamArgs: forms }); } catch (error) { return error.message; } return ''; };
  assert.match(message('--auto-connect'), /non-goal.*cannot be isolated per session|cannot be isolated per session.*non-goal/su);
  assert.match(message('--auto-connect'), /`chrome-devtools-mcp --autoConnect`/u);
  assert.match(message('--headless'), /broker's --headed/u);
  assert.match(message('--executable-path=/opt/chrome'), /broker's --chrome-path/u);
  assert.match(message('--no-file-navigations'), /broker's --allow-file-urls/u);
  assert.doesNotMatch(message('--ws-headers={"Authorization":"Bearer leaked-secret"}'), /leaked-secret/u, 'flag values are never echoed');
  assert.match(message('--via-cli'), /lets file tools use any path/u);
  for (const allowed of ['--chrome-arg=--lang=de', '--screenshot-quality=-1', '--page-id-routing', '--no-category-network']) {
    assert.doesNotThrow(() => workerFlags({ upstreamArgs: [allowed] }), allowed);
  }
});

test('passthrough accepts only --name and --name=value tokens, so no value can attach to another flag', () => {
  // yargs gives a separate value to the flag before it (all following ones for an array flag such as --chrome-arg),
  // ignores everything after "--", and reads "-=u=URL" as -u (--browserUrl). Upstream's short flags are all denied.
  const tokens = [
    'value', '/tmp', 'http://u.example', ' --remote-debugging-port=9563', '\t--remote-debugging-port=9557', '-5', '-1.5', '-.5',
    '--', '---', '--=x', '---=x', '-', '-u', '-u=http://x', '-xu', '-=u=http://127.0.0.1:9222', '-w=ws://x', '-e/c', '-xe', '',
  ];
  for (const token of tokens) {
    for (const upstreamArgs of [[token], ['--chrome-arg=--lang=de', token], ['--slim', token]]) {
      const index = upstreamArgs.length;
      assert.throws(() => workerFlags({ upstreamArgs }), (error) => {
        assert.equal(error.message, `Argument ${index} after "--" is not an upstream flag: pass each as --name or --name=value, attaching values with "=", e.g. --viewport=1280x720 or --chrome-arg=--lang=de.`, JSON.stringify(upstreamArgs));
        return true;
      });
    }
  }
  // A separated value is rejected rather than passed on, including the separated form the docs once showed.
  assert.throws(() => workerFlags({ upstreamArgs: ['--workspace', testDir] }), { message: /^Argument 2 after "--" is not an upstream flag/u });
  assert.throws(() => workerFlags({ upstreamArgs: ['--viewport', '800x600'] }), { message: /^Argument 2 after "--" is not an upstream flag/u });
});

test('passthrough rejects Chrome arguments that share a profile, open a DevTools endpoint or end switch parsing, as Chrome reads them', () => {
  const message = (...forms) => { try { workerFlags({ upstreamArgs: ['--slim', ...forms] }); } catch (error) { return error.message; } return ''; };
  // Chrome trims each argument (ASCII whitespace on POSIX, Unicode whitespace on Windows), takes "--", "-" or (Windows) "/"
  // prefixes, ignores case on Windows, and yargs first strips one pair of quotes. Puppeteer matches --user-data-dir* by prefix.
  const whitespace = [' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u0085', '\u2028', '\u3000', ' \t\n'];
  const switches = {
    'user-data-dir': ['--user-data-dir=/p', '--user-data-dirX=/p', '--user-data-dir', '-user-data-dir=/p', '/user-data-dir=C:\\p', '--USER-DATA-DIR=/p'],
    'remote-debugging': ['--remote-debugging-port=9222', '--remote-debugging-address=0.0.0.0', '--remote-debugging-pipe', '/remote-debugging-port=9222',
      '/Remote-Debugging-Port=9222', '-remote-debugging-port=9222', '--REMOTE-DEBUGGING-PORT=9222', '--remote-debugging-targets=x'],
  };
  for (const [name, values] of Object.entries(switches)) {
    for (const value of values) {
      const variants = [value, `'${value}'`, `"${value}"`, ...whitespace.flatMap((space) => [`${space}${value}`, `${value}${space}`, `"${space}${value}"`])];
      for (const variant of variants) {
        for (const flag of ['--chrome-arg', '--chromeArg', '--chrome_arg', '--CHROME-ARG', '--chrome-arg.0', '--chrome-arg\t']) {
          const text = message(`${flag}=${variant}`);
          assert.match(text, new RegExp(`^Chrome argument --${name}\\S* \\(via --chrome[-.\\w\\t]*\\) cannot be passed through`, 'iu'), JSON.stringify(`${flag}=${variant}`));
          assert.doesNotMatch(text, /9222|0\.0\.0\.0|\/p\b|C:|=x/u, 'switch values are never echoed');
        }
      }
    }
  }
  // The reviewer's repros: each opened an unauthenticated DevTools port or a profile outside the private temp dir.
  for (const forms of [['--chrome-arg= --remote-debugging-port=9556'], ['--chrome-arg=\'--remote-debugging-port=9570\''], ['--chrome-arg=--user-data-dirX=/x']]) {
    assert.match(message(...forms), /^Chrome argument --(?:remote-debugging-port|user-data-dirx) \(via --chrome-arg\) cannot be passed through/u, JSON.stringify(forms));
  }
  assert.match(message('--chrome-arg=--remote-debugging-port=9222'), /without the broker's token/u);
  for (const terminator of ['--', ' -- ', '"--"', '\t--']) {
    assert.match(message(`--chrome-arg=${terminator}`), /^Chrome argument -- \(via --chrome-arg\) cannot be passed through: it ends Chrome's switch parsing/u, JSON.stringify(terminator));
  }
  for (const forms of [['--chrome-arg', '--headless=new'], ['--chrome-arg', '--lang=de'], ['--chrome-arg'], ['--chromeArg']]) {
    assert.match(message(...forms), /^Upstream flag --chrome-?arg needs its Chrome argument after "=", e\.g\. --chrome-?arg=--lang=de\.$/iu, JSON.stringify(forms));
  }
  for (const allowed of [['--chrome-arg=--headless=new'], ['--chrome-arg=--lang=de', '--chrome-arg=--user-agent=x'], ['--chrome-arg=--disable-gpu'], ['--chrome-arg=\'--lang=de\'']]) {
    assert.doesNotThrow(() => workerFlags({ upstreamArgs: allowed }), JSON.stringify(allowed));
  }
});

test('--ignore-default-chrome-arg cannot drop the private profile or the DevTools pipe: puppeteer appends both after it', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'broker-fake-chrome-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const argvFile = join(dir, 'argv.txt');
  const fakeChrome = join(dir, 'chrome'); // records the arguments it was launched with, then fails to start
  await writeFile(fakeChrome, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nexit 1\n`, { mode: 0o755 });
  const ignored = ['--user-data-dir', '--remote-debugging-pipe', '--headless=new'].map((arg) => `--ignore-default-chrome-arg=${arg}`);
  const worker = await createUpstreamFactory({ chromePath: fakeChrome, upstreamArgs: ignored })();
  t.after(() => worker.close());
  await worker.callTool('list_pages', {}, { timeoutMs: 10000 }).catch(() => {});
  const argv = (await readFile(argvFile, 'utf8')).split('\n');
  assert.ok(argv.includes('--remote-debugging-pipe'), argv.join(' '));
  assert.equal(argv.filter((arg) => arg.startsWith('--user-data-dir')).length, 1, argv.join(' '));
  assert.ok(argv.find((arg) => arg.startsWith('--user-data-dir=')).startsWith(`--user-data-dir=${join(tmpdir(), 'chrome-devtools-mcp-broker-')}`), 'inside the worker\'s private temp dir');
});

test('passthrough rejects a --workspace that is the OS temp dir or contains it, in every spelling', async (t) => {
  const tmp = realpathSync(tmpdir());
  const inside = await mkdtemp(join(tmpdir(), 'broker-workspace-'));
  t.after(() => rm(inside, { recursive: true, force: true }));
  const link = join(inside, 'tmp-parent'); // upstream compares real paths
  await symlink(dirname(tmp), link);
  const message = (...forms) => { try { workerFlags({ upstreamArgs: forms }); } catch (error) { return error.message; } return ''; };
  for (const dir of ['/', tmpdir(), tmp, dirname(tmp), `${tmp}${sep}`, `${tmp}${sep}..`, link, `"${tmp}"`, relative(process.cwd(), dirname(tmp)) || '.']) {
    for (const flag of ['--workspace', '--filesystemRoot', '--filesystem-root', '--WORKSPACE', '--workspace.0', '--filesystem_root']) {
      assert.equal(message('--slim', `${flag}=${dir}`),
        `Upstream flag ${flag} cannot be passed through: its directory contains the OS temp directory, which holds every session's private temp directory and profile; choose a directory outside it.`,
        `${flag}=${dir}`);
    }
  }
  assert.equal(message(`--workspace=${join(testDir, 'missing-workspace')}`), 'Upstream flag --workspace must name an existing directory (ENOENT).');
  for (const dir of [testDir, inside, `'${testDir}'`]) {
    assert.doesNotThrow(() => workerFlags({ upstreamArgs: [`--workspace=${dir}`, `--filesystem-root=${dir}`] }), dir);
  }
  assert.doesNotThrow(() => workerFlags({ upstreamArgs: ['--workspace'] }), 'without a value upstream keeps its default, the private temp dir');
});

test('worker processes do not inherit the broker token', { timeout: 10000 }, async (t) => {
  const previous = { CHROME_BROKER_TOKEN: process.env.CHROME_BROKER_TOKEN, chrome_broker_token: process.env.chrome_broker_token };
  process.env.CHROME_BROKER_TOKEN = testToken;
  process.env.chrome_broker_token = testToken;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const worker = await createUpstreamFactory({
    command: process.execPath,
    args: [fileURLToPath(new URL('./mock-upstream.js', import.meta.url))],
  })();
  t.after(() => worker.close());
  const result = await worker.callTool('env', { names: ['CHROME_BROKER_TOKEN', 'chrome_broker_token', 'CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS', 'PATH'] });
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.CHROME_BROKER_TOKEN, null);
  assert.equal(env.chrome_broker_token, null, 'the filter ignores case');
  assert.equal(env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, '1');
  assert.equal(env.PATH, process.env.PATH, 'unrelated environment is still inherited');
});

test('each worker gets a private temp dir, removed when it closes or fails to start', { timeout: 15000 }, async () => {
  const mock = fileURLToPath(new URL('./mock-upstream.js', import.meta.url));
  const factory = createUpstreamFactory({ command: process.execPath, args: [mock] });
  const tempDirs = async (worker) => JSON.parse((await worker.callTool('env', { names: ['TMPDIR', 'TMP', 'TEMP'] })).content[0].text);
  const [a, b] = await Promise.all([factory(), factory()]);
  const [dirA, dirB] = await Promise.all([a, b].map(async (worker) => {
    const { TMPDIR, TMP, TEMP } = await tempDirs(worker);
    assert.deepEqual([TMP, TEMP], [TMPDIR, TMPDIR], 'one dir for every platform convention');
    assert.equal(dirname(TMPDIR), tmpdir());
    const info = await stat(TMPDIR);
    assert.ok(info.isDirectory());
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o700);
    return TMPDIR;
  }));
  assert.notEqual(dirA, dirB);
  await a.close();
  await assert.rejects(stat(dirA), { code: 'ENOENT' });
  assert.ok((await stat(dirB)).isDirectory(), 'closing one worker leaves the other alone');
  await b.close();
  await assert.rejects(stat(dirB), { code: 'ENOENT' });
  // A worker that never starts leaves no dir behind either; its dir name is only known from the listing.
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('chrome-devtools-mcp-broker-')));
  const failed = await createUpstreamFactory({ command: process.execPath, args: ['-e', 'process.exit(1)'] })().catch((error) => error);
  assert.equal(failed.code, 'UPSTREAM_START_FAILED');
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith('chrome-devtools-mcp-broker-') && !before.has(name));
  assert.deepEqual(after, []);
});

test('a failed worker start keeps startup stderr for the operator log, out of the caller message', async () => {
  const factory = createUpstreamFactory({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("Invalid viewport. Expected format is 1280x720.\\n"); process.exit(1)'],
  });
  const error = await factory().catch((failure) => failure);
  assert.equal(error.code, 'UPSTREAM_START_FAILED');
  assert.equal(error.stderr, 'Invalid viewport. Expected format is 1280x720.');
  assert.doesNotMatch(error.message, /Invalid viewport/);
  assert.match(error.message, /: MCP error -32000: Connection closed\. Run the broker with --verbose to log the worker's startup error\.$/);
  // With a lifecycle log (--verbose), the message points there instead.
  const logged = await createUpstreamFactory({ command: process.execPath, args: ['-e', 'process.stderr.write("x"); process.exit(1)'], log: () => {} })()
    .catch((failure) => failure);
  assert.match(logged.message, /Connection closed\. The worker's startup error is in the broker log\.$/);
});

test('a worker that warns about an unknown flag fails to start, with the warning kept for the operator', { timeout: 10000 }, async () => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('chrome-devtools-mcp-broker-')));
  const mock = fileURLToPath(new URL('./mock-upstream.js', import.meta.url));
  const error = await createUpstreamFactory({ command: process.execPath, args: [mock, '--view-port=800x600'] })().catch((failure) => failure);
  assert.equal(error.code, 'UPSTREAM_START_FAILED');
  assert.equal(error.stderr, 'Unknown arguments: --view-port=800x600');
  assert.match(error.message, /does not recognize a flag passed after "--"\. Run the broker with --verbose/);
  assert.doesNotMatch(error.message, /view-port/);
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith('chrome-devtools-mcp-broker-') && !before.has(name));
  assert.deepEqual(after, [], 'the failed worker is closed and its temp dir removed');
});

/** Start the real CLI over HTTP on an ephemeral port; returns its URL once listening, or its exit code. */
async function runCli(t, args, token) {
  const env = { ...process.env };
  delete env.CHROME_BROKER_TOKEN;
  if (token !== undefined) env.CHROME_BROKER_TOKEN = token;
  const child = spawn(process.execPath, [cliPath, '--port', '0', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  const listening = new Promise((resolve) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/listening at (\S+)/);
      if (match) resolve({ url: match[1] });
    });
  });
  const outcome = await within(Promise.race([listening, closed.then(([code]) => ({ code }))]), 5000);
  return { ...outcome, stderr };
}

const help = (await promisify(execFile)(process.execPath, [cliPath, '--help'])).stdout;
// --help's token recipe: its indented lines after the "HTTP requires a bearer token" line.
const tokenRecipe = help.match(/^HTTP requires a bearer token unless --no-auth is given:\n((?: {2}\S.*\n)+)/mu)[1];

test('--help and the token errors give README\'s recipe: create the token once in a private file and read it from there', async () => {
  assert.match(tokenRecipe, /^ {2}\(umask 077; openssl rand -hex 32 > ~\/\.chrome-broker-token\) .*# once.*\n {2}CHROME_BROKER_TOKEN=\$\(cat ~\/\.chrome-broker-token\) /u);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const line of tokenRecipe.trimEnd().split('\n')) assert.ok(readme.includes(`\n${line.trim()}\n`), `README has the line: ${line.trim()}`);
});

test('--help shows the defaults the code uses', async (t) => {
  const manager = new SessionManager({ upstreamFactory: async () => ({}) });
  t.after(() => manager.close());
  for (const [option, value] of [['--port', defaultPort], ['--max-sessions', manager.maxSessions], ['--max-queue', manager.maxQueue],
    ['--idle-ttl-ms', manager.idleTtlMs], ['--call-timeout-ms', manager.callTimeoutMs]]) {
    assert.match(help, new RegExp(`^ {2}${option} N .*\\(default ${value}\\)`, 'mu'), option);
  }
});

test('the HTTP CLI refuses to start without CHROME_BROKER_TOKEN', { timeout: 15000 }, async (t) => {
  for (const token of [undefined, '']) {
    const { code, url, stderr } = await runCli(t, [], token);
    assert.equal(url, undefined, 'must not listen');
    assert.equal(code, 1);
    assert.match(stderr, /requires CHROME_BROKER_TOKEN/);
    assert.ok(stderr.includes(`e.g.\n${tokenRecipe}and send it`), stderr);
    assert.match(stderr, /--no-auth/);
  }
  const conflict = await runCli(t, ['--no-auth'], testToken);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /--no-auth conflicts with CHROME_BROKER_TOKEN/);
  for (const [token, problem] of [['short-token', /must be at least 16 characters/], [`${testToken} `, /must be visible ASCII characters, without spaces/]]) {
    const weak = await runCli(t, [], token);
    assert.equal(weak.url, undefined, 'must not listen');
    assert.equal(weak.code, 1);
    assert.match(weak.stderr, new RegExp(`^CHROME_BROKER_TOKEN ${problem.source}\\. Generate one, e\\.g\\.\\n`));
    assert.ok(weak.stderr.endsWith(`e.g.\n${tokenRecipe}`), weak.stderr);
  }
});

test('the HTTP CLI says in one line that its port is in use, and a wrong --chrome-path stops startup', { timeout: 15000 }, async (t) => {
  const busy = createNetServer();
  await new Promise((resolve) => { busy.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { busy.close(resolve); }));
  const { port } = busy.address();
  const taken = await runCli(t, ['--no-auth', '--port', String(port)]); // the last --port wins over runCli's --port 0
  assert.equal(taken.url, undefined, 'must not listen');
  assert.equal(taken.code, 1);
  assert.ok(taken.stderr.endsWith(`\nPort ${port} on 127.0.0.1 is in use; pick another --port or stop the other process.\n`), taken.stderr);
  const missing = join(testDir, 'missing-chrome');
  const chrome = await runCli(t, ['--no-auth', '--chrome-path', missing]);
  assert.equal(chrome.url, undefined, 'must not listen');
  assert.equal(chrome.code, 1);
  assert.equal(chrome.stderr, `--chrome-path ${JSON.stringify(missing)} must name an executable file (ENOENT).\n`);
});

test('the CLI accepts only plain decimal integers for numeric flags', { timeout: 15000 }, async (t) => {
  for (const [flag, value] of [['--port', ''], ['--port', '0x10'], ['--port', '1e3'], ['--max-sessions', '+2'], ['--idle-ttl-ms', '1.5'], ['--call-timeout-ms', ' 60']]) {
    const { code, url, stderr } = await runCli(t, ['--no-auth', flag, value]);
    assert.equal(url, undefined, `${flag} ${JSON.stringify(value)} must not listen`);
    assert.equal(code, 1);
    assert.equal(stderr, `${flag} must be a decimal integer.\n`);
  }
  const ranged = await runCli(t, ['--no-auth', '--max-sessions', '0']);
  assert.equal(ranged.code, 1);
  assert.match(ranged.stderr, /maxSessions must be a positive integer/);
});

test('the HTTP CLI enforces CHROME_BROKER_TOKEN from its environment', { timeout: 10000 }, async (t) => {
  const { url } = await runCli(t, [], testToken);
  const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
  const client = new Client({ name: 'cli-token-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth } }));
  assert.equal((await client.listTools()).tools.length, 4);
});

test('the HTTP CLI with --no-auth warns and serves unauthenticated clients', { timeout: 10000 }, async (t) => {
  const { url, stderr } = await runCli(t, ['--no-auth']);
  assert.match(stderr, /^WARNING: --no-auth: .*\n/);
  const client = new Client({ name: 'cli-no-auth-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  assert.equal((await client.listTools()).tools.length, 4);
});

test('the CLI passes flags after -- to workers and rejects isolation-breaking ones at startup', { timeout: 15000 }, async (t) => {
  const attach = await runCli(t, ['--no-auth', '--', '--viewport=800x600', '--browser-url=http://127.0.0.1:9222']);
  assert.equal(attach.code, 1);
  assert.equal(attach.url, undefined, 'must not listen');
  assert.match(attach.stderr, /Upstream flag --browser-url \(--browserUrl\) cannot be passed through/);
  assert.match(attach.stderr, /non-goal/);
  const stray = await runCli(t, ['--no-auth', '--viewport=800x600']);
  assert.equal(stray.code, 1);
  const positional = await runCli(t, ['--no-auth', 'stray']);
  assert.equal(positional.code, 1);
  assert.match(positional.stderr, /Unexpected argument "stray"\. Pass chrome-devtools-mcp flags after "--"\./);
  // A bare token joined the broker's own --chrome-arg=--no-sandbox; now every token after "--" must be a flag.
  const bare = await runCli(t, ['--no-auth', '--no-sandbox', '--', ' --remote-debugging-port=9563']);
  assert.equal(bare.code, 1);
  assert.equal(bare.url, undefined, 'must not listen');
  assert.match(bare.stderr, /^Argument 1 after "--" is not an upstream flag: .*attaching values with "="/u);
  const widened = await runCli(t, ['--no-auth', '--', '--workspace=/']);
  assert.equal(widened.code, 1);
  assert.match(widened.stderr, /^Upstream flag --workspace cannot be passed through: its directory contains the OS temp directory/u);
  const accepted = await runCli(t, ['--no-auth', '--', '--viewport=800x600', `--workspace=${testDir}`]);
  assert.match(accepted.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
});

test('the CLI checks upstream flags with one worker before serving, so a bad value or an unknown flag stops startup', { timeout: 30000 }, async (t) => {
  const unknown = await runCli(t, ['--no-auth', '--', '--view-port=800x600']);
  assert.equal(unknown.url, undefined, 'must not listen');
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr, 'chrome-devtools-mcp startup check failed: Unknown arguments: --viewPort\n');
  const badValue = await runCli(t, ['--no-auth', '--', '--viewport=abc']);
  assert.equal(badValue.url, undefined, 'must not listen');
  assert.equal(badValue.code, 1);
  assert.match(badValue.stderr, /^chrome-devtools-mcp startup check failed: Invalid viewport\./);
  // parseArgs suggests moving an unknown broker flag after "--", which hands the typo to upstream; that fails too.
  const typo = await runCli(t, ['--no-auth', '--max-session', '2']);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /after '--'/);
  const moved = await runCli(t, ['--no-auth', '--', '--max-session=2']);
  assert.equal(moved.code, 1);
  assert.equal(moved.stderr, 'chrome-devtools-mcp startup check failed: Unknown arguments: --maxSession\n');
  // stdio checks before connecting: nothing reaches stdout.
  const child = spawn(process.execPath, [cliPath, '--transport', 'stdio', '--', '--bogus'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await within(once(child, 'close'), 10000);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'chrome-devtools-mcp startup check failed: Unknown arguments: --bogus\n');
});

/** Spawn the HTTP CLI with a private TMPDIR; resolves `seen(pattern)` when stderr matches. */
async function spawnCli(t, args, execArgv = []) {
  const tmp = await mkdtemp(join(tmpdir(), 'broker-cli-tmp-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.CHROME_BROKER_TOKEN;
  const child = spawn(process.execPath, [...execArgv, cliPath, '--port', '0', '--no-auth', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  let stderr = '';
  const waiters = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    for (const waiter of waiters) if (waiter.pattern.test(stderr)) waiter.resolve(stderr);
  });
  const seen = (pattern) => within(new Promise((resolve) => {
    if (pattern.test(stderr)) resolve(stderr);
    else waiters.push({ pattern, resolve });
  }), 10000);
  const sessionDirs = async () => (await readdir(tmp)).filter((name) => name.startsWith('chrome-devtools-mcp-broker-'));
  return { child, closed, seen, sessionDirs, stderr: () => stderr };
}

test('a second SIGINT during shutdown (npm forwards Ctrl+C once more) does not interrupt session cleanup', { timeout: 20000 }, async (t) => {
  const cli = await spawnCli(t, ['--verbose']);
  const url = (await cli.seen(/listening at (\S+)/)).match(/listening at (\S+)/)[1];
  const client = new Client({ name: 'double-sigint', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  await open(client, 'interrupted');
  assert.equal((await cli.sessionDirs()).length, 1, 'the session has its private temp dir');
  cli.child.kill('SIGINT');
  await cli.seen(/session closed .*reason="shutdown"/); // shutdown has begun; its worker is still closing
  cli.child.kill('SIGINT');
  const [code, signal] = await within(cli.closed, 10000);
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, cli.stderr());
  assert.deepEqual(await cli.sessionDirs(), [], 'cleanup finished: no session temp dir is left behind');
});

test('a signal while the HTTP server starts listening stops the broker instead of serving a closed app', { timeout: 20000 }, async (t) => {
  // Hold the listen callback open so the signal deterministically lands between the startup check and startHttp resolving.
  const slowListen = `import net from 'node:net'; const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) { process.stderr.write('test: listen delayed\\n'); setTimeout(() => listen.apply(this, args), 500); return this; };`;
  const cli = await spawnCli(t, [], [`--import=data:text/javascript,${encodeURIComponent(slowListen)}`]);
  await cli.seen(/test: listen delayed/);
  cli.child.kill('SIGTERM');
  const [code, signal] = await within(cli.closed, 10000);
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, cli.stderr());
  assert.doesNotMatch(cli.stderr(), /listening at/);
});

test('--no-auth or --port with stdio is a startup error', { timeout: 10000 }, async (t) => {
  const { code, stderr } = await runCli(t, ['--transport', 'stdio', '--no-auth']);
  assert.equal(code, 1);
  assert.match(stderr, /--no-auth applies only to --transport http/);
  const port = await runCli(t, ['--transport', 'stdio']); // runCli always passes --port
  assert.equal(port.code, 1);
  assert.equal(port.stderr, '--port applies only to --transport http; stdio listens on no port.\n');
});

test('stdio --verbose logs lifecycle to stderr only, without tool arguments or session IDs', { timeout: 20000 }, async (t) => {
  const marker = 'verbose-private-argument-marker';
  const client = new Client({ name: 'stdio-verbose-test', version: '1.0.0' });
  const protocolErrors = [];
  client.onerror = (error) => { protocolErrors.push(error); };
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cliPath, '--transport', 'stdio', '--verbose'], stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  // A real upstream worker starts; neither call launches Chrome. The label's line separators and C1 controls are escaped.
  const sessionId = await open(client, 'verbose-agent\u2028\u2029\u0085\u009b');
  parse(await client.callTool({ name: 'chrome_tools', arguments: { sessionId, query: marker } }));
  assert.equal((await call(client, sessionId, `${marker}_tool`, { secret: marker })).isError, true);
  await client.callTool({ name: 'chrome_session', arguments: { action: 'close', sessionId } });
  await until(() => stderr.includes('session closed'), 5000);
  const id = sessionId.slice(0, 6);
  const label = String.raw`verbose-agent\u2028\u2029\u0085\u009b`;
  assert.ok(stderr.includes(`Z session opened id="${id}" label="${label}" sessions=1 maxSessions=4\n`), stderr);
  assert.match(stderr, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z session opened /m);
  assert.ok(stderr.includes(`Z session closed id="${id}" label="${label}" reason="client"\n`), stderr);
  assert.doesNotMatch(stderr, /[\u0080-\u009f\u2028\u2029]/u, 'no raw line separators or C1 controls');
  assert.doesNotMatch(stderr, new RegExp(marker));
  assert.equal(stderr.includes(sessionId), false, 'only a short session-ID prefix is logged');
  assert.deepEqual(protocolErrors, [], 'stdout contains valid MCP messages only');
});
