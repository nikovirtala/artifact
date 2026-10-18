# 0018. Filesystem store: exclusive create, rename-based CAS, in-process lock

Status: Accepted (M1)

## Context

The spec requires the local pointer update to be "temp file + rename under a per-id lock" and creates to have `If-None-Match: *` semantics. The tree on disk should match the S3 key layout.

## Decision

- Key `a/b/c` is the file `<root>/a/b/c`. Temp files live in `<root>/.tmp/`, on the same filesystem as the target so `rename` is atomic. `.tmp` is rejected as a key and skipped by `list`. The root comes from the caller; the `~/.artifacts/` default belongs to `config.ts` (M2/M5).
- **Create-only put:** `open(path, "wx")`, which fails with `EEXIST` if the file exists. On a write error the file is removed. A reader could see a partially written file while it is being created, but the service never reads a version before its pointer commit, so this does not matter.
- **Plain put:** write a temp file, then `rename` it over the target. Readers see the old bytes or the new ones.
- **Pointer CAS:** under a lock on the pointer file, read the file, compare `sha256(body)` with the expected etag, then do the temp-file-and-rename write. The etag is a content hash, like S3's: if the content is identical, the state is identical, so ABA cannot cause harm.
- **Lock:** an in-process promise chain per absolute file path, shared by every store instance in the process. One server process per root is assumed. The spec routes every client (CLI, MCP) through the running server, so nothing else writes the root. A lock file was rejected because a crash could leave it stale, and breaking stale locks safely is hard. A root-level single-instance guard can be added at `serve` startup (M2) if needed. (M2 adds it as `<root>/.lock`, with stale-pid takeover; see 0026.)
- **Directories:** `delete` prunes empty parent directories, so deleted prefixes do not linger. Writers retry `mkdir` if a prune races them. Delimiter listing only reports directories that contain a file, matching S3, where empty "directories" do not exist.

## Consequences

Two server processes on the same root could interleave pointer writes. That setup is unsupported. Every operation passes the shared contract suite (`test/contract/fs-store.test.ts`).

Update (M5): `list` reports each file's `mtime` as `lastModified` (one `stat` per listed file). The orphan sweep deletes through the store, so pruning removes emptied version and artifact directories ([0047](0047-orphan-sweep.md)).
