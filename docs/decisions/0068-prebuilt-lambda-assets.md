# 0068. Prebuilt Lambda assets: esbuild bundles in `dist/assets`, runtime SDK external

Status: Accepted (M9)

## Context

The construct deploys two functions, control and sweep (0066, 0067). The plan requires that consumers need no esbuild, Docker or repo checkout: the package ships prebuilt bundles and the construct uses `Code.fromAsset` (`docs/01-plan-aws.md`, "Package shape"). The Lambda sources in `src/runtime/` stay out of `dist/` except as those bundles (0059). In `/var/task` there is no `package.json`, so the bundles cannot read the package version at run time.

## Decision

- `scripts/bundle-assets.ts` exports `bundleAssets({outdir, version})`; run as a script (`pnpm bundle`) it writes `dist/assets/control/index.mjs` and `dist/assets/sweep/index.mjs` from `src/runtime/entries/{control,sweep}.ts`. `pnpm build` ends with it, and `pnpm check` runs it before the tests, because the construct tests synthesize the assets.
- esbuild options: `bundle`, `platform: "node"`, `format: "esm"`, `target: "node24"`, `external: ["@aws-sdk/*"]`, whitespace and syntax minification (identifiers kept, so stack traces stay readable), `legalComments: "eof"` (the MIT notices of bundled dependencies), and a `createRequire` banner for CommonJS dependencies inside ESM.
- **Version inlined.** A plugin replaces `src/version.ts` (0064) with `export const PACKAGE_VERSION = "<version>"`.
- **Checks** that fail the build: any input under `src/cdk/` or from `aws-cdk-lib`, `constructs` or `esbuild`; any bundled `@aws-sdk/` input; and an output that lost the `with { type: "json" }` attribute of the runtime-info import (0076). `test/scripts/bundle-assets.test.ts` also scans fresh bundles with the pack test's `.ts`-specifier regex (moved unchanged to `scripts/lib/ts-specifier.ts`), checks that two builds are byte-identical, and imports each bundle in a child process from an empty directory with only a `node_modules` link and no `package.json` above it.
- **Runtime SDK (A14).** Lambda's Node.js runtimes include the AWS SDK for JavaScript v3, and AWS documents an ES-module handler (`index.mjs`) importing `@aws-sdk/client-s3/package.json` with `with { type: 'json' }` to read the included version ([Building Lambda functions with Node.js](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)). AWS also recommends including the SDK clients in the deployment package for backward compatibility across runtime updates ([Define Lambda function handler in Node.js](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html)). That recommendation is deliberately not followed: the plan uses the runtime SDK (V2 in 0059/0060) to keep the assets small, and the smoke script logs the runtime's client versions (0076).
- **pnpm build scripts.** pnpm 12.14 fails an install with `ERR_PNPM_IGNORED_BUILDS` when a dependency with a build script (esbuild) has no decision. Probed in a scratch project: with `allowBuilds:\n  esbuild: false` in `pnpm-workspace.yaml`, `pnpm install` and `pnpm install --frozen-lockfile` succeed and esbuild works, because its binary comes from the `@esbuild/<platform>` package. So the workspace denies esbuild's postinstall. esbuild `0.28.2` is a root devDependency only.

## Consequences

The tarball carries two self-contained `index.mjs` files (about 1 MB and 30 KB). Asset hashes change only when code or the version changes. If a runtime update ever changed the SDK minor in a way the code cannot handle, the init error shows up in the smoke script's runtime check; bundling the clients would then be the fix.
