import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUlidIdGen, ulid } from "../../src/adapters/ulid.ts";
import { isArtifactId } from "../../src/core/paths.ts";

describe("ulid", () => {
  it("produces 26-char lowercase crockford ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createUlidIdGen().next()));
    assert.equal(ids.size, 1000);
    for (const id of ids) assert.ok(isArtifactId(id), id);
  });

  it("encodes the time in the first 10 chars so ids sort by creation time", () => {
    const zeros = (b: Uint8Array) => b.fill(0);
    assert.equal(ulid(0, zeros), "0".repeat(26));
    assert.equal(ulid(2 ** 48 - 1, zeros), `7zzzzzzzzz${"0".repeat(16)}`);
    assert.equal(ulid(1469918176385, zeros).slice(0, 10), "01aryz6s41");
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    assert.ok(a < b);
    assert.throws(() => ulid(-1), RangeError);
    assert.throws(() => ulid(2 ** 48), RangeError);
  });
});
