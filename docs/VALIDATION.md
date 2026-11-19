# Validation

Recorded on 19 November 2026 on macOS 15 (Darwin 24.6) with Node.js 24.14.0, npm 11.9.0, Google Chrome 157.0.8103.80, `chrome-devtools-mcp` 1.13.0, and MCP SDK 1.32.2. Timings and memory are from one machine and are indicative only.

## Test suites

| Command | Result | Needs Chrome |
|---|---|---|
| `npm test` | 79 passed | No |
| `CHROME_PATH=/path/to/chrome npm run test:chrome` | 5 passed | Yes |

`npm test` uses a mock upstream (in process and as real stdio subprocesses) to cover the HTTP and stdio frontends, token, Host and Origin checks, session lifecycle, queues and capacity, timeouts and retirement, output budgets and paging, strict tool arguments, the passthrough grammar and denylist (including `--chrome-arg` spellings and `--workspace` paths), the startup flag and `--chrome-path` checks, closed-session reasons, signal handling during shutdown, and the CLI. Concurrency tests use barriers rather than timing thresholds.

`npm run test:chrome` drives real Chrome through the broker:

- Two sessions with separate cookies and `localStorage`, a barrier that both sessions' `evaluate_script` calls must reach at the same time, snapshot truncation and paging, and one session surviving another's close.
- Temp isolation: a session's `upload_file` cannot list the OS temp directory or read another session's temp directory or profile, and every worker temp directory is removed on shutdown.
- `file:` URLs blocked by default and opened only with `--allow-file-urls`.
- Page tools acting on the selected page without `pageId`, a stray `pageId` rejected, `select_page` switching pages, and the omitted-image hint.
- Passthrough flags (`--viewport`, `--workspace`, `--page-id-routing`) reaching workers over the CLI, the session temp directory removed on close, and `--verbose` logging no page data.

The CI workflow (`.github/workflows/ci.yml`) runs both suites on Ubuntu. It has not run yet.

## Parallelism

Setup: two pages, one call on each, started together. Both calls request a URL from a local server that answers only when both requests have arrived, so both arrive only if they run at the same time: `evaluate_script` fetches it, `navigate_page` navigates to it. Cookies stayed separate in every setup.

| Setup | Calls | Both at the barrier at once |
|---|---|---|
| One upstream worker, pages in two `isolatedContext`s, calls name a `pageId` | `navigate_page` + `navigate_page` | Yes, within 51 ms |
| Same | `evaluate_script` + `evaluate_script` | No: the second had not started after 10 s |
| Same | `evaluate_script` + `navigate_page` | No: the second had not started after 10 s |
| Broker, one session per page | `evaluate_script` + `evaluate_script` | Yes |

Upstream overlaps page tools on different pages but runs browser-wide tools such as `evaluate_script` alone; [ARCHITECTURE.md](ARCHITECTURE.md#why-one-worker-per-session) explains its queues. Broker sessions share no worker, so the last row holds for any tool.

Reproduce: `node examples/upstream-baseline.js /path/to/chrome` for the upstream rows (four runs here gave the same results, the overlapping pair 1 to 51 ms apart); the first test in `npm run test:chrome` for the broker row.

## Page visibility

In the same upstream setup (one worker, upstream's default page-ID routing), a cookie set on agent A's page was not visible from agent B's page in the other `isolatedContext`. But `list_pages` listed both contexts' pages with their titles and URLs, and `evaluate_script` with A's `pageId` returned A's page title, URL, cookie and `localStorage` value. Upstream has no notion of which agent called, so `isolatedContext` separates storage, not access to pages. A broker session has its own Chrome, so its `list_pages` and page IDs cover only its own pages.

Reproduce: `node examples/upstream-baseline.js /path/to/chrome` prints `cookieSeenByB: false`, `listPagesShowsBothContexts: true` and `cookieOfAReadByPageId: true`.

## Output size

A Wikipedia article's `take_snapshot` through `chrome_call` with default options:

| Page | Full snapshot | Default reply | `filter: "heading"` reply |
|---|---:|---:|---:|
| A Wikipedia article (first run) | 11,589 chars | 6,000 chars, truncated | 379 chars |
| [Web browser](https://en.wikipedia.org/wiki/Web_browser) | 110,670 chars | 6,000 chars, truncated | 2,067 chars (12 matching lines) |

In both runs the rest of the snapshot was readable with `chrome_read` and `nextOffset` without taking the snapshot again. Reproduce with the calls in the README [example](../README.md#example); page sizes change as the articles are edited.

## Tool schema size

`npm run measure:schemas` serializes each server's advertised `tools` array (names, descriptions, input schemas) and counts characters. It starts the upstream worker but not Chrome.

| Server | Tools | Characters |
|---|---:|---:|
| `chrome-devtools-mcp` 1.13.0, default flags | 33 | 31,498 |
| Broker | 4 | 4,287 |

That is 86.4% fewer characters before the first call. It is not a token count or a whole-workflow saving: each `chrome_tools` lookup adds context later. Clients that defer tool schemas until needed, such as Claude Code with tool search, already avoid most of this cost.

## Resources and latency

Memory is the macOS `footprint` total for the broker and all its descendant processes, which counts shared memory once; summed RSS counts it once per process and overstates the total (2.1 to 2.3 GB for three sessions that `footprint` put at 1.0 to 1.4 GB). Pages are a simple local page (2,000 short paragraphs with links) or a Wikipedia article. The first two rows are from the original run, over HTTP and 3 s after each page loaded; the rest are an independent reviewer's later measurements on the same machine, memory also by `footprint`.

| What | Measured |
|---|---|
| Daemon, no sessions | 46 MB |
| Each session, one page | 8 processes (1 worker, 7 Chrome); +0.32 GB on the simple page, +0.36 to 0.58 GB on Wikipedia |
| 4 sessions (the default cap), one page each | 1.31 GB (simple page) to 1.86 GB (Wikipedia), 34 processes |
| The same 4 pages in one upstream server | 0.50 GB (simple page), 0.98 GB (Wikipedia); the broker uses about 1.9 to 2.6 times as much |
| One session with 6 Wikipedia tabs | 1.36 GB; each tab added 0.15 to 0.35 GB |
| CLI start until listening, including the startup flag check | about 0.31 s |
| Opening a session (starts the worker, not Chrome) | 200 to 260 ms |
| First `new_page` (launches Chrome and loads the page) | 0.46 to 0.75 s |
| Broker overhead per call over HTTP, versus calling the worker directly | 1 to 3 ms |

Memory grows with every open page, not only with every session, and the broker does not cap tabs per session, so `--max-sessions` alone does not bound it.

Reproduce: start the broker, open sessions and pages (for example with the README example), list the broker's descendants with `ps -axo pid,ppid,comm`, and pass the broker's PID and theirs to `footprint`. For the upstream row, open the same pages in one worker from `createUpstreamFactory` in [src/upstream.js](../src/upstream.js), as `examples/upstream-baseline.js` does, and measure its process tree the same way. For the overhead, time the same cheap call on such a worker and through the broker.

## Robustness

- After `kill -9` of the broker with sessions open and Chrome running, no worker or Chrome processes were left. Check with `pgrep -fl chrome-devtools-mcp` after killing the broker. Chrome deleted its profile, but the session's temp directory stayed behind, empty; files upstream had saved there would stay too, since the broker removes the directory only on a normal close.
- A 35-second `evaluate_script` over HTTP completed normally. The HTTP server's 30-second `requestTimeout` limits receiving a request, not waiting for the reply.

## Not verified

- Linux and Windows. CI covers Linux once it runs.
- Load beyond a few sessions, remote or multi-tenant use (unsupported), and MCP clients other than the MCP SDK client.
