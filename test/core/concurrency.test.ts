// Concurrent and randomised publishes: exactly one winner per version number, losers get the
// next number or version_conflict, and committed versions are never lost, duplicated or
// out of order. Runs against the memory store and the fs store.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import fc from "fast-check";
import { createFsStore } from "../../src/adapters/fs-store.ts";
import { createMemoryStore, type MemoryStore } from "../../src/adapters/memory-store.ts";
import { ArtifactService } from "../../src/core/artifact-service.ts";
import type { BlobStore, PointerStore } from "../../src/core/ports.ts";
import { fakeClock, fakeIdGen, recordingNotifier, unwrap } from "../support/fakes.ts";
import { assertConsistent, files, service } from "../support/publish-invariants.ts";

type Store = BlobStore & PointerStore;

const stores: { name: string; make(): Promise<{ store: Store; cleanup(): Promise<void> }> }[] = [
  { name: "memory", make: async () => ({ store: createMemoryStore(), cleanup: async () => {} }) },
  {
    name: "fs",
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), "artifact-concurrency-"));
      return {
        store: createFsStore({ root }),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
];

for (const { name, make } of stores) {
  describe(`concurrent publishes (${name} store)`, () => {
    it("without ifVersion: each loser moves to the next number; none lost or duplicated", async () => {
      const { store, cleanup } = await make();
      try {
        const { svc, notifier } = service(store, 100);
        const { id } = unwrap(await svc.publish({ files: { "index.html": "base" } }));
        const n = 24;
        const results = await Promise.all(
          Array.from({ length: n }, (_, i) => svc.publish({ id, files: files(i) })),
        );
        const { wins, committed, current } = await assertConsistent(
          svc,
          store,
          id,
          results.map((result, i) => ({ i, result })),
        );
        assert.equal(wins.length, n, "with enough attempts every publish lands");
        assert.equal(current, Math.max(...committed));
        assert.equal(notifier.events.length, n + 1);
      } finally {
        await cleanup();
      }
    });

    it("with ifVersion: exactly one wins; the rest get version_conflict", async () => {
      const { store, cleanup } = await make();
      try {
        const { svc } = service(store);
        const { id } = unwrap(await svc.publish({ files: { "index.html": "base" } }));
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, i) => svc.publish({ id, ifVersion: 1, files: files(i) })),
        );
        const { wins, current } = await assertConsistent(
          svc,
          store,
          id,
          results.map((result, i) => ({ i, result })),
        );
        assert.equal(wins.length, 1);
        for (const r of results) {
          if (!r.ok)
            assert.deepEqual(
              r.error.code === "version_conflict" && r.error.currentVersion,
              current,
            );
        }
      } finally {
        await cleanup();
      }
    });
  });
}

function scheduled(s: fc.Scheduler, store: MemoryStore): Store {
  return {
    get: s.scheduleFunction(store.get),
    put: s.scheduleFunction(store.put),
    list: s.scheduleFunction(store.list),
    delete: s.scheduleFunction(store.delete),
    read: s.scheduleFunction(store.read),
    write: s.scheduleFunction(store.write),
  };
}

describe("publish ordering properties", () => {
  it("property: any interleaving of publishes and rollbacks keeps versions consistent", async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant("publish" as const), ifVersion: fc.boolean() }),
      fc.record({ kind: fc.constant("rollback" as const) }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(op, { minLength: 2, maxLength: 6 }),
        async (s, ops) => {
          const store = createMemoryStore();
          const { id } = unwrap(
            await service(store).svc.publish({ files: { "index.html": "base" } }),
          );
          const { svc } = service(scheduled(s, store), 50);
          const tasks = ops.map((o, i) =>
            o.kind === "rollback"
              ? svc.rollback(id, 1).then(() => undefined)
              : svc.publish({ id, ifVersion: o.ifVersion ? 1 : undefined, files: files(i) }),
          );
          const settled = await s.waitFor(Promise.all(tasks));
          const outcomes = settled.flatMap((result, i) => (result ? [{ i, result }] : []));
          const { wins } = await assertConsistent(service(store).svc, store, id, outcomes);
          if (ops.every((o) => o.kind === "publish" && o.ifVersion)) {
            assert.equal(wins.length, 1, "exactly one ifVersion=1 publish wins");
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: sequential publishes, rollbacks and crashes keep versions strictly increasing", async () => {
    const op = fc.oneof(
      fc.constant({ kind: "publish" as const }),
      fc.constant({ kind: "crash" as const }),
      fc.nat({ max: 20 }).map((pick) => ({ kind: "rollback" as const, pick })),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 25 }), async (ops) => {
        const store = createMemoryStore();
        let crash = false;
        const pointers: PointerStore = {
          ...store,
          write: async (key, body, condition) => {
            if (crash) throw new Error("simulated crash");
            return store.write(key, body, condition);
          },
        };
        const svc = new ArtifactService({
          blobs: store,
          pointers,
          notifier: recordingNotifier(),
          clock: fakeClock(),
          ids: fakeIdGen(),
        });
        const { id } = unwrap(await svc.publish({ files: { "index.html": "base" } }));
        const published = [1];
        let current = 1;
        for (const o of ops) {
          if (o.kind === "publish") {
            const { version } = unwrap(await svc.publish({ id, files: { "index.html": "x" } }));
            assert.ok(version > Math.max(...published), `${version} after ${published}`);
            published.push(version);
            current = version;
          } else if (o.kind === "crash") {
            crash = true;
            await assert.rejects(svc.publish({ id, files: { "index.html": "orphan" } }));
            crash = false;
          } else {
            const target = published[o.pick % published.length];
            unwrap(await svc.rollback(id, target));
            current = target;
          }
          const details = unwrap(await svc.read(id));
          assert.deepEqual(
            details.versions.map((v) => v.version),
            published,
          );
          assert.equal(details.currentVersion, current);
        }
      }),
      { numRuns: 200 },
    );
  });
});
