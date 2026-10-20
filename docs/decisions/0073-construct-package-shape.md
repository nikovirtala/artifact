# 0073. Construct package shape: `./cdk` export, optional peers, source condition, `.js` declarations

Status: Accepted (M9)

## Context

The plan ships the construct in the one package (`docs/01-plan-aws.md`, "Package shape"): `@nikovirtala/artifact/cdk` → `dist/cdk/index.js` with types, `aws-cdk-lib ^2`, `constructs ^10` and `@aws-sdk/client-secrets-manager ^3` as optional peers, the v1 four as the only runtime `dependencies`, and `bin` unchanged. M8's pack test asserted that the package declares no peers (0059) and ships no `.d.ts`, because nothing needed either yet. TypeScript 7.0.2's `rewriteRelativeImportExtensions` rewrites `.ts` specifiers in JS output only; declaration emit keeps `from "./x.ts"`, which a consumer's TypeScript cannot resolve inside `node_modules`.

The pinned `aws-cdk` 2.1145.0 `cdk init app --language typescript` template uses TypeScript `~7.0.2`, `module`/`moduleResolution` `NodeNext`, `noEmit`, `isolatedModules`, `skipLibCheck`, a `package.json` without `"type"` (so CommonJS), and `"app": "npx tsc && npx tsx bin/<name>.ts"`. There TypeScript resolves `@nikovirtala/artifact/cdk` through `exports` → `types`, and the compiled CommonJS import becomes a `require()` of an ES module, which Node 24 (and tsx on it) loads through `require(esm)` as long as the module graph has no top-level await.

## Decision

- `package.json`:
  - `exports["./cdk"]` with the conditions in this order: `artifact-source` → `./src/cdk/index.ts`, `types` → `./dist/cdk/index.d.ts`, `default` → `./dist/cdk/index.js`. Only this repo sets `artifact-source` (`examples/personal` through `node --conditions=artifact-source` and `customConditions`), so the reference app runs the source without a build; in the tarball the target is missing, which is harmless because nobody else sets the condition.
  - `typesVersions: {"*": {"cdk": ["dist/cdk/index.d.ts"]}}` for consumers on `moduleResolution: node10`, which ignores `exports`.
  - `peerDependencies` `aws-cdk-lib ^2.273.0`, `constructs ^10.0.0`, `@aws-sdk/client-secrets-manager ^3.0.0`, all three `optional` in `peerDependenciesMeta`, so npm installs none of them for CLI users.
  - `build`: `tsc -p tsconfig.build.json` (JS for everything but `src/runtime`), then `tsc -p tsconfig.cdk.json` (declarations for `src/cdk` only), then `scripts/fix-dts.ts`, the plain-JS asset copy and the bundles (0068).
- **Declarations only for `dist/cdk/`.** `scripts/fix-dts.ts` rewrites relative `.ts` specifiers in `from "…"`, `import("…")` and `export … from "…"` of every `dist/cdk/**/*.d.ts` to `.js`, then re-scans with the pack test's regex and fails naming the file if any `.ts` specifier is left. Non-relative `.ts` specifiers cannot occur, because `src/cdk/` imports only `aws-cdk-lib`, `constructs`, `node:*` and itself.
- **Deviation: the `aws-cdk-lib` floor is `^2.273.0`, not `^2`.** The construct uses `Runtime.NODEJS_24_X` and the stable `aws-scheduler` / `aws-scheduler-targets` modules, which are recent, and only 2.273.0 is tested (root devDependency, pack test, `examples/personal`). An older `aws-cdk-lib 2.x` would satisfy `^2` and fail at synth.
- **Pack-test assertions changed on purpose:** "no `peerDependencies`" becomes "exactly the three optional peers"; "no `.d.ts` anywhere" becomes "no `.d.ts` outside `dist/cdk/`"; the tarball must contain `dist/cdk/index.js`, `dist/cdk/index.d.ts` and both bundles. The four-`dependencies` check, the no-`dist/runtime/` check, the "no AWS package installed" check and the `.ts`-specifier scan of every installed file stay as strict as before. New (a): the installed `artifact token list --secret <arn>` exits 1 naming `npm install @aws-sdk/client-secrets-manager`.

## Consequences

CLI users install the same four dependencies as before. CDK users add `aws-cdk-lib` and `constructs` (which every CDK app has anyway), and the owner adds the Secrets Manager SDK where `artifact token` runs. The `cdk init` path, plain ESM, and TypeScript 5 with `node10` and `nodenext` resolution are exercised against the tarball by the pack test (0074).
