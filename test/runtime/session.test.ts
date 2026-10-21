// Session and login-transaction cookies (docs/decisions/0078) against the shared vectors that the
// edge function's tests and the smoke script's minting lib consume too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  parseKeySet,
  SESSION_COOKIE,
  SESSION_TTL_S,
  type SessionPayload,
  sessionKeys,
  signSession,
  signTransaction,
  TRANSACTION_COOKIE,
  TRANSACTION_TTL_S,
  type TransactionPayload,
  verifySession,
  verifyTransaction,
} from "../../src/runtime/auth/session.ts";

type Vectors = {
  now: number;
  keys: Record<string, string>;
  current: string;
  valid: { name: string; kid: string; payload: SessionPayload; cookie: string }[];
  invalid: { name: string; cookie: string }[];
  transaction: {
    valid: { name: string; kid: string; payload: TransactionPayload; cookie: string }[];
    invalid: { name: string; cookie: string }[];
  };
};

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/session-vectors.json", import.meta.url), "utf8"),
) as Vectors;
const { now, keys, current } = vectors;
const KID = /^[0-9a-f]{16}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

describe("shared session vectors", () => {
  it("hold two fixed test keys and every case the design lists", () => {
    assert.deepEqual(Object.keys(keys), ["0123456789abcdef", "fedcba9876543210"]);
    for (const [kid, key] of Object.entries(keys)) {
      assert.match(kid, KID);
      assert.match(key, KEY);
    }
    assert.equal(current, "0123456789abcdef");
    assert.deepEqual(
      vectors.valid.map((v) => v.name),
      ["current kid", "previous kid"],
    );
    assert.deepEqual(
      vectors.invalid.map((v) => v.name),
      [
        "tampered payload",
        "tampered sig",
        "expired (exp = now)",
        "unknown kid",
        "v2 prefix",
        "missing segment",
        "extra segment",
        "uppercase kid",
        "bad base64url",
        "payload not JSON",
        "exp missing",
        "exp string",
        "sig 42 chars",
        "empty",
      ],
    );
    assert.ok(vectors.transaction.valid.length >= 2);
    assert.ok(vectors.transaction.invalid.length >= 8);
  });
});

describe("session cookie", () => {
  it("names the cookies and their lifetimes", () => {
    assert.equal(SESSION_COOKIE, "__Secure-artifact_session");
    assert.equal(TRANSACTION_COOKIE, "__Host-artifact_login");
    assert.equal(SESSION_TTL_S, 2_592_000);
    assert.equal(TRANSACTION_TTL_S, 600);
  });

  it("reproduces every valid vector byte for byte", () => {
    for (const v of vectors.valid) {
      assert.equal(signSession(keys, v.kid, v.payload), v.cookie, v.name);
      assert.equal(v.payload.exp, v.payload.iat + SESSION_TTL_S, v.name);
    }
    assert.equal(vectors.valid[0].kid, current);
    assert.notEqual(vectors.valid[1].kid, current);
  });

  it("accepts every valid vector with its kid and claims", () => {
    for (const v of vectors.valid) {
      assert.deepEqual(
        verifySession(keys, v.cookie, now),
        { kid: v.kid, claims: v.payload },
        v.name,
      );
    }
  });

  it("rejects every invalid vector", () => {
    for (const v of vectors.invalid) assert.equal(verifySession(keys, v.cookie, now), null, v.name);
  });

  it("serialises the payload in the order sub, email, iat, exp", () => {
    const payload = { exp: 2, iat: 1, email: "e", sub: "s" } as SessionPayload;
    const [, , body] = signSession(keys, current, payload).split(".");
    assert.equal(
      Buffer.from(body, "base64url").toString("utf8"),
      '{"sub":"s","email":"e","iat":1,"exp":2}',
    );
  });

  it("treats exp as valid only while it is later than now", () => {
    const v = vectors.valid[0];
    assert.notEqual(verifySession(keys, v.cookie, v.payload.exp - 1), null);
    assert.equal(verifySession(keys, v.cookie, v.payload.exp), null);
  });

  it("rejects an unknown kid without a key and refuses to sign with one", () => {
    assert.equal(verifySession({}, vectors.valid[0].cookie, now), null);
    assert.throws(() => signSession(keys, "00112233aabbccdd", vectors.valid[0].payload), {
      message: "no session key for the kid",
    });
  });
});

describe("login-transaction cookie", () => {
  it("reproduces every valid vector byte for byte and accepts it", () => {
    for (const v of vectors.transaction.valid) {
      assert.equal(signTransaction(keys, v.kid, v.payload), v.cookie, v.name);
      assert.deepEqual(
        verifyTransaction(keys, v.cookie, now),
        { kid: v.kid, tx: v.payload },
        v.name,
      );
    }
  });

  it("rejects every invalid vector", () => {
    for (const v of vectors.transaction.invalid) {
      assert.equal(verifyTransaction(keys, v.cookie, now), null, v.name);
    }
  });

  it("round-trips with the current and the previous kid", () => {
    const tx = {
      s: "a".repeat(43),
      n: "b".repeat(43),
      v: "c".repeat(43),
      r: "https://x/",
      exp: now + 600,
    };
    for (const kid of Object.keys(keys)) {
      assert.deepEqual(verifyTransaction(keys, signTransaction(keys, kid, tx), now), { kid, tx });
    }
  });

  it("never verifies as a session cookie, nor the other way round", () => {
    for (const v of vectors.transaction.valid) {
      assert.equal(verifySession(keys, v.cookie, now), null, v.name);
      // Same segments under the session prefix: the derived key still makes the signature differ.
      assert.equal(verifySession(keys, `v1.${v.cookie.slice(3)}`, now), null, v.name);
    }
    for (const v of vectors.valid) {
      assert.equal(verifyTransaction(keys, v.cookie, now), null, v.name);
      assert.equal(verifyTransaction(keys, `t1.${v.cookie.slice(3)}`, now), null, v.name);
    }
  });
});

describe("parseKeySet", () => {
  const entry = (key: string, rotation = "1") => ({ key, rotation });
  const set = (value: unknown) => JSON.stringify(value);
  const [kidA, kidB] = Object.keys(keys);
  const two = { [kidA]: entry(keys[kidA], "2"), [kidB]: entry(keys[kidB], "1") };

  it("recognises the template's placeholder as the empty set", () => {
    assert.deepEqual(parseKeySet('{"version":1,"current":null,"keys":{}}'), {
      version: 1,
      current: null,
      keys: {},
    });
  });

  it("parses one or two keys and maps them to the HMAC key strings", () => {
    const parsed = parseKeySet(set({ version: 1, current: kidA, keys: two }));
    assert.deepEqual(parsed, { version: 1, current: kidA, keys: two });
    assert.deepEqual(sessionKeys(parsed), keys);
    const one = { version: 1, current: kidB, keys: { [kidB]: entry(keys[kidB]) } };
    assert.deepEqual(parseKeySet(set(one)), one);
  });

  it("rejects anything else without echoing the secret", () => {
    const secret = keys[kidA];
    const cases: [string, unknown][] = [
      ["not JSON", "{"],
      ["array", []],
      ["version 2", { version: 2, current: kidA, keys: two }],
      [
        "three keys",
        { version: 1, current: kidA, keys: { ...two, "00112233aabbccdd": entry(secret) } },
      ],
      [
        "uppercase kid",
        { version: 1, current: kidA.toUpperCase(), keys: { [kidA.toUpperCase()]: entry(secret) } },
      ],
      ["short kid", { version: 1, current: "0123", keys: { "0123": entry(secret) } }],
      ["key 42 chars", { version: 1, current: kidA, keys: { [kidA]: entry(secret.slice(1)) } }],
      ["key with +", { version: 1, current: kidA, keys: { [kidA]: entry(`+${secret.slice(1)}`) } }],
      [
        "key not a string",
        { version: 1, current: kidA, keys: { [kidA]: { key: 1, rotation: "1" } } },
      ],
      ["rotation missing", { version: 1, current: kidA, keys: { [kidA]: { key: secret } } }],
      [
        "rotation with space",
        { version: 1, current: kidA, keys: { [kidA]: entry(secret, "a b") } },
      ],
      ["current not in keys", { version: 1, current: "00112233aabbccdd", keys: two }],
      ["current null with keys", { version: 1, current: null, keys: two }],
      ["current set without keys", { version: 1, current: kidA, keys: {} }],
      ["keys missing", { version: 1, current: null }],
    ];
    for (const [name, value] of cases) {
      const text = typeof value === "string" ? value : set(value);
      assert.throws(
        () => parseKeySet(text),
        (error: Error) => error instanceof TypeError && !error.message.includes(secret),
        name,
      );
    }
  });
});
