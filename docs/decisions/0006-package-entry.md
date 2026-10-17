# 0006. Empty library entry `src/index.ts` behind `exports`

Status: Accepted (M0)

## Context

The spec wants `"exports"` to point at `dist/`, but M0 has no library API. `tsc` also fails with "No inputs were found" when a project has no source files.

## Decision

- `src/index.ts` contains only `export {}` and a comment. `"exports"` maps `"."` to `./dist/index.js` (types `./dist/index.d.ts`) and exposes `./package.json`.
- The CLI is not the `"."` export, because importing it would run the CLI.
- No runtime dependencies are added in M0. The allowed five (hono, @hono/node-server, @modelcontextprotocol/sdk, zod, ulid) get added in the milestone that first uses each one.
- `package.json` has no `license` field and is not marked `private`. Choosing a license is up to the owner, and it is needed before the first npm publish (M5).

## Consequences

M1 adds the public exports (core service, ports, errors) to `src/index.ts`.
