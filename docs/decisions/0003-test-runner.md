# 0003. `node --test` with a quoted glob, running `.ts` directly

Status: Accepted (M0)

## Context

The spec uses `node:test` + `node:assert` with no test-runner dependency, and Node 24 runs `.ts` by stripping types.

## Decision

- `pnpm test` runs `node --test "test/**/*.test.ts"`. The quotes matter: Node expands the glob itself, so the result does not depend on which shell runs it.
- Tests live under `test/`, mirroring `src/` (`test/cli/`, `test/core/`), and are named `*.test.ts`. Shared suites that are not entry points, such as the M1 `test/contract/*.contract.ts`, keep a different suffix so the glob does not run them on their own.
- The CLI smoke test starts `src/cli/main.ts` in a child process with `process.execPath`. That checks real exit codes and stdout/stderr, and it covers "runs with no build step".
- `fast-check` is installed now so M1 property tests can use it without another tooling change.

## Consequences

When the glob matches nothing, Node reports 0 tests and exits 0, so an empty test tree cannot break `pnpm check`.
