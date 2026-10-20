// The token secret format shared by `artifact token` and the control Lambda (docs/decisions/0065).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hashToken,
  MAX_TOKENS,
  newToken,
  parseTokenSecret,
  serializeTokenSecret,
  type TokenSecret,
} from "../src/token-secret.ts";

const HASH = "a".repeat(64);
const entry = (name: string, sha256 = HASH) => ({
  name,
  sha256,
  createdAt: "2026-10-20T12:00:00.000Z",
});

describe("token secret", () => {
  it("round-trips through serialize and parse", () => {
    const secret: TokenSecret = { version: 1, tokens: [entry("laptop"), entry("ci.runner-1")] };
    assert.deepEqual(parseTokenSecret(serializeTokenSecret(secret)), secret);
    assert.deepEqual(parseTokenSecret('{"version":1,"tokens":[]}'), { version: 1, tokens: [] });
  });

  it("rejects every malformed shape with a TypeError", () => {
    const bad: [string, unknown][] = [
      ["not json", "{"],
      ["array", "[]"],
      ["null", "null"],
      ["string", '"x"'],
      ["version 2", { version: 2, tokens: [] }],
      ["no tokens", { version: 1 }],
      ["tokens object", { version: 1, tokens: {} }],
      [
        "too many",
        { version: 1, tokens: Array.from({ length: MAX_TOKENS + 1 }, (_, i) => entry(`t${i}`)) },
      ],
      ["bad name", { version: 1, tokens: [entry("-x")] }],
      ["long name", { version: 1, tokens: [entry("a".repeat(65))] }],
      ["space in name", { version: 1, tokens: [entry("a b")] }],
      ["duplicate name", { version: 1, tokens: [entry("a"), entry("a")] }],
      ["uppercase hash", { version: 1, tokens: [entry("a", "A".repeat(64))] }],
      ["short hash", { version: 1, tokens: [entry("a", "a".repeat(63))] }],
      ["createdAt number", { version: 1, tokens: [{ ...entry("a"), createdAt: 1 }] }],
      ["entry not object", { version: 1, tokens: ["a"] }],
    ];
    for (const [name, value] of bad) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      assert.throws(() => parseTokenSecret(text), TypeError, name);
    }
    const max = {
      version: 1,
      tokens: Array.from({ length: MAX_TOKENS }, (_, i) => entry(`t${i}`)),
    };
    assert.equal(parseTokenSecret(JSON.stringify(max)).tokens.length, MAX_TOKENS);
  });

  it("never echoes the secret text in the error", () => {
    assert.throws(
      () => parseTokenSecret(JSON.stringify({ version: 1, tokens: [entry("a", "Z".repeat(64))] })),
      (error: Error) => !error.message.includes("Z".repeat(64)),
    );
  });

  it("makes art_ tokens of 32 random bytes and hashes them with SHA-256", () => {
    const a = newToken();
    assert.match(a, /^art_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(newToken(), a);
    assert.equal(
      hashToken("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
