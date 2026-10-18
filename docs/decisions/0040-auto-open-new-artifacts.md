# 0040. Open new artifacts in the browser

Status: Accepted (M4 follow-up)

## Context

In the owner's test the published page did not open; the user had to click the URL. Agents cannot reliably open a browser themselves, and the server runs on the user's machine.

## Decision

- When a publish **creates** an artifact (API `POST /api/artifacts` or `artifact_publish` without `id`), `serve` opens its current URL (configured isolation mode) in the default browser. Updates and rollbacks never open: the tab that is already open reloads.
- **On by default** for local `serve`. Off with `--no-open`, `ARTIFACT_OPEN=0` (also `false`, `no`, `off`) or `BROWSER=none`. Skipped automatically when `SSH_CONNECTION` is set, on Linux and other Unix systems without `DISPLAY` and `WAYLAND_DISPLAY`, and with a non-loopback `--host`. The AWS deployment never opens.
- **Per call.** The API publish body accepts `open?: boolean` (default `true`); `false` suppresses opening for that call. It lets the M5 `artifact publish --no-open` flag work without a server restart. The MCP tool has no such field: the server decides.
- **Result.** Publish results carry `opened: boolean` (API body and MCP `structuredContent`): true when the browser launch was started. The `artifact_publish` description says: if `opened` is true, tell the user the page is open in their browser; otherwise show the URL; never open it yourself.
- **Implementation.** An `Opener` (`(url) => boolean`) is injected into the HTTP and MCP layers; the core is unchanged. The adapter (`src/adapters/browser-opener.ts`) runs `open <url>` (macOS), `cmd /c start "" <url>` (Windows) or `xdg-open <url>` (others) with `child_process.spawn`, detached, unref'd, stdio ignored, the URL as its own argument (never a shell string) and only if it is a plain `http(s)` URL of safe characters. Spawn errors are logged once and otherwise ignored; opening never fails or delays the publish. No new dependency. Tests inject a fake opener.
- **Opener log (M5).** With `ARTIFACT_OPENER_LOG=<file>`, `serve` (and `artifact open`) append each URL to that file instead of launching a browser. It is documented in the README for tests and CI (0044).

## Consequences

`opened: true` means the launch started, not that a window appeared. Users who run `serve` somewhere without a browser and without the skip signals should pass `--no-open`.
