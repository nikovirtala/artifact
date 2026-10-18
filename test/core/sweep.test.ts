import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArtifactService, SWEEP_MIN_AGE_MS } from "../../src/core/artifact-service.ts";
import type { BlobStore } from "../../src/core/ports.ts";
import { fakeIdGen, harness, recordingNotifier, unwrap } from "../support/fakes.ts";

const MINUTE = 60 * 1000;
const enc = (s: string) => new TextEncoder().encode(s);
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
/** A valid artifact id that the fake id generator does not hand out in these tests. */
const FRESH = `${"0".repeat(25)}z`;

async function publishOne(service: ArtifactService, id?: string): Promise<string> {
  return unwrap(await service.publish({ id, files: { "index.html": page("v") } })).id;
}

/** Plant the files a crashed publish of `version` leaves behind. */
async function plantVersion(store: BlobStore, id: string, version: number): Promise<string[]> {
  const v = `artifacts/${id}/v/${version}`;
  const keys = [`${v}/src/index.html`, `${v}/src/app.css`, `${v}/www/index.html`];
  for (const key of keys) await store.put(key, enc(key));
  return keys;
}

async function snapshot(store: BlobStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const key of (await store.list("")).keys) {
    out.set(key, new TextDecoder().decode(await store.get(key)));
  }
  return out;
}

describe("ArtifactService.sweepOrphans", () => {
  it("removes an old uncommitted version, every key of it", async () => {
    const { service, store, clock } = harness();
    const id = await publishOne(service);
    await plantVersion(store, id, 2);
    clock.advance(SWEEP_MIN_AGE_MS + MINUTE);
    assert.deepEqual(await service.sweepOrphans(), { versions: 1, folders: 0 });
    assert.deepEqual((await store.list(`artifacts/${id}/v/2/`)).keys, []);
    assert.ok((await store.list(`artifacts/${id}/v/1/`)).keys.length > 0);
  });

  it("keeps a recent uncommitted version, and one whose newest object is recent", async () => {
    const { service, store, clock } = harness();
    const id = await publishOne(service);
    const mixed = await plantVersion(store, id, 3);
    clock.advance(SWEEP_MIN_AGE_MS + MINUTE);
    const recent = await plantVersion(store, id, 2);
    await store.put(`artifacts/${id}/v/3/manifest.json`, enc("{}"));
    assert.deepEqual(await service.sweepOrphans(), { versions: 0, folders: 0 });
    for (const key of [...recent, ...mixed]) assert.ok(await store.get(key), key);
  });

  it("never touches committed versions or the pointer", async () => {
    const { service, store, clock } = harness();
    const id = await publishOne(service);
    await publishOne(service, id);
    unwrap(await service.rollback(id, 1));
    const before = await snapshot(store);
    await plantVersion(store, id, 5);
    clock.advance(60 * MINUTE);
    assert.deepEqual(await service.sweepOrphans(), { versions: 1, folders: 0 });
    assert.deepEqual(await snapshot(store), before);
  });

  it("removes an old folder without meta.json and keeps a recent one", async () => {
    const { service, store, clock } = harness();
    await store.put(`artifacts/${FRESH}/v/1/src/index.html`, enc("x"));
    await store.put(`artifacts/${FRESH}/v/1/manifest.json`, enc("{}"));
    clock.advance(SWEEP_MIN_AGE_MS + MINUTE);
    const recent = `${"0".repeat(25)}y`;
    await store.put(`artifacts/${recent}/v/1/src/index.html`, enc("y"));
    assert.deepEqual(await service.sweepOrphans(), { versions: 0, folders: 1 });
    assert.deepEqual((await store.list(`artifacts/${FRESH}/`)).keys, []);
    assert.deepEqual((await store.list(`artifacts/${recent}/`)).keys, [
      `artifacts/${recent}/v/1/src/index.html`,
    ]);
  });

  it("keeps a folder without meta.json while any object in it is recent", async () => {
    const { service, store, clock } = harness();
    await store.put(`artifacts/${FRESH}/v/1/src/index.html`, enc("x"));
    clock.advance(SWEEP_MIN_AGE_MS + MINUTE);
    await store.put(`artifacts/${FRESH}/v/1/www/index.html`, enc("x"));
    assert.deepEqual(await service.sweepOrphans(), { versions: 0, folders: 0 });
    assert.equal((await store.list(`artifacts/${FRESH}/`)).keys.length, 2);
  });

  it("leaves non-id folders, non-canonical version names and other keys alone", async () => {
    const { service, store, clock } = harness();
    const id = await publishOne(service);
    const untouched = [
      "artifacts/not-an-id/v/1/src/index.html",
      `artifacts/${FRESH.toUpperCase()}/v/1/src/index.html`,
      `artifacts/${id}/v/01/src/index.html`,
      `artifacts/${id}/v/x/src/index.html`,
      `artifacts/${id}/notes.txt`,
      "elsewhere/v/9/src/index.html",
    ];
    for (const key of untouched) await store.put(key, enc(key));
    clock.advance(60 * MINUTE);
    assert.deepEqual(await service.sweepOrphans(), { versions: 0, folders: 0 });
    for (const key of untouched) assert.ok(await store.get(key), key);
  });

  it("counts every removed version and folder", async () => {
    const { service, store, clock } = harness();
    const a = await publishOne(service);
    const b = await publishOne(service);
    await plantVersion(store, a, 2);
    await plantVersion(store, a, 7);
    await plantVersion(store, b, 2);
    await plantVersion(store, FRESH, 1);
    await plantVersion(store, `${"0".repeat(25)}y`, 1);
    clock.advance(SWEEP_MIN_AGE_MS);
    assert.deepEqual(await service.sweepOrphans(), { versions: 3, folders: 2 });
    assert.deepEqual(await service.sweepOrphans(), { versions: 0, folders: 0 });
  });

  it("deletes the claim key of a version last", async () => {
    const h = harness();
    const deleted: string[] = [];
    const blobs: BlobStore = {
      get: (key) => h.store.get(key),
      put: (key, body, options) => h.store.put(key, body, options),
      list: (prefix, options) => h.store.list(prefix, options),
      delete: async (key) => {
        deleted.push(key);
        await h.store.delete(key);
      },
    };
    const service = new ArtifactService({
      blobs,
      pointers: h.store,
      notifier: recordingNotifier(),
      clock: h.clock,
      ids: fakeIdGen(),
    });
    const id = await publishOne(service);
    const planted = await plantVersion(h.store, id, 2);
    await h.store.put(`artifacts/${id}/v/2/manifest.json`, enc("{}"));
    h.clock.advance(SWEEP_MIN_AGE_MS + MINUTE);
    assert.deepEqual(await service.sweepOrphans(), { versions: 1, folders: 0 });
    assert.equal(deleted.length, planted.length + 1);
    assert.equal(deleted.at(-1), `artifacts/${id}/v/2/src/index.html`);
  });

  it("honours a custom minAgeMs", async () => {
    const { service, store, clock } = harness();
    const id = await publishOne(service);
    await plantVersion(store, id, 2);
    clock.advance(2000);
    assert.deepEqual(await service.sweepOrphans(), { versions: 0, folders: 0 });
    assert.deepEqual(await service.sweepOrphans({ minAgeMs: 1000 }), { versions: 1, folders: 0 });
  });
});
