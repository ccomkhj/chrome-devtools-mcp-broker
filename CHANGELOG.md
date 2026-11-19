# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor release may break compatibility.

## 0.1.0 - Unreleased

First public release.

Features:

- Four MCP tools: `chrome_session`, `chrome_tools`, `chrome_call`, `chrome_read`. Unknown top-level arguments are rejected with the list of accepted ones.
- One `chrome-devtools-mcp` worker and temporary Chrome profile per session, so a session never sees another's pages. Different sessions run in parallel for every tool; calls within a session run in order.
- Page tools act on the session's selected page without `pageId`; `-- --page-id-routing` restores upstream's routing.
- Bounded replies (`maxChars`, `filter`, `select`, `includeImages`) with a per-session result cache, so output can be paged without running an action again.
- Streamable HTTP daemon shared by all agents, or stdio.
- Upstream flags pass through after `--`, each as `--name` or `--name=value`. At startup one worker (without Chrome) checks them, so a bad value or unknown flag stops the broker, as do a wrong `--chrome-path` and a port in use.
- A call that times out or is cancelled while running retires its session. The default `--call-timeout-ms` is below the MCP SDK client's default request timeout, so clients see `CALL_TIMEOUT`, and a recently closed session's ID answers `SESSION_NOT_FOUND` with the reason it closed.
- `--verbose` session lifecycle log, and a `CAPACITY` error that says how many slots are busy, idle, or closing and when one frees up.
- SIGINT and SIGTERM close every session and remove its temp directory, also when npm delivers Ctrl+C twice.

Security defaults:

- HTTP binds to 127.0.0.1 only, rejects foreign `Host` and `Origin` headers, and requires `CHROME_BROKER_TOKEN` unless `--no-auth`.
- Each session's worker and Chrome get a private temp directory, deleted on close, so sessions cannot read each other's profiles or temp files.
- Flags that attach to an existing browser, share a profile, lift upstream's file-path limits, open a Chrome remote-debugging endpoint, or read a config file are rejected, as are `--chrome-arg` values that do so in any spelling Chrome accepts and a `--workspace` that is or contains the OS temp directory.
- `file:` URLs are blocked unless `--allow-file-urls`. `CHROME_BROKER_*` environment variables never reach workers or Chrome.
