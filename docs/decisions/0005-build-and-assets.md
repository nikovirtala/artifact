# 0005. Build script, tolerant asset copy, no reload-client placeholder

Status: Accepted (M0)

## Context

Node does not strip types inside `node_modules`, so the package must ship JS. `tsc` does not copy `src/http/reload-client.js`, and that file only arrives in M3.

## Decision

- `pnpm build` = `pnpm clean && tsc -p tsconfig.build.json && node scripts/copy-assets.ts`.
- `tsconfig.build.json` extends the base config, sets `noEmit: false` and `allowImportingTsExtensions: false`, and adds `rootDir: src`, `outDir: dist`, `declaration: true`, `rewriteRelativeImportExtensions: true`.
- `scripts/copy-assets.ts` copies a fixed list of non-TS assets (currently only `http/reload-client.js`) into `dist/`. It skips any that are missing and logs the skip. **No placeholder `reload-client.js` is created.** A stub would be served as the real client if anyone forgot to replace it.
- `scripts/clean.ts` deletes `dist/` before each build, so stale files never reach the tarball.
- The build scripts are `.ts` and run directly on Node 24, which keeps them cross-platform without `rm`/`cp` shell differences.
- `prepublishOnly` = `pnpm check && pnpm build`.

## Consequences

From M3 on, a build without `reload-client.js` would mean a broken package. The M5 `pnpm pack` e2e check catches that.

Update (M2): M3, which adds `reload-client.js`, also makes the copy strict: the build fails if a listed asset is missing.
