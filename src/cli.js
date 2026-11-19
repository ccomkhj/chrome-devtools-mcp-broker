#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from './app.js';
import { defaultPort, startHttp, tokenProblem } from './http.js';
import { sessionDefaults } from './sessions.js';
import { version } from './version.js';

// README's quick-start recipe: one token, created once in a file only the user can read, so saved client configs keep working.
const tokenSetup = [
  '(umask 077; openssl rand -hex 32 > ~/.chrome-broker-token)   # once; only you can read it',
  'CHROME_BROKER_TOKEN=$(cat ~/.chrome-broker-token) npx -y chrome-devtools-mcp-broker',
].map(line => `  ${line}`).join('\n');
const help = `Chrome DevTools MCP Broker ${version}

chrome-devtools-mcp-broker [options] [-- chrome-devtools-mcp flags]

  --transport http|stdio    Default: http. Share one HTTP daemon among agents.
  --port N                  HTTP port (default ${defaultPort}); loopback only.
  --no-auth                 HTTP without CHROME_BROKER_TOKEN: any local process or user can drive Chrome.
  --allow-file-urls         Let sessions open file: URLs (blocked by default); exposes your local files.
  --chrome-path PATH        Chrome/Chromium executable; otherwise upstream finds Chrome.
  --headed                  Show Chrome windows (default headless).
  --max-sessions N          Maximum independent workers (default ${sessionDefaults.maxSessions}).
  --max-queue N             Waiting calls allowed per session (default ${sessionDefaults.maxQueue}).
  --idle-ttl-ms N           Close idle sessions after N ms (default ${sessionDefaults.idleTtlMs}).
  --call-timeout-ms N       Retire a session after a hung call (default ${sessionDefaults.callTimeoutMs}).
  --no-sandbox              Explicitly disable Chrome sandbox for constrained test containers.
  --verbose                 Log session lifecycle events to stderr; never page content, tool arguments, or results.
  --help                    Print this help.
  -- FLAGS...               Pass the remaining flags verbatim to every chrome-devtools-mcp worker, each as
                            --name or --name=value (values attached with "="), e.g.
                              -- --viewport=1280x720 --workspace=/path/for/screenshots
                            Upstream validates them at startup, and unknown ones are errors. Also rejected:
                            flags that attach to an existing browser, share a profile, lift the file-path
                            limits (including a --workspace containing the OS temp dir), open a Chrome
                            debugging endpoint, read a config file, or that the broker already sets.

HTTP requires a bearer token unless --no-auth is given:
${tokenSetup}
Clients send it as "Authorization: Bearer <token>". stdio needs no token.
No dependency downloading or browser installation happens at startup.
`;

// JSON.stringify leaves these raw; terminals and log viewers may treat them as line breaks or controls.
const quote = value => JSON.stringify(value).replace(/[\u0080-\u009f\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** --verbose: one stderr line per lifecycle event. Strings are JSON-quoted and escaped so labels cannot forge lines. */
function logToStderr(event, fields) {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'string' ? quote(value) : value}`);
  process.stderr.write(`${new Date().toISOString()} ${event} ${pairs.join(' ')}\n`);
}

/** A numeric flag's value as a plain decimal integer, or undefined if the flag was not given; range checks belong to its consumer. */
function integer(flag, value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${flag} must be a decimal integer.`);
  return Number(value);
}

async function main() {
  const args = process.argv.slice(2);
  const { values, tokens } = parseArgs({ options: {
    transport: { type: 'string', default: 'http' },
    // Numeric flags have no default here; their consumers (startHttp, SessionManager) own and export the defaults.
    port: { type: 'string' },
    'chrome-path': { type: 'string' },
    headed: { type: 'boolean', default: false },
    'max-sessions': { type: 'string' },
    'max-queue': { type: 'string' },
    'idle-ttl-ms': { type: 'string' },
    'call-timeout-ms': { type: 'string' },
    'no-sandbox': { type: 'boolean', default: false },
    'no-auth': { type: 'boolean', default: false },
    'allow-file-urls': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  }, args, allowPositionals: true, tokens: true });
  if (values.help) { process.stdout.write(help); return; }
  const terminator = tokens.find(token => token.kind === 'option-terminator');
  const stray = tokens.find(token => token.kind === 'positional' && !(terminator && token.index > terminator.index));
  if (stray) throw new Error(`Unexpected argument "${stray.value}". Pass chrome-devtools-mcp flags after "--".`);
  const upstreamArgs = terminator ? args.slice(terminator.index + 1) : [];
  if (!['http', 'stdio'].includes(values.transport)) throw new Error('--transport must be http or stdio.');
  const token = process.env.CHROME_BROKER_TOKEN || undefined;
  const noAuth = values['no-auth'];
  const port = integer('--port', values.port);
  if (noAuth && values.transport === 'stdio') throw new Error('--no-auth applies only to --transport http; stdio has no authentication to disable.');
  if (port !== undefined && values.transport === 'stdio') throw new Error('--port applies only to --transport http; stdio listens on no port.');
  if (values.transport === 'http') {
    if (noAuth && token) throw new Error('--no-auth conflicts with CHROME_BROKER_TOKEN; unset one of them.');
    if (!noAuth && !token) {
      throw new Error(`HTTP transport requires CHROME_BROKER_TOKEN. Set one, e.g.\n${tokenSetup}\nand send it as "Authorization: Bearer <token>". To run without authentication, pass --no-auth.`);
    }
    if (token && tokenProblem(token)) throw new Error(`CHROME_BROKER_TOKEN ${tokenProblem(token)}. Generate one, e.g.\n${tokenSetup}`);
  }
  const app = createApp({
    chromePath: values['chrome-path'], headed: values.headed, noSandbox: values['no-sandbox'],
    allowFileUrls: values['allow-file-urls'], upstreamArgs, log: values.verbose ? logToStderr : undefined,
    maxSessions: integer('--max-sessions', values['max-sessions']), maxQueue: integer('--max-queue', values['max-queue']),
    idleTtlMs: integer('--idle-ttl-ms', values['idle-ttl-ms']), callTimeoutMs: integer('--call-timeout-ms', values['call-timeout-ms']),
  });
  let http;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await http?.close();
    await app.close();
  }
  // Every signal, not just the first: under npm, Ctrl+C reaches node twice (from the terminal and forwarded by npm), and a
  // second default SIGINT would kill the broker before it removes session temp dirs. stop() runs once.
  const onSignal = () => { void stop().catch(() => { process.exitCode = 1; }); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    // Before serving: one worker (no Chrome) checks the final flags, so a bad or unknown one stops startup here.
    await app.probe();
    if (stopping) return;
    if (values.transport === 'stdio') {
      const server = app.createServer();
      await server.connect(new StdioServerTransport());
      process.stdin.once('end', () => { void stop(); });
    } else {
      if (noAuth) process.stderr.write('WARNING: --no-auth: HTTP authentication is disabled; any local process or user can drive Chrome.\n');
      const started = await startHttp(app, { port, token, noAuth }).catch(error => {
        throw error.code === 'EADDRINUSE' ? new Error(`Port ${error.port} on ${error.address} is in use; pick another --port or stop the other process.`) : error;
      });
      // A signal while startHttp was listening found no server to close; never serve a closed app.
      if (stopping) { await started.close(); return; }
      http = started;
      process.stderr.write(`Chrome DevTools MCP Broker listening at ${http.url}\n`);
    }
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
