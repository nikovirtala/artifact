# 0052. Version pruning in the core: `pruneVersions`

Status: Accepted (M7)

## Context

Locally every committed version is kept (0013). The AWS deployment (`docs/01-plan-aws.md`, code change 9) offers configurable retention (`dataRetention.versions`), run by a scheduled job next to the orphan sweep (0047). Pruning removes committed versions, so it must not race publishes, rollbacks or deletes, and must never break a URL a viewer may still have open on the current version.

## Decision

- `ArtifactService.pruneVersions({keepLast?, olderThan?}): Promise<Result<PruneResult>>`, with `PruneResult = {artifacts, versions, skipped}` (pointers rewritten, versions removed, artifacts given up on).
- `keepLast` is a positive integer; `olderThan` is a non-negative finite number of milliseconds, compared with the service clock: a version is old when `createdAt < now − olderThan`. Neither option, or an invalid value, is `invalid_input`.
- A version is pruned when it is outside the newest `keepLast` (by version number) **and** old. With one option, that one decides.
- Never pruned: the current version, and the highest-numbered committed version. The second rule goes beyond the plan: publish numbers from the latest committed version (0015), so pruning it would let the next publish reuse a number whose `/v/<n>/` URL was served as immutable.
- Order, per artifact (ids iterated as `sweepOrphans` does): compare-and-swap the pointer with the victims removed from `versions`, every other field (`updatedAt` included) unchanged. On a failed swap, re-read and recompute, up to `maxAttempts`, then skip the artifact and count it in `skipped`. Then delete each victim's `v/<n>/` objects, the claim key `v/<n>/src/index.html` last (as in 0047). Any other failure on one artifact (a pointer read or write error, a failed list or delete) stops that artifact, counts it in `skipped` and moves on to the next, so one bad artifact does not hide the rest of the run. An artifact with nothing to prune is not rewritten.
- Only the initial listing of artifact ids under `artifacts/` can reject `pruneVersions`: when it fails there is nothing to iterate, so the storage error propagates.
- No events: the current version does not change, so no open tab needs to reload.
- Local `serve` does not call it; keep-all retention (0013) still holds for v1.

## Consequences

A publish or rollback racing a prune is never lost: whichever swap lands second re-reads the pointer. Once the pointer is swapped, a pruned version reads as `not_found`, even while its objects are still being deleted. A crash between the swap and the deletes leaves uncommitted objects behind, which the orphan sweep removes (0047).
