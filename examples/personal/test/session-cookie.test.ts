// The smoke script's cookie minting reproduces the shared vectors (docs/decisions/0078), so the
// cookies it mints are exactly what the viewing Lambda signs and the edge accepts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { InputError } from "../scripts/lib/cli.ts";
import {
  cookieSegments,
  decodePayload,
  mintSession,
  parseSessionSecret,
  randomKey,
  randomKid,
} from "../scripts/lib/session-cookie.ts";

type Vectors = {
  keys: Record<string, string>;
  current: string;
  valid: { name: string; kid: string; payload: Record<string, unknown>; cookie: string }[];
  transaction: { valid: { name: string; payload: Record<string, unknown>; cookie: string }[] };
};
const vectors = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/session-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const secret = (keys: Record<string, string>, current: string | null) =>
  JSON.stringify({
    version: 1,
    current,
    keys: Object.fromEntries(
      Object.entries(keys).map(([kid, key]) => [kid, { key, rotation: "r1" }]),
    ),
  });

describe("session cookie minting", () => {
  it("reproduces every valid[] cookie byte for byte", () => {
    for (const v of vectors.valid) {
      const { sub, email, iat, exp } = v.payload as {
        sub: string;
        email: string;
        iat: number;
        exp: number;
      };
      assert.equal(
        mintSession(vectors.keys[v.kid], v.kid, { sub, email, iat, exp }),
        v.cookie,
        v.name,
      );
    }
  });

  it("splits a cookie into kid, payload and signature segments", () => {
    const [first] = vectors.valid;
    const parts = first.cookie.split(".");
    assert.deepEqual(cookieSegments(first.cookie), {
      kid: first.kid,
      payload: parts[2],
      signature: parts[3],
    });
    assert.equal(cookieSegments(first.cookie).signature.length, 43);
    assert.throws(() => cookieSegments("v1.x"), TypeError);
  });

  it("decodes a transaction cookie's payload (S34)", () => {
    for (const v of vectors.transaction.valid) {
      assert.deepEqual(decodePayload(v.cookie), v.payload, v.name);
    }
    assert.equal(decodePayload("t1.0123456789abcdef.!!!.x"), undefined);
    assert.equal(decodePayload("nope"), undefined);
  });

  it("random kids and keys have the deployed shapes", () => {
    assert.match(randomKid(), /^[0-9a-f]{16}$/);
    assert.match(randomKey(), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(randomKey(), randomKey());
  });
});

describe("session secret", () => {
  it("reads current and previous", () => {
    assert.deepEqual(
      parseSessionSecret(
        secret({ [vectors.current]: vectors.keys[vectors.current] }, vectors.current),
      ),
      {
        current: vectors.current,
        keys: { [vectors.current]: vectors.keys[vectors.current] },
        previous: undefined,
      },
    );
    const both = parseSessionSecret(secret(vectors.keys, vectors.current));
    assert.equal(both.previous, "fedcba9876543210");
    assert.equal(both.keys[both.current], vectors.keys[vectors.current]);
  });

  it("rejects the placeholder and malformed sets without echoing a value", () => {
    const key = vectors.keys[vectors.current];
    for (const text of [
      secret({}, null),
      "not json",
      JSON.stringify({ version: 2, current: vectors.current, keys: {} }),
      secret({ [vectors.current]: key }, "fedcba9876543210"),
      secret({ ABC: key }, "ABC"),
      secret({ [vectors.current]: "short" }, vectors.current),
    ]) {
      assert.throws(
        () => parseSessionSecret(text),
        (e: Error) => e instanceof InputError && !e.message.includes(key),
        text.slice(0, 60),
      );
    }
  });
});
