# 0064. `GET /api` returns the server version; the CLI warns on a major mismatch

Status: Accepted (M9)

## Context

From M9 the CLI talks to remote deployments as well as the local server (`docs/01-plan-aws.md`: "`GET /api` returns `{version}` and the CLI warns on a major-version mismatch"). A CLI of one major version talking to a deployment of another may misbehave, and the user should learn why without any command failing because of the check. Until now `GET /api` was the API's 404.

## Decision

- `GET /api` answers `{"version": <package version>}` with `Cache-Control: no-store`. It is registered in `createApi` before the catch-all, so it sits behind the browser guard (0037) and the token guard (0027, 0054) like every other API route and tells an unauthenticated caller nothing.
- The version comes from `src/version.ts`, the one module that reads `package.json` (the Lambda bundles inline it, 0068).
- The CLI (`src/cli/version-check.ts`) asks once per process, before the first request, and only when the server is not loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`). A different major version prints one stderr line: `artifact: warning: the server at <url> runs artifact <v>, this CLI is <v>; major versions differ, so commands may fail or behave differently`. `<url>` is the user's own `--server` value.
- Any failure of the check (network, non-200, bad JSON, no `version`) is silent. The server's `version` is used only if it matches `^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$`, so no unvalidated server string reaches the terminal. The check never changes the exit code.

## Consequences

Locally `GET /api` changes from 404 to 200; no existing test asserted the 404. Every existing CLI and e2e test talks to a loopback server and sees exactly the requests it saw before. A remote command costs one extra small request per process.
