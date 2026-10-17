# 0001. Pin Node 24 and pnpm with mise and `packageManager`

Status: Accepted (M0)

## Context

The spec requires Node 24 (native type stripping) and pnpm, pinned through `mise.toml`. Machines without mise, and CI images that use corepack, also need to land on the same pnpm.

## Decision

- `mise.toml` pins `node = "24"` (latest 24.x LTS) and `pnpm = "12.14.0"` (exact).
- `package.json` repeats the pnpm pin as `"packageManager": "pnpm@12.14.0"` so corepack resolves the same version, and declares `"engines": {"node": ">=24"}`.
- Node is pinned to the major only: security patches arrive without churn, and the features we rely on (type stripping, `fs.globSync`) are stable across 24.x.
- Biome is the only lint/format tool (`biome check`), with its recommended rules, 2-space indent and line width 100.

## Consequences

Updating pnpm means editing both `mise.toml` and `packageManager`. Run commands as `mise exec -- pnpm …` or with mise shell activation enabled.
