import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrokerError } from './errors.js';
import { version } from './version.js';

const require = createRequire(import.meta.url);

const attachReason = 'it attaches to an existing Chrome, which cannot be isolated per session. Driving your own logged-in Chrome is a non-goal of this broker; run upstream `chrome-devtools-mcp --autoConnect` (or with this flag) directly instead.';
const configReason = 'a config file could set flags that are rejected here; pass upstream flags after "--" instead.';
const owned = brokerFlag => `the broker sets it for every worker; use the broker's ${brokerFlag} instead.`;
const alwaysOff = what => `the broker always turns ${what} off.`;
const unrestrictedReason = 'lets file tools use any path; allow specific directories with --workspace=DIR instead.';

/**
 * The one denylist for flags after "--": upstream flags that would break per-session isolation or the
 * broker's token, or that the broker owns, plus the Chrome switches that upstream's --chrome-arg cannot
 * pass. Upstream flag keys are its canonical (camelCase) names.
 */
const deniedFlags = {
  browserUrl: { reason: attachReason },
  wsEndpoint: { reason: attachReason },
  wsHeaders: { reason: attachReason },
  autoConnect: { reason: attachReason },
  userDataDir: { reason: 'every session must get its own temporary profile; a shared profile breaks isolation.' },
  config: { reason: configReason },
  watchConfig: { reason: configReason },
  isolated: { reason: 'the broker always gives each session its own temporary profile.' },
  headless: { reason: owned('--headed') },
  executablePath: { reason: owned('--chrome-path') },
  usageStatistics: { reason: alwaysOff('usage statistics') },
  performanceCrux: { reason: alwaysOff('CrUX lookups') },
  fileNavigations: { reason: owned('--allow-file-urls') },
  viaCli: { reason: `it is reserved for upstream's own CLI and ${unrestrictedReason}` },
  allowUnrestrictedPaths: { reason: `it ${unrestrictedReason}` },
};
// Matched against the start of a Chrome argument's switch name (see checkChromeArg): Chrome honors the last
// --user-data-dir, and puppeteer skips its own temporary profile for any argument starting with --user-data-dir.
// --ignore-default-chrome-arg needs no check: puppeteer appends that profile and --remote-debugging-pipe after it drops ignored defaults.
const deniedChromeSwitches = [
  { prefix: 'user-data-dir', reason: deniedFlags.userDataDir.reason },
  { prefix: 'remote-debugging', reason: 'the worker owns Chrome\'s DevTools connection; another remote-debugging endpoint (port, address or pipe) lets any local process drive the session without the broker\'s token.' },
];
const terminatorReason = 'it ends Chrome\'s switch parsing, so Chrome would ignore the per-session profile and DevTools switches that follow it.';
const workspaceKeys = new Set(['workspace', 'filesystemroot']); // upstream's --filesystemRoot and its alias --workspace
// Chrome trims whitespace around each argument before reading it: ASCII whitespace on POSIX (on macOS a leading space,
// \t, \n, \v, \f or \r opened a port; NBSP did not), Unicode whitespace on Windows. JS \s plus U+0085 covers both.
const trim = text => text.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
// yargs strips one pair of matching quotes around a flag's "=" value before upstream sees it.
const unquote = value => (/^["']/u.test(value) && value.at(-1) === value[0] ? value.slice(1, -1) : value);
// yargs maps --user-data-dir, --userDataDir, ---user_data-dir and --USER-DATA-DIR to one
// option; matching whitespace-, case-, dash- and underscore-insensitively also rejects a few
// spellings yargs would ignore, which is the safe direction.
const flagKey = name => trim(name.split('.')[0]).replace(/[-_]/gu, '').toLowerCase();
const deniedByKey = new Map(Object.entries(deniedFlags).map(([name, entry]) => [flagKey(name), { name, ...entry }]));

/** Throws if one Chrome argument passed by `flag` (a --chrome-arg spelling) sets a denied switch; names the switch, never its value. */
function checkChromeArg(flag, value) {
  // As Chrome gets and reads it: yargs unquotes the value, Chrome trims it, takes a "--", "-" or (on Windows) "/"
  // switch prefix and ignores case on Windows; the switch name ends at "=".
  const arg = trim(unquote(value));
  if (arg === '--') throw new Error(`Chrome argument -- (via ${flag}) cannot be passed through: ${terminatorReason}`);
  const name = arg.toLowerCase().replace(/^(?:--|-|\/)/u, '').split('=')[0];
  const rule = deniedChromeSwitches.find(candidate => name.startsWith(candidate.prefix));
  if (rule) throw new Error(`Chrome argument --${name} (via ${flag}) cannot be passed through: ${rule.reason}`);
}

/**
 * Throws if a --workspace value is not an existing path or is the OS temp dir or one of its ancestors: every session's
 * private temp dir and profile lives there. Upstream resolves it from the shared working directory and compares real paths.
 */
function checkWorkspace(flag, value) {
  let dir;
  try { dir = realpathSync(resolve(unquote(value))); }
  catch (error) { throw new Error(`Upstream flag ${flag} must name an existing directory (${error.code}).`); }
  const fromDir = relative(dir, realpathSync(tmpdir()));
  if (!isAbsolute(fromDir) && fromDir !== '..' && !fromDir.startsWith(`..${sep}`)) {
    throw new Error(`Upstream flag ${flag} cannot be passed through: its directory contains the OS temp directory, which holds every session's private temp directory and profile; choose a directory outside it.`);
  }
}

/**
 * Throws unless chromePath names an executable file. Upstream starts without launching Chrome, so a wrong path would
 * otherwise surface only at a session's first browser call. On macOS the .app bundle is a directory; its binary is inside.
 */
function checkChromePath(chromePath) {
  let stats;
  try {
    accessSync(chromePath, constants.X_OK);
    stats = statSync(chromePath);
  } catch (error) { throw new Error(`--chrome-path ${JSON.stringify(chromePath)} must name an executable file (${error.code}).`); }
  if (stats.isFile()) return;
  const binary = /\.app\/?$/u.test(chromePath) ? `; pass the executable inside the app bundle, e.g. ${JSON.stringify(join(chromePath, 'Contents', 'MacOS', basename(chromePath, '.app')))}` : '';
  throw new Error(`--chrome-path ${JSON.stringify(chromePath)} is not an executable file${binary}.`);
}

/**
 * Contract: upstreamArgs is an array of strings, each one long upstream flag (--name or --name=value) that is not denied;
 * a --chrome-arg carries one allowed Chrome argument after "=", and a --workspace names an existing directory that is not
 * the OS temp dir or one of its ancestors. Otherwise throws, naming the flag but never echoing its value.
 */
function checkUpstreamArgs(upstreamArgs) {
  if (!Array.isArray(upstreamArgs) || !upstreamArgs.every(arg => typeof arg === 'string')) {
    throw new TypeError('upstreamArgs must be an array of strings');
  }
  upstreamArgs.forEach((arg, index) => {
    // yargs reads any other token as a value of the flag before it (array flags such as --chrome-arg take every one
    // that follows), as a positional it ignores ("--" ends its flags), or as a cluster of short flags ("-=u=URL" sets
    // -u). Upstream's only short flags (-u, -w, -e) are denied anyway.
    const name = arg.match(/^--(-*[^-=][^=]*)(?:=|$)/su)?.[1];
    if (name === undefined) {
      throw new Error(`Argument ${index + 1} after "--" is not an upstream flag: pass each as --name or --name=value, attaching values with "=", e.g. --viewport=1280x720 or --chrome-arg=--lang=de.`);
    }
    const flag = `--${name}`;
    const value = arg.length > flag.length ? arg.slice(flag.length + 1) : undefined;
    const key = flagKey(name);
    const entry = deniedByKey.get(key) ?? (key.startsWith('no') ? deniedByKey.get(key.slice(2)) : undefined);
    if (entry) {
      const canonical = flag === `--${entry.name}` ? '' : ` (--${entry.name})`;
      throw new Error(`Upstream flag ${flag}${canonical} cannot be passed through: ${entry.reason}`);
    }
    if (key === 'chromearg') {
      if (value === undefined) throw new Error(`Upstream flag ${flag} needs its Chrome argument after "=", e.g. ${flag}=--lang=de.`);
      checkChromeArg(flag, value);
    }
    if (workspaceKeys.has(key) && value !== undefined) checkWorkspace(flag, value);
  });
}

/**
 * Flags for each upstream chrome-devtools-mcp worker. file: navigation is off unless explicitly allowed.
 * chromePath, if given, must name an executable file. upstreamArgs (everything after "--" on the broker command line)
 * follow verbatim; upstream validates them.
 */
export function workerFlags({ chromePath, headed = false, noSandbox = false, allowFileUrls = false, upstreamArgs = [] } = {}) {
  checkUpstreamArgs(upstreamArgs);
  // A session belongs to one agent and runs its calls FIFO, so upstream's page-ID routing (on by default) would only
  // make every page tool require pageId. Page tools act on the selected page instead (new_page, select_page).
  // `-- --page-id-routing` restores it: upstream's yargs takes the last occurrence of a flag.
  const flags = ['--isolated', '--no-usage-statistics', '--no-performance-crux', '--no-page-id-routing'];
  if (!allowFileUrls) flags.push('--no-file-navigations');
  if (!headed) flags.push('--headless');
  if (chromePath !== undefined) {
    checkChromePath(chromePath);
    flags.push(`--executable-path=${chromePath}`);
  }
  if (noSandbox) flags.push('--chrome-arg=--no-sandbox');
  return [...flags, ...upstreamArgs];
}

/**
 * Wrap the published server through MCP; never depend on its internal classes.
 * `command`/`args` (tests only) replace the whole worker command line, including workerFlags.
 * A worker is started once the MCP handshake and tools/list (which launches no Chrome) succeed and upstream
 * reported no unknown flag; otherwise the factory throws UPSTREAM_START_FAILED with upstream's startup stderr.
 */
export function createUpstreamFactory({ command, args, log, ...options } = {}) {
  let workerArgs = args;
  if (!command) {
    const packagePath = require.resolve('chrome-devtools-mcp/package.json');
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
    const bin = resolve(dirname(packagePath), metadata.bin['chrome-devtools-mcp']);
    workerArgs = [bin, ...workerFlags(options)];
  }

  return async ({ signal } = {}) => {
    // Upstream file tools may always use the OS temp dir, and puppeteer puts the --isolated profile there,
    // so a shared one lets a session read other sessions' profiles. Each worker and its Chrome get a private
    // one (mkdtemp: mode 0700), removed after the worker exits.
    const tmp = await mkdtemp(join(tmpdir(), 'chrome-devtools-mcp-broker-'));
    const transport = new StdioClientTransport({
      command: command ?? process.execPath,
      args: workerArgs ?? [],
      stderr: 'pipe',
      maxBufferSize: 32 * 1024 * 1024,
      env: {
        // The broker's own configuration (CHROME_BROKER_*, e.g. its HTTP token) never reaches workers or Chrome.
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('CHROME_BROKER_'))),
        TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1',
      },
    });
    const client = new Client({ name: 'chrome-devtools-mcp-broker-upstream', version });
    let closed = false;
    let closePromise;
    let toolCache;
    // Keep only startup stderr (before any browsing, e.g. upstream rejecting a passed-through
    // flag) to explain a failed start; afterwards drain it unread so browsing data is never logged.
    let startupStderr = '';
    transport.stderr?.on('data', chunk => { if (startupStderr !== undefined) startupStderr = (startupStderr + chunk).slice(-4000); });
    client.onclose = () => { closed = true; };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { toolCache = undefined; });
    const close = () => {
      if (!closePromise) {
        closed = true;
        signal?.removeEventListener('abort', onAbort);
        // The transport waits for the worker to exit or kills it; rm's retries cover processes still exiting.
        closePromise = client.close().finally(() => rm(tmp, { recursive: true, force: true, maxRetries: 10 }));
      }
      return closePromise;
    };
    const onAbort = () => { void close().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    function ensureConnected() {
      if (closed) throw new BrokerError('UPSTREAM_DISCONNECTED', 'Chrome DevTools worker disconnected. Open a new session.');
    }
    function transportError(error) {
      if (closed || error?.code === -32000 || error?.code === -32001) {
        return new BrokerError('UPSTREAM_DISCONNECTED', 'Upstream connection failed or timed out. The session is closed; the action outcome may be unknown.');
      }
      return error;
    }

    const worker = {
      async listTools({ signal: requestSignal, timeoutMs = 60_000 } = {}) {
        ensureConnected();
        if (toolCache) return toolCache;
        const tools = [];
        const cursors = new Set();
        let cursor;
        try {
          do {
            const result = await client.listTools(cursor ? { cursor } : {}, { signal: requestSignal, timeout: timeoutMs + 5000 });
            tools.push(...result.tools);
            cursor = result.nextCursor;
            if (cursor && cursors.has(cursor)) throw new BrokerError('BAD_UPSTREAM', 'Repeated tools/list cursor.');
            if (cursor) cursors.add(cursor);
            if (tools.length > 1000) throw new BrokerError('BAD_UPSTREAM', 'Upstream advertised too many tools.');
          } while (cursor);
        } catch (error) { throw transportError(error); }
        toolCache = tools;
        return tools;
      },
      async callTool(name, arguments_, { signal: requestSignal, timeoutMs = 60_000 } = {}) {
        ensureConnected();
        try {
          // The broker owns the shorter deadline and retires the worker on expiry.
          return await client.callTool({ name, arguments: arguments_ }, undefined, {
            signal: requestSignal, timeout: timeoutMs + 5000,
          });
        } catch (error) {
          throw transportError(error);
        }
      },
      close,
    };

    try {
      if (signal?.aborted) throw new BrokerError('CANCELLED', 'Worker creation cancelled.');
      await client.connect(transport);
      if (signal?.aborted || closed) throw new BrokerError('UPSTREAM_DISCONNECTED', 'Chrome DevTools worker disconnected during startup.');
      // Upstream only warns about a flag it does not know (e.g. a misspelled one after "--") and ignores it. It
      // writes the warning before the handshake; the tools/list round trip after it leaves time for it to arrive.
      await worker.listTools({ signal });
      const unknown = startupStderr.match(/^Unknown arguments?: .*$/mu)?.[0];
      if (unknown) {
        startupStderr = unknown;
        throw new BrokerError('UPSTREAM_START_FAILED', 'chrome-devtools-mcp does not recognize a flag passed after "--"');
      }
      startupStderr = undefined;
    } catch (error) {
      await close().catch(() => {});
      // stderr is for the operator (the --verbose log, or the startup check's error); it is not part of the caller's error message.
      const stderr = startupStderr.trim().slice(-1000);
      const reason = String(error.message).slice(0, 800);
      const hint = !stderr ? '' : log ? ' The worker\'s startup error is in the broker log.' : ' Run the broker with --verbose to log the worker\'s startup error.';
      throw Object.assign(new BrokerError('UPSTREAM_START_FAILED', `Cannot start Chrome DevTools MCP: ${reason}${/[.!?]$/u.test(reason) ? '' : '.'}${hint}`), { stderr });
    }
    return worker;
  };
}
