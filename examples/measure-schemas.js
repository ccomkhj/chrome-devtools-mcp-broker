import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/app.js';
import { createUpstreamFactory } from '../src/upstream.js';

// Tool discovery starts the upstream MCP process but does not launch Chrome. The upstream row uses upstream's
// default page-ID routing, which the broker turns off for its workers (that removes pageId from page tools).
const worker = await createUpstreamFactory({ upstreamArgs: ['--page-id-routing'] })({});
const app = createApp();
const server = app.createServer();
const client = new Client({ name: 'schema-measurement', version: '1.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([client.connect(a), server.connect(b)]);
  const upstream = await worker.listTools();
  const wrapped = (await client.listTools()).tools;
  const upstreamSchemaChars = JSON.stringify(upstream).length;
  const wrapperSchemaChars = JSON.stringify(wrapped).length;
  process.stdout.write(JSON.stringify({
    upstreamToolCount: upstream.length,
    wrapperToolCount: wrapped.length,
    upstreamSchemaChars,
    wrapperSchemaChars,
    reductionPercent: Math.round((1 - wrapperSchemaChars / upstreamSchemaChars) * 1000) / 10,
    metric: 'UTF-16 JSON characters; not billed model tokens or total workflow cost',
  }, null, 2) + '\n');
} finally {
  await client.close();
  await app.close();
  await worker.close();
}
