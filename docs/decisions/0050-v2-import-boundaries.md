# 0050. Import boundaries for the AWS code

Status: Accepted (M7)

## Context

v2 adds an AWS deployment (`docs/01-plan-aws.md`): CDK constructs in `src/cdk/` and Lambda handlers in `src/runtime/`. The local v1 package must keep working without `aws-cdk-lib` or the AWS SDK installed, and the constructs must deploy built handler assets rather than pull handler sources into the CDK app. Code change 8 of the plan asks for these rules to be enforced by a test, before any of that code exists.

## Decision

- `test/core/import-boundary.test.ts` gains a `v2 import boundaries` suite. The existing `core/` rules (0003) are unchanged.
- v1 code is `src/{core,http,mcp,cli,adapters}/**/*.ts` and the top-level `src/*.ts` files (`config.ts`, `schemas.ts`, `index.ts`). It never imports a relative path that resolves into `src/cdk/` or `src/runtime/`, nor `aws-cdk-lib` (or a subpath), nor `@aws-sdk/*`.
- The one exception: `src/cli/token.ts` may load `@aws-sdk/*` through a dynamic `import()`, so the SDK stays optional for local use. A static import there is still a violation.
- `src/cdk/**` never imports `src/runtime/**`; it references the built assets only. The check passes vacuously until `src/cdk/` exists.
- Static, re-export and dynamic forms are detected with the existing specifier pattern; synthetic sources test the detector itself.

## Consequences

An AWS import in v1 code, or a source import from the constructs into the handlers, fails `pnpm check`. The rules cost nothing at runtime and need no new dependency.
