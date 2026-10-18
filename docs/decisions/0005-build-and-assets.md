# 0005. Build script, strict asset copy, no reload-client placeholder

Status: Accepted (M0; copy made strict in M3; no declarations since M5)

## Context

Node does not strip types inside `node_modules`, so the package must ship JS. `tsc` does not copy `src/http/reload-client.js`, and that file only arrived in M3.

## Decision

- `pnpm build` = `pnpm clean && tsc -p tsconfig.build.json && node scripts/copy-assets.ts`.
- `tsconfig.build.json` extends the base config, sets `noEmit: false` and `allowImportingTsExtensions: false`, and adds `rootDir: src`, `outDir: dist`, `declaration: false`, `rewriteRelativeImportExtensions: true`.
- `scripts/copy-assets.ts` copies a fixed list of non-TS assets (currently only `http/reload-client.js`) into `dist/`. **No placeholder `reload-client.js` is created.** A stub would be served as the real client if anyone forgot to replace it.
- `scripts/clean.ts` deletes `dist/` before each build, so stale files never reach the tarball.
- The build scripts are `.ts` and run directly on Node 24, which keeps them cross-platform without `rm`/`cp` shell differences.
- `prepublishOnly` = `pnpm check && pnpm build`.

Update (M3): the copy is strict. If any listed asset is missing, `copy-assets` names it on stderr, copies nothing and exits 1, so `pnpm build` fails. (Until M3 it skipped missing assets, because `reload-client.js` did not exist yet.)

Update (M5): `declaration: false`. The package exports no modules (`exports` is only `./package.json`, 0006), so the `.d.ts` files were never consumed and only doubled the tarball (98 files before). `pnpm test:pack` fails if one ships (0048).

## Consequences

A build can no longer produce a package without `reload-client.js`. As a second line, `src/http/reload.ts` reads the file when the app module loads, so a package missing it fails at startup rather than serving a broken script.
