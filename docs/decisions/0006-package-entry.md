# 0006. Empty library entry `src/index.ts` behind `exports`

Status: Accepted (M0)

## Context

The spec wants `"exports"` to point at `dist/`, but M0 has no library API. `tsc` also fails with "No inputs were found" when a project has no source files.

## Decision

- `src/index.ts` contains only `export {}` and a comment. `"exports"` maps `"."` to `./dist/index.js` (types `./dist/index.d.ts`) and exposes `./package.json`.
- The CLI is not the `"."` export, because importing it would run the CLI.
- No runtime dependencies are added in M0. The allowed five (hono, @hono/node-server, @modelcontextprotocol/sdk, zod, ulid) get added in the milestone that first uses each one.
- `package.json` is not marked `private`.

## Consequences

M1 adds the public exports (core service, ports, errors) to `src/index.ts`.

## Update (M2)

- The package is **CLI-only in v1**. `src/index.ts` is back to `export {}` (it keeps `tsc` builds working), and `"exports"` lists only `"./package.json"`. A library API can be added later as a deliberate, versioned surface.
- The license is MIT (`Copyright (c) 2026 Niko Virtala`): `"license": "MIT"` in `package.json`, and `LICENSE` is in `"files"`.
