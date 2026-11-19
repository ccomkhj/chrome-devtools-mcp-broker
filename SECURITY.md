# Security

## Threat model

The broker is built for one user's trusted, cooperative AI agents on the same machine. It drives real browsers, so whoever can call it can browse as a fresh Chrome profile and run JavaScript in the pages it opens.

It is designed to stop:

- Other local processes, other OS users, and web pages from using the HTTP endpoint: it listens on 127.0.0.1 only, requires a bearer token (`CHROME_BROKER_TOKEN`), and rejects foreign `Host` and `Origin` headers, which blocks DNS rebinding. stdio has no token; the client that starts the process owns it.
- Agents from seeing each other's browser state, or your own. Each session's worker and Chrome get a private temp directory (mode 0700) that holds a fresh temporary profile and is deleted when the session closes. Upstream file tools, such as `upload_file` or a screenshot `filePath`, can use only that directory plus any `--workspace` directories. Flags that attach to an existing browser, share a profile, lift the file-path limits, or open another Chrome remote-debugging endpoint are rejected at startup. Session IDs are unguessable capabilities that no tool lists, and a result ID works only with its own session ID.
- The token from reaching workers, Chrome, or pages: `CHROME_BROKER_*` variables are removed from the workers' environment.
- Pages from reading local files through `file:` URLs, unless you pass `--allow-file-urls`.
- Page data from reaching the broker's log: `--verbose` records session lifecycle only, never page content, tool arguments, or results.

It does not protect against:

- An agent you connected that misbehaves. It can open any site, run page JavaScript, use upstream file tools within their allowed directories, and use any session ID it learns.
- Options that widen file access. `--workspace=DIR` adds `DIR` for every session; it does not restrict access to it, and sessions can read each other's files there. A `DIR` that is or contains the OS temp directory would expose other sessions' profiles, so it is rejected at startup; `--allow-file-urls` still exposes every file your OS user can read, those profiles included.
- Malicious page content. Pages can try prompt injection through what they return; agents must treat page content as untrusted. The broker is not an OS sandbox: Chrome and the workers run as your OS user, a Chrome exploit runs with your permissions, and `--no-sandbox` removes Chrome's own layer of defense.
- Processes running as your own OS user, which can read the token from your environment or client configuration.
- Upstream's own logging: `--logFile`, if you pass it after `--`, may record browsing data.
- Running with `--no-auth`: then any local process or user can drive Chrome.
- Remote or multi-tenant use. It is unsupported, and the server refuses to bind to anything but 127.0.0.1.

## Reporting a vulnerability

Please report security problems privately by opening a GitHub security advisory on this repository (Security tab, "Report a vulnerability"), not a public issue. Include the broker version, OS, and steps to reproduce.

Vulnerabilities in `chrome-devtools-mcp` itself or in Chrome should go to those projects.

## Supported versions

Only the latest release gets security fixes.
