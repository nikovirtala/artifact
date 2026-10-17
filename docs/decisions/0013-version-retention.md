# 0013. Version retention

Status: Accepted (M2)

## Question

Keep every version forever locally, or cap the number kept per artifact?

## Decision

Keep all versions in v1. Artifacts are small HTML sets, immutable versions are what make pinned URLs and rollback safe, and a cap would add a deletion path to the core before anyone needs one. If disk use becomes a problem, add an explicit `artifact prune <id> --keep N` later rather than automatic deletion. The orphan sweep (M5) only removes versions that were never committed.
