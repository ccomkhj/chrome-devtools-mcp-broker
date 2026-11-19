import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/app.js';
import { version } from '../src/version.js';

const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

test('the MCP server and --help report the package.json version', async (t) => {
  assert.equal(version, packageVersion);
  const app = createApp({ upstreamFactory: async () => { throw new Error('not used'); } });
  const client = new Client({ name: 'version-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), app.createServer().connect(b)]);
  assert.equal(client.getServerVersion().version, packageVersion);

  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--help']);
  assert.equal(stdout.split('\n')[0], `Chrome DevTools MCP Broker ${packageVersion}`);
});
