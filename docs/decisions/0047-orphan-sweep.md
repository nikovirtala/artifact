# 0047. Orphan sweep on `serve` startup

Status: Accepted (M5)

## Context

A crash or a lost race leaves uncommitted version directories (0015). A crash during a first publish or a delete leaves `artifacts/<id>/` without `meta.json`. Neither is ever served, but both use disk. The sweep must never race an in-flight publish, so it needs object ages. `BlobStore.list` had none.

## Decision

- **Port.** `ListResult` gains `objects: {key, lastModified: Date}[]`, in the same order as `keys` (S3 `ListObjectsV2` `Contents[].LastModified`). The memory store records the time of each write (an injectable `now`, for the fake clock). The fs store reports file `mtime`. The contract suite checks it.
- **Core.** `ArtifactService.sweepOrphans({minAgeMs = SWEEP_MIN_AGE_MS})`, with `SWEEP_MIN_AGE_MS = 10 min` and the service clock, returns `{versions, folders}`. For every `artifacts/<id>/` with a valid id:
  - without a pointer, if every object is older than the threshold, the pointer is re-checked and then every object is deleted (one folder);
  - with a pointer, each `v/<n>/` whose `n` is not in `meta.json` `versions` and whose newest object is older than the threshold is deleted after re-reading the pointer (one version). Its claim key `v/<n>/src/index.html` is deleted last, so no publisher can claim `n` while it is being emptied.
  - Committed versions, pointers, other keys and folders with non-id names are never touched. Keep-all retention (0013) is unchanged.
- **serve** runs the sweep after taking the lock and before listening. If anything was removed it prints `artifact: orphan sweep removed <n> uncommitted version(s) and <m> folder(s) without meta.json`. A sweep error prints a warning and startup continues. There is no flag: the threshold is a constant.

## Consequences

An orphan is removed at the first restart at least 10 minutes after its last write. A publish that takes longer than 10 minutes between its first write and its commit could lose an uncommitted version. That is unrealistic at 64 MB on local disk, and such a publish would retry anyway. The S3 adapter (M6) maps `LastModified` directly.
