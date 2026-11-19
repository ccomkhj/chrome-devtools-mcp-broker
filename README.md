# chrome-devtools-mcp-broker

Let several AI agents use Chrome at the same time, each in its own browser.

## Why

Google's [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) can serve several agents from one server, but they all share one browser:

- **Agents see each other's pages.** `isolatedContext` separates cookies and storage, but every agent's `list_pages` shows the other agents' pages with titles and URLs, and `evaluate_script` can run on any of them.
- **Agents wait for each other.** Browser-wide tools such as `evaluate_script`, `new_page` or a performance trace run one at a time; while one runs, no other agent's call can start.
- **Large results flood the context.** A big snapshot or listing comes back in full.

This broker gives each agent session its own `chrome-devtools-mcp` worker and temporary Chrome profile, so a session sees only its own pages and never waits for another session's call. It caps each reply at a character budget and caches the full result, so agents can page or filter it without running the action again. It drives the published `chrome-devtools-mcp` through MCP, unmodified. Evidence: [docs/VALIDATION.md](docs/VALIDATION.md).

## When to use it

| You have | Use |
|---|---|
| Several agents on one MCP server or client, e.g. parallel subagents | This broker |
| Large snapshots or listings you want to page or filter | This broker |
| Agents in separate processes, each starting its own server | Upstream with `--isolated` |
| Agents that may share pages and mostly navigate, click and fill, or tight [memory](docs/VALIDATION.md#resources-and-latency) | Upstream with `isolatedContext` |
| Your own logged-in Chrome (`--autoConnect`, `--browser-url`) | Upstream |

## Quick start

Requires Node.js 22.12+ and Google Chrome (or Chromium via `--chrome-path`).

```bash
(umask 077; openssl rand -hex 32 > ~/.chrome-broker-token)   # once
CHROME_BROKER_TOKEN=$(cat ~/.chrome-broker-token) npx -y chrome-devtools-mcp-broker
# listening at http://127.0.0.1:7331/mcp

claude mcp add --transport http chrome-broker http://127.0.0.1:7331/mcp \
  --header "Authorization: Bearer $(cat ~/.chrome-broker-token)"
```

Other clients: see [examples/mcp-config.json](examples/mcp-config.json). Or let the client start its own broker over stdio (no token; one session limit per client):

```json
{ "mcpServers": { "chrome-broker": { "command": "npx", "args": ["-y", "chrome-devtools-mcp-broker", "--transport", "stdio"] } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `chrome_session` | `open` a session (one per agent), `info`, or `close` it |
| `chrome_tools` | List, search, or get the input schema of upstream tools; does not launch Chrome |
| `chrome_call` | Run an upstream tool (`tool`, `args`) in your session; returns bounded text and a `resultId` |
| `chrome_read` | Page (`offset`) or filter a cached result by `resultId` |

Output options for `chrome_call` and `chrome_read`: `maxChars` (reply budget, default 6,000 characters), `filter` (case-insensitive line match), `select` (JSON Pointer into the raw result), `includeImages`.

```text
chrome_session {"action":"open"}                                      -> {"sessionId":"S",...}
chrome_call    {"sessionId":"S","tool":"new_page","args":{"url":"https://example.com"}}
chrome_call    {"sessionId":"S","tool":"take_snapshot","args":{}}     -> first part, "resultId":"R", "nextOffset":N
chrome_read    {"sessionId":"S","resultId":"R","filter":"heading"}    -> only heading lines
chrome_read    {"sessionId":"S","resultId":"R","offset":N}            -> next page, no re-run
chrome_session {"action":"close","sessionId":"S"}
```

Page tools act on the session's selected page, so they take no `pageId`. Calls in one session run in order; different sessions run in parallel.

## Configuration

`npx -y chrome-devtools-mcp-broker --help` lists every option and default. Flags after `--` go to every upstream worker:

```bash
npx -y chrome-devtools-mcp-broker --max-sessions 8 -- --viewport=1280x720
```

Flags that would break per-session isolation (attaching to an existing browser, a shared profile, and so on) are rejected at startup; see `deniedFlags` in [src/upstream.js](src/upstream.js).

## Security

For one user's trusted agents on their own machine. HTTP binds to 127.0.0.1 and requires the token. It is not a sandbox: pages run JavaScript and Chrome runs as your OS user. Threat model and reporting: [SECURITY.md](SECURITY.md).

## Limitations

- Each session runs its own worker and Chrome, so memory grows with sessions and tabs. Size `--max-sessions` to fit.
- A call that times out closes its session; the broker never retries.
- Sessions and cached results live in memory; cached results expire after 10 minutes.
- Agents run in parallel only if the MCP client sends their calls concurrently.
- Verified on macOS only so far.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design and trade-offs
- [docs/VALIDATION.md](docs/VALIDATION.md): measurements and how to reproduce them
- Development: `npm ci && npm test` (no Chrome needed); `CHROME_PATH=/path/to/chrome npm run test:chrome` for real-Chrome tests

## License

[MIT](LICENSE). Independent project, not affiliated with Google.
