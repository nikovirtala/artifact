# 0016. SHA-256 via Web Crypto in the core

Status: Accepted (M1)

## Context

Manifests record a `sha256` for every file. The core must not depend on Node-only modules where a web-standard API exists, so that it also runs unchanged on Lambda and other runtimes.

## Decision

- The core hashes with `crypto.subtle.digest("SHA-256", bytes)`, the global Web Crypto API available in Node 24. There is no `Hasher` port and no `node:crypto` import in `src/core/`.
- Adapters may use `node:crypto`. The fs store derives pointer etags from `createHash("sha256")` of the body.

## Consequences

Hashing is asynchronous and runs once per file at publish time, before anything is written. A port can be introduced later if a runtime without Web Crypto ever matters.
