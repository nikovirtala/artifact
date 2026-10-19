# 0061. `list` on S3: one LIST page per 1,000 artifacts plus one `GET meta.json` per artifact; index threshold

Status: Accepted (M8)

## Context

`service.list()` lists the common prefixes under `artifacts/` and then reads every `meta.json` (plan gap 6). On the fs store that is cheap. On S3 every read is a request, and the plan asks M8 to record the cost and when an index (DynamoDB, later work) becomes worth it.

## Decision

- **Cost.** For N artifacts, `service.list()` makes ⌈N/1000⌉ `ListObjectsV2` requests (with `delimiter: "/"` each artifact is one common prefix, and a page holds 1,000) plus N `GetObject` requests for `meta.json`. The GETs run in parallel (`Promise.all`); the SDK's socket pool bounds the concurrency. Filtering by project, sorting and `limit` happen after all pointers are read, so they do not reduce the count. `test/runtime/s3-list-cost.test.ts` pins these numbers on the fake endpoint (1 LIST + 5 GETs for 5 artifacts; 3 LIST pages with a page size of 2).
- **Money is negligible, latency is the cost.** At personal scale (hundreds of artifacts, a few lists a day) the request charges are fractions of a cent per month. The latency is one LIST round trip plus the slowest of N parallel GETs, and it grows once N exceeds the socket pool.
- **Threshold.** Add an index (a DynamoDB table of artifact summaries, written with the pointer move) when either holds, whichever comes first:
  - a deployment holds more than **1,000 artifacts**, so `list` needs a second LIST page; or
  - the measured `list` p95 in the control Lambda exceeds **1 s**.
- Until then S3 stays the only state; no index is built in M8–M11.

## Consequences

The S3 layout needs no second store for now. The control Lambda's `list` duration (from its logs and metrics) is the signal to watch. Crossing a threshold means new work: the index, its backfill and its consistency with the pointer CAS.
