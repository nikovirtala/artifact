# Decision records

One short file per decision, numbered in order. Status is **Accepted** (in effect), **Proposed** (pending owner decision), or **Superseded by NNNN**. Add a new record rather than rewriting an accepted one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-toolchain-pinning.md) | Pin Node 24 and pnpm with mise and `packageManager` | Accepted |
| [0002](0002-typescript-7.md) | TypeScript 7 from the `typescript` package; `types: ["node"]` | Accepted |
| [0003](0003-test-runner.md) | `node --test` with a quoted glob, running `.ts` directly | Accepted |
| [0004](0004-core-import-boundary.md) | Enforce the core import boundary with a test | Accepted |
| [0005](0005-build-and-assets.md) | Build script, tolerant asset copy, no reload-client placeholder | Accepted |
| [0006](0006-package-entry.md) | Empty library entry `src/index.ts` behind `exports` | Accepted |
| [0007](0007-cli-m0-behaviour.md) | M0 CLI: usage only, no argument-parsing dependency | Accepted |
| [0008](0008-npm-name.md) | npm package name | Proposed |
| [0009](0009-default-port.md) | Default port 4400 | Proposed |
| [0010](0010-safari-localhost.md) | Safari and `*.localhost` | Proposed |
| [0011](0011-artifact-token-default.md) | `ARTIFACT_TOKEN` default | Proposed |
| [0012](0012-gallery-in-v1.md) | Gallery page in v1 | Proposed |
| [0013](0013-version-retention.md) | Version retention | Proposed |
| [0014](0014-port-shapes.md) | S3-shaped ports and typed error results | Accepted |
| [0015](0015-publish-protocol-and-conflicts.md) | Publish protocol: claim by `src/index.html`, retry without `ifVersion` | Accepted |
| [0016](0016-hashing.md) | SHA-256 via Web Crypto in the core | Accepted |
| [0017](0017-ulid-local-implementation.md) | Local lowercase ULID implementation instead of the `ulid` package | Accepted |
| [0018](0018-fs-store-atomicity-and-locking.md) | Filesystem store: exclusive create, rename-based CAS, in-process lock | Accepted |
| [0019](0019-path-rules-and-extensions.md) | Path rules and disallowed extensions | Accepted |
| [0020](0020-reload-injection.md) | Reload-snippet injection on bytes, replacing earlier injected tags | Accepted |
