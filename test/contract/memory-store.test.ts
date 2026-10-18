import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStore } from "../../src/adapters/memory-store.ts";
import { storeContract } from "./blob-store.contract.ts";

storeContract("memory", async () => {
  const store = createMemoryStore();
  return { blobs: store, pointers: store, cleanup: async () => {} };
});

describe("memory store clock", () => {
  it("reports the injected now as lastModified", async () => {
    let t = Date.UTC(2026, 0, 1);
    const store = createMemoryStore({ now: () => new Date(t) });
    await store.put("a/1", new Uint8Array([1]));
    t += 5000;
    await store.put("a/2", new Uint8Array([2]));
    const { objects } = await store.list("a/");
    assert.deepEqual(objects, [
      { key: "a/1", lastModified: new Date(Date.UTC(2026, 0, 1)) },
      { key: "a/2", lastModified: new Date(Date.UTC(2026, 0, 1) + 5000) },
    ]);
  });
});
