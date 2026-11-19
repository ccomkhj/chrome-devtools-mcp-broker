import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { startHttp } from '../src/http.js';

function decode(result) {
  const payload = JSON.parse(result.content.find(block => block.type === 'text').text);
  assert.notEqual(result.isError, true, JSON.stringify(payload));
  return payload;
}

function valueFromEvaluation(result) {
  const match = result.data.match(/```(?:json)?\s*([\s\S]*?)```/u);
  assert.ok(match, `Expected upstream evaluation JSON: ${result.data}`);
  return JSON.parse(match[1]);
}

const skip = process.env.CHROME_PATH ? false : 'Set CHROME_PATH to a local Chrome/Chromium executable.';
const chromeOptions = { chromePath: process.env.CHROME_PATH, noSandbox: process.env.CHROME_NO_SANDBOX === '1' };

/** Names of the broker's per-worker temp dirs in `dir`. */
async function workerTempDirs(dir = tmpdir()) {
  return (await readdir(dir)).filter(name => name.startsWith('chrome-devtools-mcp-broker-'));
}

async function eventually(check, message, ms = 10_000) {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('real Chrome: independent profiles, overlapping browser operations, and cached snapshots', {
  skip, timeout: 120_000,
}, async (t) => {
  let arrivals = 0;
  const waiting = [];
  let bothArrived;
  const rendezvous = new Promise(resolve => { bothArrived = resolve; });
  const fixture = createServer((req, res) => {
    if (req.url.startsWith('/barrier')) {
      waiting.push(res);
      if (++arrivals === 2) {
        bothArrived();
        for (const response of waiting) if (!response.writableEnded) response.end('both-active');
      }
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Multi-agent fixture</title><button>Run task</button>'
      + Array.from({ length: 160 }, (_, i) => `<p>Unique test row ${i}</p>`).join(''));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${fixture.address().port}/`;
  const app = createApp({ ...chromeOptions, maxSessions: 2 });
  const token = 'chrome-e2e-token-not-a-real-secret';
  const http = await startHttp(app, { port: 0, token });
  const clients = [];
  t.after(async () => {
    for (const response of waiting) if (!response.writableEnded) response.end('closed');
    await Promise.allSettled(clients.map(client => client.close()));
    await http.close();
    await app.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  });
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: `real-agent-${i}`, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    clients.push(client);
  }
  const sessions = await Promise.all(clients.map(async (client, i) => decode(await client.callTool({
    name: 'chrome_session', arguments: { action: 'open', label: `real-agent-${i}` },
  })).sessionId));
  const call = async (i, tool, args, output = {}) => decode(await clients[i].callTool({
    name: 'chrome_call', arguments: { sessionId: sessions[i], tool, args, ...output },
  }));
  // Workers run without page-ID routing, so page tools act on the page new_page selected.
  await Promise.all(clients.map((_, i) => call(i, 'new_page', { url: pageUrl })));
  await call(0, 'evaluate_script', {
    function: '() => { localStorage.setItem("agent", "alpha"); document.cookie="agent=alpha; path=/"; return true; }',
  });
  const b = valueFromEvaluation(await call(1, 'evaluate_script', {
    function: '() => ({stored:localStorage.getItem("agent"), cookies:document.cookie})', waitForStableDom: false,
  }));
  assert.equal(b.stored, null);
  assert.equal(b.cookies, '');

  const overlapping = Promise.all(clients.map((_, i) => call(i, 'evaluate_script', {
    function: 'async () => await (await fetch("/barrier")).text()',
    waitForStableDom: false,
  })));
  let timer;
  try {
    await Promise.race([rendezvous, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Both browser requests did not overlap.')), 15_000);
    })]);
  } finally {
    clearTimeout(timer);
    for (const response of waiting) if (!response.writableEnded) response.end('released');
    await overlapping;
  }
  assert.equal(arrivals, 2);

  const snapshot = await call(0, 'take_snapshot', {}, { maxChars: 700 });
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.resultId);
  const rest = decode(await clients[0].callTool({ name: 'chrome_read', arguments: {
    sessionId: sessions[0], resultId: snapshot.resultId, offset: snapshot.nextOffset, maxChars: 700,
  } }));
  assert.equal(rest.offset, snapshot.nextOffset);
  await clients[0].callTool({ name: 'chrome_session', arguments: { action: 'close', sessionId: sessions[0] } });
  const stillAlive = valueFromEvaluation(await call(1, 'evaluate_script', {
    function: '() => document.title', waitForStableDom: false,
  }));
  assert.equal(stillAlive, 'Multi-agent fixture');
});

test('real Chrome: a session cannot list the shared temp dir or read another session\'s profile', {
  skip, timeout: 120_000,
}, async (t) => {
  // The reviewer's attack: <input webkitdirectory> + upload_file on the OS temp dir listed every
  // session's puppeteer profile, and a file input then read another session's localStorage files.
  const fixture = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>upload</title><input type=file id=f><input type=file id=d webkitdirectory>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${fixture.address().port}/`;
  const before = new Set(await workerTempDirs());
  const newDirs = async () => (await workerTempDirs()).filter(name => !before.has(name)).map(name => join(tmpdir(), name));
  const app = createApp({ ...chromeOptions, maxSessions: 2 });
  const client = new Client({ name: 'isolation-agent', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await app.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), app.createServer().connect(b)]);
  const open = async label => decode(await client.callTool({ name: 'chrome_session', arguments: { action: 'open', label } })).sessionId;
  const call = (sessionId, tool, args) => client.callTool({ name: 'chrome_call', arguments: { sessionId, tool, args, maxChars: 32_000 } });
  /** The worker's private temp dir, its --isolated profile inside it, and one file that exists in that profile. */
  async function workerFiles(dir) {
    const profile = (await readdir(dir)).find(name => name.startsWith('puppeteer_dev_chrome_profile-'));
    assert.ok(profile, `the --isolated profile lives in the worker's private temp dir ${dir}`);
    const file = (await readdir(join(dir, profile), { recursive: true, withFileTypes: true })).find(entry => entry.isFile());
    return { dir, profile: join(dir, profile), file: join(file.parentPath, file.name) };
  }

  const victim = await open('victim');
  decode(await call(victim, 'new_page', { url: pageUrl }));
  decode(await call(victim, 'evaluate_script', { function: '() => { localStorage.setItem("token", "victim-secret"); return true; }' }));
  const [victimDir] = await newDirs();
  const victimFiles = await workerFiles(victimDir);

  const attacker = await open('attacker');
  decode(await call(attacker, 'new_page', { url: pageUrl }));
  const attackerFiles = await workerFiles((await newDirs()).find(dir => dir !== victimDir));
  const snapshot = decode(await call(attacker, 'take_snapshot', {})).data;
  const [fileInput, directoryInput] = [...snapshot.matchAll(/uid=(\S+) button/gu)].map(match => match[1]);
  assert.ok(fileInput && directoryInput, snapshot);
  const upload = (uid, path) => call(attacker, 'upload_file', { uid, filePaths: [path] });

  const own = await upload(fileInput, attackerFiles.file);
  assert.notEqual(own.isError, true, `a session may still use its own temp dir: ${own.content[0].text}`);
  for (const [uid, path] of [
    [directoryInput, tmpdir()], [directoryInput, victimFiles.dir], [directoryInput, victimFiles.profile], [fileInput, victimFiles.file],
  ]) {
    await stat(path); // it exists, so a denial is the path restriction
    const denied = await upload(uid, path);
    assert.equal(denied.isError, true, `${path} must be denied`);
    assert.match(denied.content[0].text, /Access denied/u);
  }
  await client.close();
  await app.close();
  await eventually(async () => (await newDirs()).length === 0, 'every worker temp dir is removed after shutdown');
});

test('real Chrome: file: URLs are blocked by default and opened only with allowFileUrls', {
  skip, timeout: 60_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'broker-file-url-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = 'file-url-private-marker';
  const fileUrl = pathToFileURL(join(dir, 'private.html')).href;
  await writeFile(join(dir, 'private.html'), `<title>${marker}</title><p>${marker}</p>`);

  async function openFile(allowFileUrls) {
    const app = createApp({ ...chromeOptions, allowFileUrls });
    const client = new Client({ name: 'file-url-agent', version: '1.0.0' });
    t.after(async () => { await client.close(); await app.close(); });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), app.createServer().connect(b)]);
    const { sessionId } = decode(await client.callTool({ name: 'chrome_session', arguments: { action: 'open', label: 'file-url' } }));
    const result = await client.callTool({ name: 'chrome_call', arguments: { sessionId, tool: 'new_page', args: { url: fileUrl } } });
    return { result, text: result.content.find(block => block.type === 'text').text };
  }

  const blocked = await openFile(false);
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.text, /file: URLs is not allowed/u);
  assert.doesNotMatch(blocked.text, new RegExp(marker, 'u'));

  const allowed = await openFile(true);
  assert.notEqual(allowed.result.isError, true, allowed.text);
  assert.match(allowed.text, new RegExp(marker, 'u'));
});

test('real Chrome: page tools act on the selected page without pageId; select_page switches it', {
  skip, timeout: 60_000,
}, async (t) => {
  const app = createApp(chromeOptions);
  const client = new Client({ name: 'selected-page-agent', version: '1.0.0' });
  t.after(async () => { await client.close(); await app.close(); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), app.createServer().connect(b)]);
  const { sessionId } = decode(await client.callTool({ name: 'chrome_session', arguments: { action: 'open', label: 'selected-page' } }));
  const call = (tool, args, output = {}) => client.callTool({ name: 'chrome_call', arguments: { sessionId, tool, args, ...output } });
  const title = async () => valueFromEvaluation(decode(await call('evaluate_script', { function: '() => document.title' })));
  const schema = decode(await client.callTool({ name: 'chrome_tools', arguments: { sessionId, name: 'take_screenshot' } }));
  assert.equal(schema.inputSchema.properties.pageId, undefined, 'workers run with --no-page-id-routing');

  const opened = decode(await call('new_page', { url: 'data:text/html,<title>first</title>' }));
  assert.match(opened.data, /^2: first .*\[selected\]$/mu);
  const shot = decode(await call('take_screenshot', {}));
  assert.equal(shot.imagesOmitted, 1);
  assert.match(shot.hint, /chrome_read with includeImages:true/u);
  const image = await client.callTool({ name: 'chrome_read', arguments: { sessionId, resultId: shot.resultId, includeImages: true } });
  assert.equal(image.content.find(block => block.type === 'image')?.mimeType, 'image/png');
  const stray = await call('take_screenshot', { pageId: 2 });
  assert.equal(stray.isError, true, 'upstream rejects a stray pageId instead of acting on another page');
  assert.match(JSON.parse(stray.content[0].text).data, /Unrecognized key: "pageId"/u);

  decode(await call('new_page', { url: 'data:text/html,<title>second</title>' }));
  assert.equal(await title(), 'second');
  decode(await call('select_page', { pageId: 2 }));
  assert.equal(await title(), 'first');
});

test('real Chrome: CLI flags after -- reach workers (viewport, workspace, page-ID routing) and --verbose stays private', {
  skip, timeout: 60_000,
}, async (t) => {
  // The broker's TMPDIR holds each worker's private temp dir (always allowed upstream); workspace and elsewhere sit outside it.
  const base = await mkdtemp(join(tmpdir(), 'broker-passthrough-'));
  const [workerTmp, workspace, elsewhere] = ['tmp', 'workspace', 'elsewhere'].map(name => join(base, name));
  await Promise.all([workerTmp, workspace, elsewhere].map(dir => mkdir(dir)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--transport', 'stdio', '--verbose',
      '--chrome-path', chromeOptions.chromePath, ...(chromeOptions.noSandbox ? ['--no-sandbox'] : []),
      // --page-id-routing comes after the broker's --no-page-id-routing and wins, so page tools need pageId again.
      '--', `--workspace=${workspace}`, '--viewport=800x600', '--page-id-routing',
    ],
    env: { ...process.env, TMPDIR: workerTmp },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'passthrough-agent', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await rm(base, { recursive: true, force: true, maxRetries: 10 });
  });
  await client.connect(transport);
  const { sessionId } = decode(await client.callTool({ name: 'chrome_session', arguments: { action: 'open', label: 'passthrough' } }));
  const call = (tool, args) => client.callTool({ name: 'chrome_call', arguments: { sessionId, tool, args } });
  const opened = decode(await call('new_page', { url: 'data:text/html,<title>private-page-title</title>' }));
  const pageId = Number(opened.data.split('\n').find(line => /^\d+:.*\[selected\]/u.test(line)).match(/^(\d+)/u)[1]);
  const withoutPageId = await call('take_screenshot', {});
  assert.equal(withoutPageId.isError, true, 'with page-ID routing, page tools require pageId');
  assert.match(JSON.parse(withoutPageId.content[0].text).data, /pageId/u);
  const size = valueFromEvaluation(decode(await call('evaluate_script', { pageId, function: '() => [innerWidth, innerHeight]' })));
  assert.deepEqual(size, [800, 600]);
  const shot = join(workspace, 'shot.png');
  decode(await call('take_screenshot', { pageId, filePath: shot }));
  assert.ok((await stat(shot)).size > 0);
  const outside = await call('take_screenshot', { pageId, filePath: join(elsewhere, 'shot.png') });
  assert.equal(outside.isError, true, 'paths outside the workspace stay denied');
  assert.match(outside.content[0].text, /Access denied/u);
  assert.equal((await workerTempDirs(workerTmp)).length, 1, 'the worker temp dir lives in the broker\'s TMPDIR');
  await client.callTool({ name: 'chrome_session', arguments: { action: 'close', sessionId } });
  assert.deepEqual(await workerTempDirs(workerTmp), [], 'closing the session removes its temp dir');
  // stderr and stdout are separate pipes; wait for the log line instead of assuming order.
  for (const deadline = Date.now() + 5000; !stderr.includes('session closed') && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(stderr, /session opened id="[\w-]{6}" label="passthrough"/u);
  assert.match(stderr, /session closed id="[\w-]{6}" label="passthrough" reason="client"/u);
  assert.doesNotMatch(stderr, /private-page-title|shot\.png|innerWidth/u);
});
