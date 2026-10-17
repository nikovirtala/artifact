# 0013. Version retention

Status: Proposed (pending owner decision)

## Question

Keep every version forever locally, or cap the number kept per artifact?

## Recommendation

Keep all versions in v1. Artifacts are small HTML sets, immutable versions are what make pinned URLs and rollback safe, and a cap would add a deletion path to the core before anyone needs one. Revisit if disk use becomes a problem: an explicit `artifact prune <id> --keep N` would be safer than automatic deletion. The orphan sweep (M5) only removes versions that were never pointed to.
