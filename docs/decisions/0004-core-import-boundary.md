# 0004. Enforce the core import boundary with a test

Status: Accepted (M0)

## Context

`src/core/` must not import from `adapters/`, `http/`, `mcp/` or `node:fs`. The repo layout also says "no hono". The spec accepts either a Biome rule or a small test.

## Decision

Enforce it with `test/core/import-boundary.test.ts`:

- It finds every `src/core/**/*.ts` file and extracts `from "…"`, `import "…"` and `import("…")` specifiers.
- Relative specifiers are resolved against the importing file. The import fails if the target's top-level directory under `src/` is `adapters`, `http` or `mcp`.
- Bare specifiers fail if they are `fs`, `node:fs`, `fs/promises` (or other `fs/*` subpaths), `hono`, `hono/*` or `@hono/*`.
- A fixture case runs the checker on synthetic source, so the guard is known to work while `src/core/` is still empty.

Biome's `noRestrictedImports` was not used because it matches specifier strings. Catching `../adapters`, `../../adapters` and so on at every depth would need fragile patterns, while the test resolves real paths.

## Consequences

Violations are reported by `pnpm test` (part of `pnpm check`), not in the editor. The checker is regex-based, so an import specifier hidden inside a string or comment could trigger a false positive. That is acceptable for a guard.
