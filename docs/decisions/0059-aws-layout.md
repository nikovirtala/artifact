# 0059. S3 adapter in `src/runtime/`, dev tooling in a private `aws/` workspace

Status: Accepted (M8)

## Context

`docs/01-plan-aws.md` disagrees with itself about where M8's code goes. M8 says "`aws/` workspace" and `pnpm --filter aws dev:serve`. The Repo layout puts the S3 adapter at `src/runtime/adapters/s3-store.ts` inside the main package, lists only `examples/*` in `pnpm-workspace.yaml`, and has `scripts/bundle-assets.ts` (M9) bundle the Lambdas from `src/runtime/`. The published package must not change: runtime `dependencies` stay the v1 four, and no AWS package may reach the tarball (0048, 0050).

## Decision

- **The adapter lives in the main package at `src/runtime/adapters/s3-store.ts`**, where the Repo layout puts it and where M9 bundles it from. `src/runtime/` may import `@aws-sdk/*` (0050).
- **`src/runtime/` is never compiled into `dist/`.** `tsconfig.build.json` excludes it. The root typecheck (`tsconfig.json` includes `src`) still checks it, so **`@aws-sdk/client-s3` is a root devDependency**, pinned exactly. It is not a peer: the Lambdas use the SDK of the `nodejs24.x` runtime (V2, 0060).
- **A private workspace package `aws/`** (`"name": "aws"`, `"private": true`) holds dev tooling only: the dev harness (0062) and the test-resources CDK stack (0063). Its devDependencies are `@aws-sdk/client-s3`, `aws-cdk-lib`, `constructs`, `aws-cdk`, `typescript` and `@types/node`. It imports root sources by relative path (`../../src/...`), because the package exports only `package.json`. This makes the plan's `pnpm --filter aws dev:serve` work and keeps `aws-cdk-lib` out of the root manifest until M9 needs it for `src/cdk/`.
- **`pnpm-workspace.yaml`** lists `aws` and `examples/*`. `examples/*` matches nothing until M9 adds `examples/personal`.
- **Import boundaries** (`test/core/import-boundary.test.ts`), in addition to 0050:
  - `src/**` never imports a path that resolves into `aws/`: the shipped package must not depend on dev tooling.
  - `src/runtime/**` never imports `src/cdk/`, `aws-cdk-lib` or `constructs`: Lambda bundles must not pull in the CDK.
  - `aws/**` is dev-only and has no rules.
- **The pack test** also asserts that no `dist/runtime/` ships, that the packed `dependencies` are exactly the v1 four with no `peerDependencies`, and that installing the tarball brings in none of `@aws-sdk/*`, `aws-cdk-lib` or `constructs`.
- **`pnpm check`** becomes `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter aws check`, so CI, `prepublishOnly` and `git rebase --exec` cover the workspace once it exists.

### Alternatives

- Everything in the root package: puts `aws-cdk-lib` into the root dev deps a milestone early and loses `--filter aws`.
- A separate S3 adapter package: moves the adapter away from `src/runtime/`, where M9 bundles it.

## Consequences

The published package is unchanged. The S3 adapter is type-checked, linted and tested with the root, and bundled from source in M9. Dev tooling that needs the CDK stays in `aws/`, and M9 moves `aws-cdk-lib` and `constructs` to the root (as peers) when `src/cdk/` arrives.
