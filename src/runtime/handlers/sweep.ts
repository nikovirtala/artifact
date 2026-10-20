// The sweep Lambda (docs/decisions/0067), invoked daily by EventBridge Scheduler:
// `{task:"sweep"}` removes orphaned uploads (0047); `{task:"prune", keepLast?, olderThanMs?}`
// prunes old versions (0052). `pruneVersions` counts per-artifact failures as `skipped`, so the
// handler fails the run when any were skipped: Scheduler retries and the error alarm counts it.
import type { ArtifactService, PruneResult, SweepResult } from "../../core/artifact-service.ts";

export type SweepEvent =
  | { task: "sweep" }
  | { task: "prune"; keepLast?: number; olderThanMs?: number };

const invalid = () => new Error("artifact sweep: invalid event");

function parseEvent(event: unknown): SweepEvent {
  if (typeof event !== "object" || event === null || Array.isArray(event)) throw invalid();
  const { task, keepLast, olderThanMs, ...rest } = event as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalid();
  if (task === "sweep") {
    if (keepLast !== undefined || olderThanMs !== undefined) throw invalid();
    return { task };
  }
  if (task !== "prune" || (keepLast === undefined && olderThanMs === undefined)) throw invalid();
  if (
    keepLast !== undefined &&
    (typeof keepLast !== "number" || !Number.isSafeInteger(keepLast) || keepLast < 1)
  ) {
    throw invalid();
  }
  if (
    olderThanMs !== undefined &&
    (typeof olderThanMs !== "number" || !Number.isFinite(olderThanMs) || olderThanMs < 0)
  ) {
    throw invalid();
  }
  return { task, keepLast, olderThanMs };
}

export function createSweepHandler(deps: { service: ArtifactService }) {
  const { service } = deps;
  return async (event: unknown): Promise<SweepResult | PruneResult> => {
    const parsed = parseEvent(event);
    if (parsed.task === "sweep") {
      const { versions, folders } = await service.sweepOrphans();
      const result = { versions, folders };
      console.log(`artifact sweep ${JSON.stringify(result)}`);
      return result;
    }
    const pruned = await service.pruneVersions({
      keepLast: parsed.keepLast,
      olderThan: parsed.olderThanMs,
    });
    if (!pruned.ok) throw new Error(`artifact prune: ${pruned.error.message}`);
    const { artifacts, versions, skipped } = pruned.value;
    const result = { artifacts, versions, skipped };
    console.log(`artifact prune ${JSON.stringify(result)}`);
    if (skipped > 0) throw new Error(`artifact prune: skipped ${skipped} artifacts`);
    return result;
  };
}
