import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFsStore } from "../../src/adapters/fs-store.ts";
import { storeContract } from "./blob-store.contract.ts";

const tempRoot = () => mkdtemp(join(tmpdir(), "artifact-fs-store-"));

storeContract("fs", async () => {
  const root = await tempRoot();
  const store = createFsStore({ root });
  return {
    blobs: store,
    pointers: store,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describe("fs store on disk", () => {
  it("lays keys out as files under the root and leaves no temp files", async () => {
    const root = await tempRoot();
    try {
      const store = createFsStore({ root });
      await store.put("artifacts/x/v/1/src/index.html", new TextEncoder().encode("<p>hi</p>"));
      await store.write("artifacts/x/meta.json", new TextEncoder().encode("{}"), {
        ifNoneMatch: "*",
      });
      assert.equal(
        await readFile(join(root, "artifacts/x/v/1/src/index.html"), "utf8"),
        "<p>hi</p>",
      );
      assert.equal(await readFile(join(root, "artifacts/x/meta.json"), "utf8"), "{}");
      assert.deepEqual(await readdir(join(root, ".tmp")), []);
      assert.deepEqual((await store.list("")).keys, [
        "artifacts/x/meta.json",
        "artifacts/x/v/1/src/index.html",
      ]);
      await assert.rejects(store.put(".tmp/x", new Uint8Array()), TypeError);
      await assert.rejects(store.put(".lock", new Uint8Array()), TypeError);
      await assert.rejects(store.get(".lock/x"), TypeError);
      await writeFile(join(root, ".lock"), "{}");
      assert.deepEqual((await store.list("")).keys, [
        "artifacts/x/meta.json",
        "artifacts/x/v/1/src/index.html",
      ]);
      assert.deepEqual(await store.list("", { delimiter: "/" }), {
        keys: [],
        commonPrefixes: ["artifacts/"],
      });
      assert.deepEqual((await store.list(".l", { delimiter: "/" })).keys, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serialises compare-and-swap across store instances on one root", async () => {
    const root = await tempRoot();
    try {
      const a = createFsStore({ root });
      const b = createFsStore({ root });
      const key = "artifacts/x/meta.json";
      await a.write(key, new TextEncoder().encode("start"), { ifNoneMatch: "*" });
      const base = await a.read(key);
      assert.ok(base);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? a : b).write(key, new TextEncoder().encode(`n${i}`), { ifMatch: base.etag }),
        ),
      );
      assert.equal(results.filter((r) => r.ok).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes empty directories after delete", async () => {
    const root = await tempRoot();
    try {
      const store = createFsStore({ root });
      await store.put("artifacts/x/v/1/www/a/b.css", new Uint8Array([1]));
      await store.delete("artifacts/x/v/1/www/a/b.css");
      assert.deepEqual(await readdir(root), [".tmp"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
