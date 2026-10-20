# 0067. Daily sweep and prune schedules; `dataRetention`; prune failures fail the run

Status: Accepted (M9)

## Context

On AWS nothing runs `artifact serve`'s startup sweep (0047), and version pruning (0052) needs a trigger. The plan asks for an EventBridge Scheduler run of `sweepOrphans` every day, plus `pruneVersions` when `dataRetention.versions` is set (`docs/01-plan-aws.md`, "Data retention"). `pruneVersions` deliberately continues past an artifact it cannot prune and counts it in `skipped`, so a persistent failure (a missing `s3:DeleteObject`, say) would never surface on its own.

## Decision

- **One handler, two tasks** (`src/runtime/handlers/sweep.ts`, entry `src/runtime/entries/sweep.ts`):
  - `{"task":"sweep"}` runs `sweepOrphans()`, logs `artifact sweep {"versions":n,"folders":n}` and returns that object.
  - `{"task":"prune","keepLast"?,"olderThanMs"?}` (at least one; a positive integer and a non-negative number) runs `pruneVersions`, logs `artifact prune {"artifacts","versions","skipped"}` and returns exactly that `PruneResult`. **If `skipped > 0` it then throws** `artifact prune: skipped <n> artifacts`, so the run is a Lambda error.
  - Anything else throws `artifact sweep: invalid event`; a prune the core rejects as `invalid_input` throws too (misconfiguration).
- **Schedules** (the construct, 0071): a sweep schedule always, and a prune schedule only when `dataRetention.versions` is set, both `rate(1 day)` without a flexible window, invoking the sweep function with a fixed JSON input (`olderThan` as `olderThanMs`), 2 retries and a maximum event age of 1 hour. Scheduler invokes Lambda through an execution role that needs `lambda:InvokeFunction` on the function ([Scheduler templated targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-templated.html), A7 in the M9 AWS facts). The construct creates that role itself, inside its scope, and passes it to both targets.
- **`dataRetention`:** `onDestroy` (`RETAIN` by default, or `DESTROY`, which also empties the bucket) and `versions: {keepLast?, olderThan?}`; without `versions` every version is kept and no prune schedule exists.

## Consequences

Persistent prune failures become Lambda errors: Scheduler retries twice (prune is idempotent, since pruned versions are already gone from the pointer) and the sweep error alarm fires when `alarmEmail` is set. Overlapping runs are safe, because both operations use the pointer compare-and-swap and the 10-minute sweep age guard (0047, 0052). The core is unchanged.
