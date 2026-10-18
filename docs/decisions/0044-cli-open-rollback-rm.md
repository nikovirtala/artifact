# 0044. `artifact open`, `rollback` and `rm`

Status: Accepted (M5)

## Context

`open` launches a browser, which tests must never do. `rm` is destructive and is run both by hand and from scripts.

## Decision

- **open `<id>` [`--version <n>`].** It reads the meta and prints the current URL, or the pinned one (the current URL + `v/<n>/`, which must be a committed version), on stdout. It then opens the URL with the browser opener (0040) every time, whatever `serve`'s auto-open setting is, except that `BROWSER=none` skips the launch. `ARTIFACT_OPEN` and the SSH/display heuristics do not apply to this explicit command. A failed launch prints a warning; the exit code stays 0.
- **Opener log.** When `ARTIFACT_OPENER_LOG=<file>` is set, the opener used by `serve` and by `open` appends the URL and a newline to that file and spawns nothing (`src/cli/opener.ts`). It is documented in the README's environment variables (for tests and CI), not in `--help`, and the e2e helpers set it on every spawned process.
- **rollback `<id> <version>`** calls `POST /api/artifacts/<id>/rollback`, prints the URL, and writes `rolled back <id> to version <n>` to stderr.
- **rm `<id>`.** Without `--yes`, stdin must be a TTY; otherwise it is a usage error (exit 2) and no request is sent (checked first). On a TTY it reads the artifact (`GET /api/artifacts/<id>`, so an unknown id fails with `not_found`, exit 1, before any prompt), then asks `Delete "<title>" (<id>, <n> versions)? [y/N] ` on stderr (`(untitled)` without a title, `1 version` singular) and deletes only on `y`/`yes`; anything else prints `not deleted` and exits 1. `--yes` skips both the lookup and the prompt: one `DELETE`.

## Consequences

Scripts must pass `--yes`, which mirrors `artifact_delete`'s `confirm: true`. CLI tests never spawn a real browser.
