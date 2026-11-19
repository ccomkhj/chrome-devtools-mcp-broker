#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Start the broker first, with the token file from README's quick start: CHROME_BROKER_TOKEN=$(cat ~/.chrome-broker-token) npm start
// Then, in another shell: CHROME_BROKER_TOKEN=$(cat ~/.chrome-broker-token) npm run demo
const endpoint = new URL(process.argv[2] ?? process.env.CHROME_MCP_URL ?? 'http://127.0.0.1:7331/mcp');
const token = process.env.CHROME_BROKER_TOKEN;

async function runAgent(label) {
  const client = new Client({ name: label, version: '1.0.0' });
  let sessionId;
  async function tool(name, args) {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((block) => block.type === 'text')?.text;
    const parsed = text ? JSON.parse(text) : {};
    if (result.isError) throw new Error(`${label}: ${JSON.stringify(parsed)}`);
    return parsed;
  }
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    }));
    ({ sessionId } = await tool('chrome_session', { action: 'open', label }));

    // Only the schemas used by this agent enter its context.
    await tool('chrome_tools', { sessionId, name: 'new_page' });
    const evaluation = await tool('chrome_tools', { sessionId, name: 'evaluate_script' });
    const html = `<title>${label}</title><h1>${label} has its own Chrome profile</h1>`;
    const page = await tool('chrome_call', {
      sessionId,
      tool: 'new_page',
      args: { url: `data:text/html,${encodeURIComponent(html)}` },
      maxChars: 2000,
    });

    const args = {
      function: 'async () => { const started = Date.now(); await new Promise(resolve => setTimeout(resolve, 1500)); return { title: document.title, started, finished: Date.now() }; }',
    };
    if (evaluation.inputSchema?.properties?.pageId) {
      // Only if the broker runs with `-- --page-id-routing`; otherwise page tools act on the page new_page selected.
      const match = page.data.match(/^\s*(\d+):[^\n]*\[selected\]/m);
      if (!match) throw new Error(`${label}: no selected page ID returned; inspect chrome_read for result ${page.resultId}`);
      args.pageId = Number(match[1]);
    }
    const result = await tool('chrome_call', { sessionId, tool: 'evaluate_script', args, maxChars: 2000 });
    return { agent: label, output: result.data };
  } finally {
    if (sessionId) {
      try { await tool('chrome_session', { action: 'close', sessionId }); }
      catch { /* A failed or timed-out session may already be closed. */ }
    }
    await client.close();
  }
}

const started = performance.now();
const results = await Promise.allSettled([runAgent('Agent A'), runAgent('Agent B')]);
for (const result of results) {
  if (result.status === 'fulfilled') console.log(JSON.stringify(result.value, null, 2));
  else { console.error(result.reason.message); process.exitCode = 1; }
}
console.log(`Total: ${Math.round(performance.now() - started)} ms, including worker and browser startup.`);
