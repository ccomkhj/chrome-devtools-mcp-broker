import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function reply(res, status, message) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body exceeds 1 MiB.'), { status: 413 }));
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request aborted.')));
  });
}

const minTokenLength = 16;
/** The CLI's --help reads it from here. */
export const defaultPort = 7331;

/**
 * Why `token` cannot be a bearer token, or undefined if it can. Visible ASCII only: header parsing trims
 * surrounding whitespace and decodes bytes as Latin-1, so such a token could never match.
 */
export function tokenProblem(token) {
  if (typeof token !== 'string' || token.length < minTokenLength) return `must be at least ${minTokenLength} characters`;
  if (!/^[\x21-\x7e]+$/u.test(token)) return 'must be visible ASCII characters, without spaces';
  return undefined;
}

/** Requires a valid bearer token (see tokenProblem) unless the caller explicitly opts out with noAuth (and then no token). */
export async function startHttp(app, { port = defaultPort, host = '127.0.0.1', token, noAuth = false } = {}) {
  if (host !== '127.0.0.1') throw new Error('This broker only binds to 127.0.0.1. Remote multi-tenant hosting is not supported.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port.');
  if (typeof noAuth !== 'boolean') throw new Error('noAuth must be a boolean.');
  if (noAuth && token !== undefined) throw new Error('Pass either a bearer token or noAuth, not both.');
  if (!noAuth && tokenProblem(token)) throw new Error(`The bearer token ${tokenProblem(token)} unless noAuth is true.`);
  const expected = noAuth ? undefined : Buffer.from(token);
  const active = new Set();
  const server = createHttpServer(async (req, res) => {
    const localPort = server.address()?.port;
    const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    if (!hosts.includes(req.headers.host)) return reply(res, 403, 'Invalid Host header.');
    const origins = hosts.map(value => `http://${value}`);
    if (req.headers.origin !== undefined && !origins.includes(req.headers.origin)) return reply(res, 403, 'Origin is not permitted.');
    if (!noAuth) {
      // The auth scheme is case-insensitive (RFC 7235); only the token itself is compared, in constant time.
      const [, scheme = '', credentials = ''] = /^(\S+) +(.*)$/su.exec(req.headers.authorization ?? '') ?? [];
      const actual = Buffer.from(credentials);
      if (scheme.toLowerCase() !== 'bearer' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return reply(res, 401, 'A valid bearer token is required.');
      }
    }
    if (req.url !== '/mcp') return reply(res, 404, 'Not found.');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, 'This stateless MCP endpoint accepts POST only.');
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res, 415, 'Content-Type must be application/json.');
    const controller = new AbortController();
    const mcp = app.createServer({ signal: controller.signal });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      active.delete(cleanup);
      if (!res.writableFinished) controller.abort();
      await mcp.close().catch(() => {});
    };
    active.add(cleanup);
    res.on('close', () => { void cleanup(); });
    try {
      const body = await readJson(req);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      reply(res, error.status ?? 500, error.status ? error.message : 'MCP request failed.');
      await cleanup();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  let closing;
  return {
    server,
    url: `http://${host}:${server.address().port}/mcp`,
    close() {
      closing ??= (async () => {
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await Promise.allSettled([...active].map(cleanup => cleanup()));
        await closed;
      })();
      return closing;
    },
  };
}
