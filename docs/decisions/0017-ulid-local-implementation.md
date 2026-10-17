# 0017. Local lowercase ULID implementation instead of the `ulid` package

Status: Accepted (M1)

## Context

Artifact ids are 26-char lowercase ULIDs (Crockford base32) so they work as DNS labels in `<id>.localhost`. The spec allows the `ulid` package "or a 20-line local impl".

## Decision

- `src/adapters/ulid.ts` implements it in about 20 lines. The first 10 chars encode the 48-bit millisecond time; the last 16 chars are random, from `crypto.getRandomValues`, with each byte masked to 5 bits, which is uniform because 256 is a multiple of 32. It emits lowercase directly.
- No monotonic counter within one millisecond. Listings sort by `updatedAt`, and uniqueness comes from 80 random bits; the service also retries on the rare id collision (0015).
- `createUlidIdGen()` implements the `IdGen` port. `isArtifactId` in `core/paths.ts` validates the format of every id the core accepts.

## Consequences

M1 adds no runtime dependency. The package stays free of `ulid` unless a later need, such as monotonic ids, justifies it.
