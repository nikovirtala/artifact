// The sweep Lambda handler (docs/decisions/0067): the daily orphan sweep and the version prune;
// a prune that skips artifacts fails the run so Scheduler retries and alarms count it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStore } from "../../src/adapters/memory-store.ts";
import { ArtifactService, SWEEP_MIN_AGE_MS } from "../../src/core/artifact-service.ts";
import type { BlobStore } from "../../src/core/ports.ts";
import { createSweepHandler } from "../../src/runtime/handlers/sweep.ts";
import { fakeClock, fakeIdGen, harness, recordingNotifier, unwrap } from "../support/fakes.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** Console lines written while `fn` runs. */
async function logged<T>(fn: () => Promise<T>): Promise<{ lines: string[]; result: T | Error }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    return { lines, result: await fn() };
  } catch (error) {
    return { lines, result: error as Error };
  } finally {
    console.log = original;
  }
}

async function publishVersions(service: ArtifactService, n: number, id?: string) {
  let current = id;
  for (let i = 1; i <= n; i++) {
    current = unwrap(
      await service.publish({ id: current, files: { "index.html": `<p>${i}</p>` } }),
    ).id;
  }
  return current as string;
}

describe("sweep handler", () => {
  it("sweeps an old orphan and returns {versions, folders}", async () => {
    const { service, store, clock } = harness();
    const id = await publishVersions(service, 1);
    await store.put(`artifacts/${id}/v/2/src/index.html`, enc("orphan"));
    clock.advance(SWEEP_MIN_AGE_MS + 60_000);
    const { lines, result } = await logged(() =>
      createSweepHandler({ service })({ task: "sweep" }),
    );
    assert.deepEqual(result, { versions: 1, folders: 0 });
    assert.deepEqual(lines, ['artifact sweep {"versions":1,"folders":0}']);
  });

  it("prunes with keepLast 2 after a rollback to v1, keeping the current version", async () => {
    const { service } = harness();
    const id = await publishVersions(service, 4);
    unwrap(await service.rollback(id, 1));
    const { lines, result } = await logged(() =>
      createSweepHandler({ service })({ task: "prune", keepLast: 2 }),
    );
    assert.deepEqual(result, { artifacts: 1, versions: 1, skipped: 0 });
    assert.deepEqual(lines, ['artifact prune {"artifacts":1,"versions":1,"skipped":0}']);
    const details = unwrap(await service.read(id));
    assert.deepEqual(
      details.versions.map((v) => v.version),
      [1, 3, 4],
    );
    assert.equal(details.currentVersion, 1);
    const v2 = await service.readManifest(id, 2);
    assert.equal(v2.ok, false);
    assert.equal(v2.ok ? undefined : v2.error.code, "not_found");
  });

  it("passes olderThanMs as olderThan", async () => {
    const { service, clock } = harness();
    const id = await publishVersions(service, 3);
    clock.advance(10_000);
    const handler = createSweepHandler({ service });
    const { result } = await logged(() => handler({ task: "prune", olderThanMs: 20_000 }));
    assert.deepEqual(result, { artifacts: 0, versions: 0, skipped: 0 });
    const { result: pruned } = await logged(() => handler({ task: "prune", olderThanMs: 5_000 }));
    assert.deepEqual(pruned, { artifacts: 1, versions: 2, skipped: 0 });
    assert.deepEqual(
      unwrap(await service.read(id)).versions.map((v) => v.version),
      [3],
    );
  });

  it("logs the result and fails the run when an artifact is skipped", async () => {
    const clock = fakeClock();
    const store = createMemoryStore({ now: () => clock.now() });
    let failFor = "";
    const blobs: BlobStore = Object.create(store);
    blobs.delete = async (key) => {
      if (failFor && key.includes(failFor)) throw new Error("AccessDenied");
      return store.delete(key);
    };
    const service = new ArtifactService({
      blobs,
      pointers: store,
      notifier: recordingNotifier(),
      clock,
      ids: fakeIdGen(),
    });
    failFor = await publishVersions(service, 3);
    await publishVersions(service, 3);
    const { lines, result } = await logged(() =>
      createSweepHandler({ service })({ task: "prune", keepLast: 1 }),
    );
    assert.deepEqual(lines, ['artifact prune {"artifacts":1,"versions":2,"skipped":1}']);
    assert.ok(result instanceof Error);
    assert.equal(result.message, "artifact prune: skipped 1 artifacts");
  });

  it("throws on invalid events", async () => {
    const handler = createSweepHandler({ service: harness().service });
    for (const event of [
      undefined,
      null,
      "sweep",
      {},
      { task: "nope" },
      { task: "prune" },
      { task: "prune", keepLast: 0 },
      { task: "prune", keepLast: -1 },
      { task: "prune", keepLast: 1.5 },
      { task: "prune", olderThanMs: -1 },
      { task: "prune", olderThanMs: "1" },
      { task: "sweep", extra: 1 },
    ]) {
      await assert.rejects(handler(event), /artifact sweep: invalid event/, JSON.stringify(event));
    }
  });
});
