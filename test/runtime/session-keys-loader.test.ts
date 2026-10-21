// The viewing Lambda's session-key cache (docs/decisions/0079): a 5-minute single-flight cache
// of the session secret, plus one forced reload (at most once per 60 s) when a login-transaction
// cookie names a kid the cached set does not hold yet, as after a rotation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeySet } from "../../src/runtime/auth/session.ts";
import { createKeyCache, sessionSecretLoader } from "../../src/runtime/auth/session-keys-loader.ts";

const A = "aaaaaaaaaaaaaaaa";
const C = "cccccccccccccccc";
const keyOf = (c: string) => c.repeat(43);
const set = (...kids: string[]): KeySet => ({
  version: 1,
  current: kids[0],
  keys: Object.fromEntries(kids.map((k) => [k, { key: keyOf(k[0]), rotation: `r-${k[0]}` }])),
});

/** A loader returning `next` (a set or an error), counting calls; resolves on the next tick. */
function fakeLoader(initial: KeySet | Error) {
  const state = { next: initial, calls: 0 };
  const load = async () => {
    state.calls++;
    await new Promise((r) => setImmediate(r));
    if (state.next instanceof Error) throw state.next;
    return state.next;
  };
  return { load, state };
}

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Console output written while `fn` runs. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; output: string[] }> {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    return { value: await fn(), output };
  } finally {
    console.log = original;
  }
}

describe("createKeyCache get()", () => {
  it("serves the cached set within the TTL and loads once after it", async () => {
    const { load, state } = fakeLoader(set(A));
    const c = clock();
    const cache = createKeyCache(load, { now: c.now });
    assert.deepEqual(await cache.get(), set(A));
    c.advance(299_999);
    assert.deepEqual(await cache.get(), set(A));
    assert.equal(state.calls, 1);
    state.next = set(C, A);
    c.advance(1);
    assert.deepEqual(await cache.get(), set(C, A));
    assert.equal(state.calls, 2);
  });

  it("is single-flight and caches no failure", async () => {
    const { load, state } = fakeLoader(new Error("boom"));
    const cache = createKeyCache(load, { now: clock().now });
    const results = await Promise.allSettled([cache.get(), cache.get()]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["rejected", "rejected"],
    );
    assert.equal(state.calls, 1);
    state.next = set(A);
    assert.deepEqual(await cache.get(), set(A));
    assert.equal(state.calls, 2);
  });
});

describe("createKeyCache forKid()", () => {
  it("returns the cached set without I/O when it holds the kid", async () => {
    const { load, state } = fakeLoader(set(A));
    const c = clock();
    const cache = createKeyCache(load, { now: c.now });
    await cache.get();
    c.advance(10 * 60_000);
    assert.deepEqual(await cache.forKid(A), set(A));
    assert.equal(state.calls, 1);
  });

  it("shares one forced reload between concurrent misses and replaces the cache", async () => {
    const { load, state } = fakeLoader(set(A));
    const cache = createKeyCache(load, { now: clock().now });
    await cache.get();
    state.next = set(C, A);
    const [x, y] = await Promise.all([cache.forKid(C), cache.forKid(C)]);
    assert.deepEqual(x, set(C, A));
    assert.deepEqual(y, set(C, A));
    assert.equal(state.calls, 2);
    assert.deepEqual(await cache.get(), set(C, A));
    assert.equal(state.calls, 2);
  });

  it("forces no second reload within 60 s, and one after", async () => {
    const { load, state } = fakeLoader(set(A));
    const c = clock();
    const cache = createKeyCache(load, { now: c.now });
    await cache.get();
    assert.deepEqual(await cache.forKid(C), set(A));
    assert.equal(state.calls, 2);
    c.advance(59_999);
    assert.deepEqual(await cache.forKid(C), set(A));
    assert.equal(state.calls, 2);
    state.next = set(C, A);
    c.advance(1);
    assert.deepEqual(await cache.forKid(C), set(C, A));
    assert.equal(state.calls, 3);
  });

  it("keeps the old set when the forced reload fails, logs the name once, and get() works", async () => {
    const { load, state } = fakeLoader(set(A));
    const c = clock();
    const cache = createKeyCache(load, { now: c.now });
    await cache.get();
    const failure = new Error("SECRETMESSAGE");
    failure.name = "ThrottlingException";
    state.next = failure;
    const { value, output } = await capture(() => cache.forKid(C));
    assert.deepEqual(value, set(A));
    assert.deepEqual(output, [
      'artifact login {"result":"error","reason":"session_keys","name":"ThrottlingException"}',
    ]);
    assert.equal(state.calls, 2);
    state.next = set(C, A);
    assert.deepEqual(await cache.get(), set(A));
    c.advance(300_000);
    assert.deepEqual(await cache.get(), set(C, A));
    assert.equal(state.calls, 3);
  });

  it("loads a cold cache once and does not force a second load for a kid it lacks", async () => {
    const { load, state } = fakeLoader(set(A));
    const cache = createKeyCache(load, { now: clock().now });
    assert.deepEqual(await cache.forKid(C), set(A));
    assert.equal(state.calls, 1);
  });
});

describe("sessionSecretLoader", () => {
  const ARN = "arn:aws:secretsmanager:eu-north-1:000000000000:secret:s-AbCdEf";

  it("reads the secret by ARN and parses the key set", async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (command: { input: unknown }) => {
        sent.push(command.input);
        return { SecretString: JSON.stringify(set(A)) };
      },
    };
    const load = sessionSecretLoader(ARN, client as never);
    assert.deepEqual(await load(), set(A));
    assert.deepEqual(sent, [{ SecretId: ARN }]);
  });

  it("refuses a secret without SecretString and a malformed one", async () => {
    const none = sessionSecretLoader(ARN, { send: async () => ({}) } as never);
    await assert.rejects(none(), /^TypeError: the session secret has no SecretString$/);
    const bad = sessionSecretLoader(ARN, {
      send: async () => ({ SecretString: '{"version":2}' }),
    } as never);
    await assert.rejects(bad(), /malformed session key set: version/);
  });
});
