# 0041. CLI client conventions

Status: Accepted (M5)

## Context

M5 adds the client commands (spec "CLI: one binary for server and client"). They are thin clients of the JSON API and are used by people and by scripts or agents, so output, errors and exit codes need one convention. 0007 only covered M0 usage.

## Decision

- **Server.** `--server <url>` > `ARTIFACT_SERVER` > `http://localhost:4400`. It must be an `http(s)` URL; a trailing `/` is dropped. Anything else is a usage error. When `ARTIFACT_TOKEN` is non-empty, every request sends `Authorization: Bearer <token>`. Requests use Node `fetch`, which sends neither `Origin` nor `Sec-Fetch-Site` (0037); a test keeps it that way. Client commands never touch storage.
- **No server.** If the request fails at the network level: `error: no_server: no artifact server answered at <url> (<errno>); start one with \`artifact serve\`, or set --server / ARTIFACT_SERVER`, exit 1. A response that is not the API's JSON error body becomes `error: bad_response: unexpected HTTP <status> from <url>`.
- **Output.** Human-readable by default, with the primary result on stdout (publish and rollback print the URL) and progress or summaries on stderr. `--json` on `publish`, `list`, `read`, `rollback` prints the API response body unchanged (`publish` adds `skipped`, see 0043). `open --json` prints `{id, url, opened}` and `rm --json` prints `{"ok": true}` (the API answers 204, so this mirrors `artifact_delete`). `serve`, `init` and `mcp` have no `--json`.
- **Errors.** API errors and client-side failures print `error: <code>: <message>` to stderr (API codes as in 0023, plus `no_server`, `bad_response`, `io_error` and `invalid_input`/`invalid_path` for local checks) and exit 1; stdout stays empty. With `--json` the same failure is printed to stderr as one JSON line in the API's error shape, `{"error": "<code>", "message": "<text>", …}`, carrying the API error body's other fields (for example `currentVersion` on `version_conflict`); client-side codes use the same shape. Exit codes do not change.
- **Usage errors** (no or unknown command, unknown flag, missing or extra positionals, invalid flag values, conflicting flags) print `artifact <command>: <message>` and that command's usage to stderr, and exit 2, also with `--json`. That includes `serve` flag errors. `serve` failures caused by the environment (`ARTIFACT_PORT`, non-loopback host without token, lock, port in use) stay exit 1.
- **Help and version.** `artifact --help`, `-h` and `help` print the global usage to stdout. `artifact <command> --help`/`-h` prints that command's usage. `artifact --version` prints the package version. Flags are parsed with `node:util` `parseArgs` (`strict: true`), and there is still no argument-parsing dependency (0007).

## Consequences

Scripts can rely on exit codes 0/1/2 and on `--json`. `version_conflict` is exit 1 like every other API error: scripts that need to tell it apart use `--json` and parse stderr's JSON line. "Not implemented" is gone.
