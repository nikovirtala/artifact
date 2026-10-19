// pruneVersions (docs/decisions/0052): keepLast AND olderThan, the current and the highest-numbered
// version are never pruned, the pointer moves first (CAS, retried) and the objects go after.
// Runs against the memory store and the fs store.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFsStore } from "../../src/adapters/fs-store.ts";
import { createMemoryStore } from "../../src/adapters/memory-store.ts";
import { ArtifactService, type PruneOptions } from "../../src/core/artifact-service.ts";
import type { Result } from "../../src/core/errors.ts";
import { metaKey } from "../../src/core/paths.ts";
import type { BlobStore, PointerStore } from "../../src/core/ports.ts";
import {
  type FakeClock,
  fakeClock,
  fakeIdGen,
  type RecordingNotifier,
  recordingNotifier,
  unwrap,
} from "../support/fakes.ts";

type Store = BlobStore & PointerStore;

const DAY = 24 * 60 * 60 * 1000;
const page = (n: number) => `<!doctype html><html><body>v${n}</body></html>`;

const stores: { name: string; make(): Promise<{ store: Store; cleanup(): Promise<void> }> }[] = [
  { name: "memory", make: async () => ({ store: createMemoryStore(), cleanup: async () => {} }) },
  {
    name: "fs",
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), "artifact-prune-"));
      return {
        store: createFsStore({ root }),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
];

type Setup = {
  store: Store;
  service: ArtifactService;
  clock: FakeClock;
  notifier: RecordingNotifier;
  /** Publish versions 1..n of a new artifact, advancing the clock by `gapMs` after each. */
  publishMany(
    n: number,
    gapMs?: number,
    extra?: { title?: string; project?: string },
  ): Promise<string>;
  versions(id: string): Promise<number[]>;
};

function setup(
  store: Store,
  wrap: { blobs?: BlobStore; pointers?: PointerStore } = {},
  clock = fakeClock(),
): Setup {
  const notifier = recordingNotifier();
  const service = new ArtifactService({
    blobs: wrap.blobs ?? store,
    pointers: wrap.pointers ?? store,
    notifier,
    clock,
    ids: fakeIdGen(),
  });
  return {
    store,
    service,
    clock,
    notifier,
    async publishMany(n, gapMs = DAY, extra = {}) {
      const { id } = unwrap(await service.publish({ ...extra, files: { "index.html": page(1) } }));
      clock.advance(gapMs);
      for (let v = 2; v <= n; v++) {
        unwrap(await service.publish({ id, files: { "index.html": page(v) } }));
        clock.advance(gapMs);
      }
      return id;
    },
    async versions(id) {
      return unwrap(await service.read(id)).versions.map((v) => v.version);
    },
  };
}

function errorOf(result: Result<unknown>): Record<string, unknown> {
  if (result.ok) throw new Error("expected an error result");
  return { ...result.error };
}

for (const { name, make } of stores) {
  describe(`pruneVersions (${name} store)`, () => {
    const withStore = (fn: (store: Store) => Promise<void>) => async () => {
      const { store, cleanup } = await make();
      try {
        await fn(store);
      } finally {
        await cleanup();
      }
    };

    it(
      "keepLast alone keeps the newest versions",
      withStore(async (store) => {
        const s = setup(store);
        const id = await s.publishMany(5);
        assert.deepEqual(unwrap(await s.service.pruneVersions({ keepLast: 2 })), {
          artifacts: 1,
          versions: 3,
          skipped: 0,
        });
        assert.deepEqual(await s.versions(id), [4, 5]);
      }),
    );

    it(
      "olderThan alone prunes versions created before now − olderThan",
      withStore(async (store) => {
        const s = setup(store);
        // Versions 1..4 are 30, 20, 10 and 0 days old.
        const id = await s.publishMany(4, 10 * DAY);
        s.clock.advance(-10 * DAY);
        assert.deepEqual(unwrap(await s.service.pruneVersions({ olderThan: 15 * DAY })), {
          artifacts: 1,
          versions: 2,
          skipped: 0,
        });
        assert.deepEqual(await s.versions(id), [3, 4]);
      }),
    );

    it(
      "keepLast and olderThan together prune only versions outside the newest and old",
      withStore(async (store) => {
        // Outside the newest 1, but younger than 15 days: version 2 is kept.
        const young = setup(store);
        const a = await young.publishMany(3, 10 * DAY); // 30, 20, 10 days old
        young.clock.advance(-10 * DAY); // now 20, 10, 0
        unwrap(await young.service.pruneVersions({ keepLast: 1, olderThan: 15 * DAY }));
        assert.deepEqual(await young.versions(a), [2, 3]);

        // Inside the newest 2, but old: version 4 is kept.
        const { store: other, cleanup } = await make();
        try {
          const old = setup(other);
          const b = await old.publishMany(4, 0); // all published now
          old.clock.advance(10 * DAY);
          unwrap(await old.service.publish({ id: b, files: { "index.html": page(5) } }));
          assert.deepEqual(
            unwrap(await old.service.pruneVersions({ keepLast: 2, olderThan: 5 * DAY })),
            { artifacts: 1, versions: 3, skipped: 0 },
          );
          assert.deepEqual(await old.versions(b), [4, 5]);
        } finally {
          await cleanup();
        }
      }),
    );

    it(
      "keeps the current version after a rollback, and it stays servable",
      withStore(async (store) => {
        const s = setup(store);
        const id = await s.publishMany(4);
        unwrap(await s.service.rollback(id, 1));
        unwrap(await s.service.pruneVersions({ keepLast: 1 }));
        assert.deepEqual(await s.versions(id), [1, 4]);
        assert.equal(unwrap(await s.service.read(id)).currentVersion, 1);
        const served = unwrap(await s.service.readServed(id, { path: "index.html" }));
        assert.equal(served.version, 1);
        unwrap(await s.service.rollback(id, 4));
        unwrap(await s.service.rollback(id, 1));
      }),
    );

    it(
      "never prunes the highest-numbered version, so its number is never reused",
      withStore(async (store) => {
        const s = setup(store);
        const id = await s.publishMany(4);
        unwrap(await s.service.rollback(id, 1));
        s.clock.advance(10 * DAY);
        assert.deepEqual(unwrap(await s.service.pruneVersions({ olderThan: DAY })), {
          artifacts: 1,
          versions: 2,
          skipped: 0,
        });
        assert.deepEqual(await s.versions(id), [1, 4]);
        const next = unwrap(await s.service.publish({ id, files: { "index.html": page(5) } }));
        assert.equal(next.version, 5);
      }),
    );

    it(
      "never loses a publish that commits while pruning (pointer CAS retry)",
      withStore(async (store) => {
        const racer = setup(store);
        const id = await racer.publishMany(5);
        let raced: number | undefined;
        const pointers: PointerStore = {
          read: (key) => store.read(key),
          delete: (key) => store.delete(key),
          write: async (key, body, condition) => {
            if ("ifMatch" in condition && raced === undefined) {
              raced = unwrap(
                await racer.service.publish({ id, files: { "index.html": page(6) } }),
              ).version;
            }
            return store.write(key, body, condition);
          },
        };
        const pruner = setup(store, { pointers });
        assert.deepEqual(unwrap(await pruner.service.pruneVersions({ keepLast: 2 })), {
          artifacts: 1,
          versions: 4,
          skipped: 0,
        });
        assert.equal(raced, 6);
        const details = unwrap(await racer.service.read(id));
        assert.deepEqual(
          details.versions.map((v) => v.version),
          [5, 6],
        );
        assert.equal(details.currentVersion, 6);
        unwrap(await racer.service.readServed(id, { path: "index.html", version: 6 }));
      }),
    );

    it(
      "removes every object of a pruned version, claim key last; reads report not_found",
      withStore(async (store) => {
        const deleted: string[] = [];
        const blobs: BlobStore = {
          get: (key) => store.get(key),
          put: (key, body, options) => store.put(key, body, options),
          list: (prefix, options) => store.list(prefix, options),
          delete: async (key) => {
            deleted.push(key);
            await store.delete(key);
          },
        };
        const s = setup(store, { blobs });
        const id = await s.publishMany(3);
        unwrap(
          await s.service.publish({
            id,
            files: { "index.html": page(4), "app.css": "p{}", "img/a.svg": "<svg/>" },
          }),
        );
        unwrap(await s.service.publish({ id, files: { "index.html": page(5) } }));
        unwrap(await s.service.pruneVersions({ keepLast: 1 }));
        assert.deepEqual(await s.versions(id), [5]);
        for (const n of [1, 2, 3, 4]) {
          assert.deepEqual((await store.list(`artifacts/${id}/v/${n}/`)).keys, [], `v${n}`);
          const notFound = [
            await s.service.readFile(id, { version: n }),
            await s.service.readManifest(id, n),
            await s.service.readServed(id, { version: n, path: "index.html" }),
            await s.service.rollback(id, n),
          ];
          for (const r of notFound) assert.equal(errorOf(r).code, "not_found");
        }
        const v4 = deleted.filter((k) => k.startsWith(`artifacts/${id}/v/4/`));
        assert.equal(v4.length, 7); // 3 src + 3 www + manifest
        assert.equal(v4.at(-1), `artifacts/${id}/v/4/src/index.html`);
        assert.ok((await store.list(`artifacts/${id}/v/5/`)).keys.length > 0);
        unwrap(await s.service.readServed(id, { path: "index.html" }));
      }),
    );

    it(
      "counts an artifact whose pointer swap keeps conflicting as skipped",
      withStore(async (store) => {
        const racer = setup(store);
        const contended = await racer.publishMany(3);
        const other = await racer.publishMany(3);
        const pointers: PointerStore = {
          read: (key) => store.read(key),
          delete: (key) => store.delete(key),
          write: async (key, body, condition) => {
            if ("ifMatch" in condition && key === metaKey(contended)) {
              unwrap(
                await racer.service.publish({ id: contended, files: { "index.html": page(0) } }),
              );
            }
            return store.write(key, body, condition);
          },
        };
        const pruner = setup(store, { pointers });
        assert.deepEqual(unwrap(await pruner.service.pruneVersions({ keepLast: 1 })), {
          artifacts: 1,
          versions: 2,
          skipped: 1,
        });
        assert.deepEqual((await racer.versions(contended)).slice(0, 3), [1, 2, 3]);
        assert.deepEqual(await racer.versions(other), [3]);
      }),
    );

    it(
      "counts an artifact whose object delete fails as skipped and goes on",
      withStore(async (store) => {
        let armed = false;
        const blobs: BlobStore = {
          get: (key) => store.get(key),
          put: (key, body, options) => store.put(key, body, options),
          list: (prefix, options) => store.list(prefix, options),
          delete: async (key) => {
            if (armed) {
              armed = false;
              throw new Error("delete failed");
            }
            await store.delete(key);
          },
        };
        const s = setup(store, { blobs });
        const a = await s.publishMany(3);
        const b = await s.publishMany(3);
        armed = true;
        assert.deepEqual(unwrap(await s.service.pruneVersions({ keepLast: 1 })), {
          artifacts: 1,
          versions: 2,
          skipped: 1,
        });
        assert.deepEqual(await s.versions(a), [3]);
        assert.deepEqual(await s.versions(b), [3]);
      }),
    );

    it(
      "counts an artifact whose pointer read fails as skipped and prunes the others",
      withStore(async (store) => {
        const s = setup(store);
        const a = await s.publishMany(3);
        const broken = await s.publishMany(3);
        const c = await s.publishMany(3);
        const pointers: PointerStore = {
          read: async (key) => {
            if (key === metaKey(broken)) throw new Error("pointer read failed");
            return store.read(key);
          },
          delete: (key) => store.delete(key),
          write: (key, body, condition) => store.write(key, body, condition),
        };
        const pruner = setup(store, { pointers });
        assert.deepEqual(unwrap(await pruner.service.pruneVersions({ keepLast: 1 })), {
          artifacts: 2,
          versions: 4,
          skipped: 1,
        });
        assert.deepEqual(await s.versions(a), [3]);
        assert.deepEqual(await s.versions(broken), [1, 2, 3]);
        assert.deepEqual(await s.versions(c), [3]);
        assert.ok((await store.list(`artifacts/${broken}/v/1/`)).keys.length > 0);
      }),
    );

    it(
      "emits no events",
      withStore(async (store) => {
        const s = setup(store);
        await s.publishMany(4);
        const before = s.notifier.events.length;
        unwrap(await s.service.pruneVersions({ keepLast: 1 }));
        assert.equal(s.notifier.events.length, before);
      }),
    );

    it(
      "rejects missing or invalid options with invalid_input",
      withStore(async (store) => {
        const s = setup(store);
        const id = await s.publishMany(3);
        const bad: PruneOptions[] = [
          {},
          { keepLast: 0 },
          { keepLast: -1 },
          { keepLast: 1.5 },
          { keepLast: Number.NaN },
          { olderThan: -1 },
          { olderThan: Number.NaN },
          { olderThan: Number.POSITIVE_INFINITY },
          { keepLast: 1, olderThan: -1 },
        ];
        for (const options of bad) {
          assert.equal(
            errorOf(await s.service.pruneVersions(options)).code,
            "invalid_input",
            JSON.stringify(options),
          );
        }
        assert.deepEqual(await s.versions(id), [1, 2, 3]);
      }),
    );

    it(
      "keeps every other field, and does not rewrite artifacts with nothing to prune",
      withStore(async (store) => {
        const s = setup(store);
        const id = await s.publishMany(3, DAY, { title: "T", project: "local:/work/app" });
        const untouched = await s.publishMany(1);
        const before = unwrap(await s.service.read(id));
        const etag = (await store.read(metaKey(untouched)))?.etag;
        s.clock.advance(DAY);
        assert.deepEqual(unwrap(await s.service.pruneVersions({ keepLast: 1 })), {
          artifacts: 1,
          versions: 2,
          skipped: 0,
        });
        const after = unwrap(await s.service.read(id));
        assert.deepEqual({ ...after, versions: undefined }, { ...before, versions: undefined });
        assert.deepEqual(after.versions, before.versions.slice(2));
        assert.equal((await store.read(metaKey(untouched)))?.etag, etag);
        assert.deepEqual(unwrap(await s.service.pruneVersions({ keepLast: 1 })), {
          artifacts: 0,
          versions: 0,
          skipped: 0,
        });
      }),
    );
  });
}
