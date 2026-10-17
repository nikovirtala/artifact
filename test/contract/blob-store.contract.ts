// Shared behaviour every BlobStore + PointerStore adapter must have (memory, fs, later S3).
// Not a *.test.ts file: adapter runners in this folder call `storeContract` with a factory.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { BlobStore, PointerStore } from "../../src/core/ports.ts";

export type StoreFixture = {
  blobs: BlobStore;
  pointers: PointerStore;
  cleanup(): Promise<void>;
};

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : new TextDecoder().decode(b);

const CONCURRENCY = 20;

export function storeContract(name: string, setup: () => Promise<StoreFixture>): void {
  describe(`${name} store`, () => contract(setup));
}

function contract(setup: () => Promise<StoreFixture>): void {
  let blobs: BlobStore;
  let pointers: PointerStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ blobs, pointers, cleanup } = await setup());
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("BlobStore contract", () => {
    it("get on an absent key returns undefined", async () => {
      assert.equal(await blobs.get("a/missing.txt"), undefined);
    });

    it("put then get round-trips bytes exactly", async () => {
      const body = new Uint8Array([0, 1, 2, 254, 255, 10, 13]);
      const result = await blobs.put("a/b/c.bin", body);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(typeof result.etag, "string");
      assert.deepEqual(await blobs.get("a/b/c.bin"), body);
    });

    it("round-trips an empty body", async () => {
      await blobs.put("empty.txt", new Uint8Array());
      assert.deepEqual(await blobs.get("empty.txt"), new Uint8Array());
    });

    it("stores and returns copies, isolated from caller mutation", async () => {
      const body = enc("abc");
      await blobs.put("k.txt", body);
      body[0] = 120;
      const got = await blobs.get("k.txt");
      assert.ok(got);
      got[1] = 120;
      assert.equal(dec(await blobs.get("k.txt")), "abc");
    });

    it("put without a condition overwrites", async () => {
      await blobs.put("k.txt", enc("one"));
      await blobs.put("k.txt", enc("two"));
      assert.equal(dec(await blobs.get("k.txt")), "two");
    });

    it("supports nested keys with dots, spaces and unicode", async () => {
      const key = "artifacts/x/v/1/src/.well-known/dir with space/ü.json";
      await blobs.put(key, enc("{}"));
      assert.equal(dec(await blobs.get(key)), "{}");
      assert.deepEqual((await blobs.list("artifacts/x/v/1/src/")).keys, [key]);
    });

    it("ifNoneMatch '*' creates only when absent", async () => {
      assert.equal((await blobs.put("m.json", enc("first"), { ifNoneMatch: "*" })).ok, true);
      assert.deepEqual(await blobs.put("m.json", enc("second"), { ifNoneMatch: "*" }), {
        ok: false,
        reason: "precondition_failed",
      });
      assert.equal(dec(await blobs.get("m.json")), "first");
    });

    it("concurrent create-only puts: exactly one wins and its body is stored", async () => {
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          blobs.put("race.json", enc(`body-${i}`), { ifNoneMatch: "*" }),
        ),
      );
      const winners = results.flatMap((r, i) => (r.ok ? [i] : []));
      assert.equal(winners.length, 1);
      for (const r of results) if (!r.ok) assert.equal(r.reason, "precondition_failed");
      assert.equal(dec(await blobs.get("race.json")), `body-${winners[0]}`);
    });

    it("list returns sorted keys with a plain string prefix", async () => {
      for (const key of ["a/b/y", "a/bc/x", "a/b/x", "a/a", "b/a", "ab"]) {
        await blobs.put(key, enc(key));
      }
      assert.deepEqual(await blobs.list("a/b"), {
        keys: ["a/b/x", "a/b/y", "a/bc/x"],
        commonPrefixes: [],
      });
      assert.deepEqual((await blobs.list("a/b/")).keys, ["a/b/x", "a/b/y"]);
      assert.deepEqual((await blobs.list("")).keys, [
        "a/a",
        "a/b/x",
        "a/b/y",
        "a/bc/x",
        "ab",
        "b/a",
      ]);
      assert.deepEqual(await blobs.list("zzz/"), { keys: [], commonPrefixes: [] });
    });

    it("list with a delimiter groups deeper keys into common prefixes", async () => {
      for (const key of ["p/1/a", "p/1/b/c", "p/2/a", "p/x", "q/1"]) {
        await blobs.put(key, enc(key));
      }
      assert.deepEqual(await blobs.list("p/", { delimiter: "/" }), {
        keys: ["p/x"],
        commonPrefixes: ["p/1/", "p/2/"],
      });
      assert.deepEqual(await blobs.list("", { delimiter: "/" }), {
        keys: [],
        commonPrefixes: ["p/", "q/"],
      });
      assert.deepEqual(await blobs.list("p/1", { delimiter: "/" }), {
        keys: [],
        commonPrefixes: ["p/1/"],
      });
    });

    it("delete removes a key; deleting an absent key is not an error", async () => {
      await blobs.put("d/1", enc("x"));
      await blobs.put("d/2", enc("y"));
      await blobs.delete("d/1");
      await blobs.delete("d/1");
      await blobs.delete("never/existed");
      assert.equal(await blobs.get("d/1"), undefined);
      assert.deepEqual((await blobs.list("d/")).keys, ["d/2"]);
    });

    it("a common prefix disappears once its last key is deleted", async () => {
      await blobs.put("r/a/deep/file", enc("x"));
      await blobs.put("r/b", enc("y"));
      await blobs.delete("r/a/deep/file");
      assert.deepEqual(await blobs.list("r/", { delimiter: "/" }), {
        keys: ["r/b"],
        commonPrefixes: [],
      });
      await blobs.put("r/a/deep/file", enc("again"));
      assert.equal(dec(await blobs.get("r/a/deep/file")), "again");
    });

    it("rejects malformed keys", async () => {
      for (const key of ["", "/abs", "a/../b", "a//b", "a/./b", "a\\b", "a\0b", "dir/"]) {
        await assert.rejects(blobs.put(key, enc("x")), Error, JSON.stringify(key));
        await assert.rejects(blobs.get(key), Error, JSON.stringify(key));
      }
    });
  });

  describe("PointerStore contract", () => {
    const key = "artifacts/p/meta.json";

    it("read on an absent key returns undefined", async () => {
      assert.equal(await pointers.read(key), undefined);
    });

    it("create-if-absent writes and read returns the body with the same etag", async () => {
      const created = await pointers.write(key, enc("v1"), { ifNoneMatch: "*" });
      assert.equal(created.ok, true);
      const read = await pointers.read(key);
      assert.ok(read && created.ok);
      assert.equal(dec(read.body), "v1");
      assert.equal(read.etag, created.etag);
    });

    it("create-if-absent fails when the pointer exists", async () => {
      await pointers.write(key, enc("v1"), { ifNoneMatch: "*" });
      assert.deepEqual(await pointers.write(key, enc("v2"), { ifNoneMatch: "*" }), {
        ok: false,
        reason: "precondition_failed",
      });
      assert.equal(dec((await pointers.read(key))?.body), "v1");
    });

    it("compare-and-swap with the current etag succeeds and changes the etag", async () => {
      await pointers.write(key, enc("v1"), { ifNoneMatch: "*" });
      const before = await pointers.read(key);
      assert.ok(before);
      const swapped = await pointers.write(key, enc("v2"), { ifMatch: before.etag });
      assert.equal(swapped.ok, true);
      const after = await pointers.read(key);
      assert.ok(after && swapped.ok);
      assert.equal(dec(after.body), "v2");
      assert.equal(after.etag, swapped.etag);
      assert.notEqual(after.etag, before.etag);
    });

    it("compare-and-swap with a stale etag fails and leaves the pointer unchanged", async () => {
      await pointers.write(key, enc("v1"), { ifNoneMatch: "*" });
      const stale = await pointers.read(key);
      assert.ok(stale);
      await pointers.write(key, enc("v2"), { ifMatch: stale.etag });
      assert.deepEqual(await pointers.write(key, enc("v3"), { ifMatch: stale.etag }), {
        ok: false,
        reason: "precondition_failed",
      });
      assert.equal(dec((await pointers.read(key))?.body), "v2");
    });

    it("compare-and-swap on an absent pointer fails", async () => {
      assert.deepEqual(await pointers.write(key, enc("v1"), { ifMatch: "anything" }), {
        ok: false,
        reason: "precondition_failed",
      });
      assert.equal(await pointers.read(key), undefined);
    });

    it("concurrent compare-and-swaps on one etag: exactly one wins", async () => {
      await pointers.write(key, enc("start"), { ifNoneMatch: "*" });
      const base = await pointers.read(key);
      assert.ok(base);
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          pointers.write(key, enc(`next-${i}`), { ifMatch: base.etag }),
        ),
      );
      const winners = results.flatMap((r, i) => (r.ok ? [i] : []));
      assert.equal(winners.length, 1);
      assert.equal(dec((await pointers.read(key))?.body), `next-${winners[0]}`);
    });

    it("concurrent create-if-absent: exactly one wins", async () => {
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          pointers.write(key, enc(`create-${i}`), { ifNoneMatch: "*" }),
        ),
      );
      const winners = results.flatMap((r, i) => (r.ok ? [i] : []));
      assert.equal(winners.length, 1);
      assert.equal(dec((await pointers.read(key))?.body), `create-${winners[0]}`);
    });

    it("chained compare-and-swaps never lose an update", async () => {
      await pointers.write(key, enc("0"), { ifNoneMatch: "*" });
      const increment = async () => {
        for (;;) {
          const current = await pointers.read(key);
          assert.ok(current);
          const next = String(Number(dec(current.body)) + 1);
          if ((await pointers.write(key, enc(next), { ifMatch: current.etag })).ok) return;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, increment));
      assert.equal(dec((await pointers.read(key))?.body), String(CONCURRENCY));
    });

    it("returns copies of the body", async () => {
      await pointers.write(key, enc("v1"), { ifNoneMatch: "*" });
      const read = await pointers.read(key);
      assert.ok(read);
      read.body[0] = 120;
      assert.equal(dec((await pointers.read(key))?.body), "v1");
    });

    it("delete removes the pointer so it can be created again", async () => {
      await pointers.write(key, enc("v1"), { ifNoneMatch: "*" });
      const etag = (await pointers.read(key))?.etag;
      assert.ok(etag);
      await pointers.delete(key);
      await pointers.delete(key);
      assert.equal(await pointers.read(key), undefined);
      assert.equal((await pointers.write(key, enc("v2"), { ifMatch: etag })).ok, false);
      assert.equal((await pointers.write(key, enc("v2"), { ifNoneMatch: "*" })).ok, true);
    });

    it("rejects malformed keys", async () => {
      for (const bad of ["", "/abs", "a/../b", "a\\b"]) {
        await assert.rejects(pointers.read(bad), Error, JSON.stringify(bad));
        await assert.rejects(pointers.write(bad, enc("x"), { ifNoneMatch: "*" }));
      }
    });
  });
}
