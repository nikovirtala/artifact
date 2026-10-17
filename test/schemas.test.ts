import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFiles, PublishBodySchema, RollbackBodySchema } from "../src/schemas.ts";

describe("PublishBodySchema", () => {
  it("accepts text and base64 files and decodes them", () => {
    const parsed = PublishBodySchema.parse({
      title: "T",
      label: "l",
      if_version: 3,
      files: { "index.html": "<p>hé</p>", "a.png": { base64: "iVBORw0KGgo=" } },
    });
    assert.deepEqual(decodeFiles(parsed.files), {
      "index.html": "<p>hé</p>",
      "a.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
  });

  it("rejects malformed base64 with an issue at files.<path>.base64", () => {
    const result = PublishBodySchema.safeParse({ files: { "a.png": { base64: "%%%" } } });
    assert.ok(!result.success);
    assert.deepEqual(result.error.issues[0].path, ["files", "a.png", "base64"]);
  });

  it("rejects unknown keys, wrong file values and bad if_version", () => {
    for (const body of [
      { files: {}, if_verison: 1 },
      { files: { "a.png": { base64: "aGk=", extra: 1 } } },
      { files: { "a.txt": 1 } },
      { files: {}, if_version: 0 },
      { files: {}, if_version: 1.5 },
      { files: {}, if_version: "3" },
      {},
      { files: [] },
    ]) {
      assert.equal(PublishBodySchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });
});

describe("RollbackBodySchema", () => {
  it("requires a positive integer version", () => {
    assert.deepEqual(RollbackBodySchema.parse({ version: 2 }), { version: 2 });
    for (const body of [{}, { version: 0 }, { version: "1" }, { version: 1, x: 1 }]) {
      assert.equal(RollbackBodySchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });
});
