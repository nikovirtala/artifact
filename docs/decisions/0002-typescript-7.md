# 0002. TypeScript 7 from the `typescript` package; `types: ["node"]`

Status: Accepted (M0)

## Context

The spec asks for TypeScript 7 as a type-checker only. TS 7 is the native (Go) compiler. Its preview shipped as `@typescript/native-preview` (binary `tsgo`), so the package and binary names had to be checked.

## Decision

- Use `typescript@7.0.2` (npm `latest`). It ships the native compiler as the regular `tsc` binary, with per-platform optional dependencies (`@typescript/typescript-<os>-<arch>`). We need neither `@typescript/native-preview` nor `tsgo`.
- `tsconfig.json` holds the spec essentials (`module: nodenext`, `target: esnext`, `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`), plus two additions:
  - `"types": ["node"]`. In TS 7, `types` defaults to `[]`, so `@types/node` is not picked up on its own and every `node:*` import fails with TS2591.
  - `"include": ["src", "test", "scripts"]`, so tests and build scripts are type-checked as well.
- `@types/node` is held to `^24` to match the runtime major.

## Consequences

These two additions are the only deviations from "exactly the spec essentials". `tsconfig.build.json` limits itself to `src`.
