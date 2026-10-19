# 0048. Packaging and the pack test

Status: Accepted (M5)

## Context

Node does not strip types inside `node_modules`, so the tarball must work as built JS (0005, 0006). Only an install of the real tarball proves that.

## Decision

- `package.json` keeps `bin`, `files: ["dist", "README.md", "LICENSE"]`, `engines.node >=24` and `exports` only `./package.json`.
- `pnpm test:pack` (`scripts/pack-test.ts`) runs `pnpm build` and `pnpm pack` into a temp directory. It checks the tarball list (it must contain `dist/cli/main.js`, `dist/http/reload-client.js`, `README.md`, `LICENSE` and `package.json`; it must contain no `src/`, `test/` or `.d.ts`; the build emits no declarations, 0005). It then runs `npm init -y` and `npm install <tgz>` in a temp app, and fails if any installed file under `dist/` (every file, not only `.js`) imports a `.ts` specifier. Finally it runs `node --test "test/e2e/**/*.test.ts" test/cli/main.test.ts` with `ARTIFACT_CLI=<app>/node_modules/.bin/artifact`.
- The e2e helpers spawn `ARTIFACT_CLI` directly when it is set, which tests the shebang, the bin link and the exec bit. Otherwise they spawn `node src/cli/main.ts`.
- `test:pack` is not part of `pnpm check`: it needs a build and the npm registry, and takes tens of seconds. It is run before every release and in M5 verification.

## Consequences

Anything in the package that still points at `.ts`, or a missing asset, fails `test:pack`. The owner publishes with `npm publish` (`prepublishOnly` still runs check + build).

Update (release): `test:pack` also runs in CI on every pull request and push to `main`, and in the publish workflow before a version is published. Releases go through that workflow, not a manual `npm publish` (0049).

Update (M8): `src/runtime/` is excluded from the build, and `test:pack` also checks that no `dist/runtime/` ships, that the packed `dependencies` are exactly the v1 four with no `peerDependencies`, and that installing the tarball brings in no `@aws-sdk/*`, `aws-cdk-lib` or `constructs` (0059).
