# 0015. Publish protocol: claim by `src/index.html`, retry without `ifVersion`

Status: Accepted (M1)

## Context

The spec orders writes `src/` → `www/` → `manifest.json` (create-only) → pointer CAS. It allocates version numbers from the pointer read at publish start. It leaves open whether a losing publisher gets `version_conflict` or the next number.

Following that order literally has a race. Two publishers that both read `latest = 3` both write `v/4/src/…` with plain puts. Only one wins the manifest, but the version directory can then hold a mix of both publishers' files.

## Decision

1. **Claim before writing.** `src/index.html` is required in every version, so it is written first with `If-None-Match: *`. Whoever creates it owns version `n`. The other files follow with plain puts in the spec's order: rest of `src/`, then `www/` (html injected), then `manifest.json` create-only. Then the pointer is compare-and-swapped. No object is added to the layout, and the stage order stays as specified.
2. **Conflict policy, chosen per call.**
   - Without `ifVersion` (last writer wins): a publisher that loses the claim on `n` tries `n + 1`. If the pointer CAS fails, it re-reads the pointer. It keeps its claimed number if that number is still above the newest committed version (for example after a rollback), otherwise it claims again above the newest. This is the spec's "next number" option.
   - With `ifVersion` (optimistic concurrency, HTTP `If-Match`): any read showing `currentVersion ≠ ifVersion` returns `version_conflict` with the current version.
   - Retries are bounded (`maxAttempts`, default 20 storage rounds). When they run out, the result is `version_conflict`.
3. **`meta.json` lists committed versions.** Alongside `currentVersion`, `title`, `createdAt` and `updatedAt`, the pointer holds `versions: [{ version, createdAt, label? }]`, oldest first. Lost claims and crashes can leave uncommitted numbers behind, so "a manifest exists" no longer means "committed". `read`, `readFile` and `rollback` only accept versions in this list, and the next number is allocated from its last entry. Rollback therefore never causes a number to be reused.
4. **Versions are strictly increasing, but can have gaps.** An orphan (from a crash, or a publisher overtaken between its claim and its CAS) keeps its number. It is never current, never listed, and is left for the M5 orphan sweep. Contiguous numbering would mean waiting on claims that may belong to a crashed process.
5. **Notify after commit, never fail because of it.** A `notify` error is swallowed: the pointer has moved, and reload clients recover by reconnecting and comparing versions (M3).
6. **Other service rules.** `ifVersion` is ignored on create. A create whose id collides retries with a fresh id. `title` is kept unless a publish passes a new one. `list` sorts by `updatedAt` descending, with ties broken by id descending. `delete` removes the pointer first (the artifact vanishes at once), then every key under `artifacts/<id>/`.

## Consequences

- Acceptance "exactly one wins per version number, the other gets `version_conflict` or the next number" holds by construction. `test/core/concurrency.test.ts` checks it under real concurrency on memory and fs, and under fast-check scheduled interleavings.
- After a crash or a lost race, version numbers can skip (for example 1, 3). The spec says "monotonic", not "contiguous".
- `meta.json` grows by one small entry per version. At local scale and with retention unlimited (0013), this is negligible.
- Deviation from the spec text: the extra `versions` field in `meta.json`, and `src/index.html` written create-only as the claim.

## Update (M2)

- When the retries run out, the `version_conflict` message says so: `version conflict: gave up after <N> attempts due to concurrent publishes (current version is <c>); retry the same request without if_version`. In M4 the `artifact_publish` tool description gives the same advice.
- `delete` stays pointer-first. The M5 orphan sweep must also remove `artifacts/<id>/` folders that have no `meta.json` (left by a crash during delete or before a first commit), skipping folders modified in the last few minutes so it never races a publish in progress.
- M3: consider a `deleted` SSE event so open tabs learn that their artifact is gone. Done in M3 ([0029](0029-deleted-event.md)).

## Update (M4 follow-up)

`meta.json` gains an optional `project` (the normalised identifier, [0039](0039-project-identifier-and-filtering.md)), written on create and never changed afterwards: an update with a different project keeps the stored one.

Update (M5): the sweep is implemented as described, with a 10-minute threshold ([0047](0047-orphan-sweep.md)).
