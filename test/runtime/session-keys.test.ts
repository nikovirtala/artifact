// The session-keys custom resource (docs/decisions/0079) with fake Secrets Manager and KVS ports
// and a fake clock: the label-selective ensure, the READY poll, KVS before the secret with the
// propagation wait, ETag retries, fail-closed responses and the cfn-response PUT.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type KeySet, parseKeySet } from "../../src/runtime/auth/session.ts";
import {
  createSessionKeysHandler,
  type EnsureDeps,
  ensureSessionKeys,
  type KvsPort,
} from "../../src/runtime/handlers/session-keys.ts";

const SECRET_ARN = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:Session-AbCdEf";
const KVS_ARN =
  "arn:aws:cloudfront::123456789012:key-value-store/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
const PLACEHOLDER = '{"version":1,"current":null,"keys":{}}';
const RESPONSE_URL =
  "https://cloudformation-custom-resource-response-eunorth1.s3.amazonaws.com/x?sig=1";
const VECTORS = JSON.parse(
  readFileSync(new URL("../fixtures/session-vectors.json", import.meta.url), "utf8"),
) as { keys: Record<string, string> };

const K1 = "1111111111111111";
const K2 = "2222222222222222";
const KEY1 = "a".repeat(43);
const KEY2 = "b".repeat(43);

const sdkError = (name: string, status?: number) =>
  Object.assign(new Error(`SECRETMESSAGE from the SDK for ${name}`), {
    name,
    $metadata: status === undefined ? {} : { httpStatusCode: status },
  });

type Step = string | Error;

/** Fakes recording every call in order; `sleep` advances the fake clock. */
function fakes(
  options: {
    secret?: string | Error;
    kvs?: Record<string, string>;
    /** Status (or error) per describe call; the last one repeats. */
    describe?: Step[];
    /** Error per update call; `undefined` succeeds. */
    update?: (Error | undefined)[];
    write?: Error;
  } = {},
) {
  const calls: string[] = [];
  let t = 0;
  let rnd = 0;
  let describes = 0;
  let updates = 0;
  const state = {
    secret: options.secret ?? PLACEHOLDER,
    kvs: { ...(options.kvs ?? {}) },
    writes: [] as string[],
    updates: [] as Parameters<KvsPort["update"]>[1][],
    randomCalls: 0,
  };
  const deps: EnsureDeps = {
    secrets: {
      read: async (arn) => {
        calls.push(`read ${arn === SECRET_ARN}`);
        if (state.secret instanceof Error) throw state.secret;
        return state.secret;
      },
      write: async (arn, value) => {
        calls.push(`write ${arn === SECRET_ARN}`);
        if (options.write) throw options.write;
        state.writes.push(value);
        state.secret = value;
      },
    },
    kvs: {
      describe: async (arn) => {
        calls.push(`describe ${arn === KVS_ARN}`);
        const steps = options.describe ?? ["READY"];
        const step = steps[Math.min(describes++, steps.length - 1)];
        if (step instanceof Error) throw step;
        return { status: step, etag: `etag-${describes}` };
      },
      list: async (arn) => {
        calls.push(`list ${arn === KVS_ARN}`);
        return { ...state.kvs };
      },
      update: async (arn, input) => {
        calls.push(`update ${arn === KVS_ARN} ${input.ifMatch}`);
        const error = (options.update ?? [])[updates++];
        if (error) throw error;
        state.updates.push(input);
        for (const { key, value } of input.puts) state.kvs[key] = value;
        for (const key of input.deletes) delete state.kvs[key];
      },
    },
    randomBytes: (n) => {
      state.randomCalls++;
      return Buffer.alloc(n, 0x40 + rnd++);
    },
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
      t += ms;
    },
    now: () => t,
  };
  return { deps, calls, state, now: () => t };
}

const props = (rotation = "initial") => ({ secretArn: SECRET_ARN, kvsArn: KVS_ARN, rotation });
const set = (current: string, ...keys: [string, string, string][]): string =>
  JSON.stringify({
    version: 1,
    current,
    keys: Object.fromEntries(keys.map(([kid, key, rotation]) => [kid, { key, rotation }])),
  });

describe("ensureSessionKeys", () => {
  it("creates one key: describe, list, update, 15 s wait, then the secret", async () => {
    const f = fakes();
    const result = await ensureSessionKeys(f.deps, props());
    assert.deepEqual(f.calls, [
      "read true",
      "describe true",
      "list true",
      "update true etag-1",
      "sleep 15000",
      "write true",
    ]);
    const written = parseKeySet(f.state.writes[0]);
    assert.equal(written.current, result.currentKid);
    assert.match(result.currentKid, /^[0-9a-f]{16}$/);
    assert.deepEqual(Object.keys(written.keys), [result.currentKid]);
    const { key, rotation } = written.keys[result.currentKid];
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(rotation, "initial");
    assert.deepEqual(f.state.kvs, { [result.currentKid]: key });
    assert.deepEqual(f.state.updates[0].deletes, []);
  });

  it("does nothing on an Update with the same label when the KVS matches", async () => {
    const f = fakes({ secret: set(K1, [K1, KEY1, "initial"]), kvs: { [K1]: KEY1 } });
    assert.deepEqual(await ensureSessionKeys(f.deps, props()), { currentKid: K1 });
    assert.deepEqual(f.calls, ["read true", "describe true", "list true"]);
    assert.equal(f.state.randomCalls, 0);
  });

  it("keeps the previous key on a same-label Update in either key order", async () => {
    const secret = JSON.stringify({
      version: 1,
      current: K2,
      keys: { [K1]: { key: KEY1, rotation: "one" }, [K2]: { key: KEY2, rotation: "two" } },
    });
    const f = fakes({ secret, kvs: { [K1]: KEY1, [K2]: KEY2 } });
    assert.deepEqual(await ensureSessionKeys(f.deps, props("two")), { currentKid: K2 });
    assert.deepEqual(f.calls, ["read true", "describe true", "list true"]);
  });

  it("rotates on a new label: new current, old current kept as previous, oldest dropped", async () => {
    const f = fakes({
      secret: set(K2, [K2, KEY2, "two"], [K1, KEY1, "one"]),
      kvs: { [K2]: KEY2, [K1]: KEY1 },
    });
    const { currentKid } = await ensureSessionKeys(f.deps, props("three"));
    assert.ok(currentKid !== K1 && currentKid !== K2);
    const written = parseKeySet(f.state.writes[0]);
    assert.equal(written.current, currentKid);
    assert.deepEqual(Object.keys(written.keys).sort(), [K2, currentKid].sort());
    assert.equal(written.keys[K2].key, KEY2);
    assert.equal(written.keys[currentKid].rotation, "three");
    assert.deepEqual(Object.keys(f.state.kvs).sort(), [K2, currentKid].sort());
    assert.deepEqual(f.state.updates[0].deletes, [K1]);
    assert.deepEqual(f.calls.slice(-3), ["update true etag-1", "sleep 15000", "write true"]);
  });

  it("rolls back to the old label without generating a key", async () => {
    const f = fakes({
      secret: set(K2, [K2, KEY2, "two"], [K1, KEY1, "one"]),
      kvs: { [K2]: KEY2, [K1]: KEY1 },
    });
    assert.deepEqual(await ensureSessionKeys(f.deps, props("one")), { currentKid: K1 });
    assert.equal(f.state.randomCalls, 0);
    const written = parseKeySet(f.state.writes[0]);
    assert.equal(written.current, K1);
    assert.deepEqual(written.keys, {
      [K1]: { key: KEY1, rotation: "one" },
      [K2]: { key: KEY2, rotation: "two" },
    });
    // The KVS already holds both keys, so only the wait and the secret write remain.
    assert.deepEqual(f.calls, [
      "read true",
      "describe true",
      "list true",
      "sleep 15000",
      "write true",
    ]);
  });

  it("heals KVS drift without touching the secret or waiting", async () => {
    const f = fakes({
      secret: set(K1, [K1, KEY1, "initial"]),
      kvs: { [K1]: "c".repeat(43), stray: "x" },
    });
    await ensureSessionKeys(f.deps, props());
    assert.deepEqual(f.state.kvs, { [K1]: KEY1 });
    assert.deepEqual(f.state.updates[0], {
      ifMatch: "etag-1",
      puts: [{ key: K1, value: KEY1 }],
      deletes: ["stray"],
    });
    assert.deepEqual(f.calls, ["read true", "describe true", "list true", "update true etag-1"]);
  });

  it("refuses a malformed secret before touching the KVS", async () => {
    for (const secret of ["not json", '{"version":2}', set(K1, [K1, "short", "a"])]) {
      const f = fakes({ secret });
      await assert.rejects(ensureSessionKeys(f.deps, props()), {
        reason: "SessionKeysError: the session secret is malformed",
      });
      assert.deepEqual(f.calls, ["read true"]);
    }
  });

  it("names the SDK error, never its message, when a call fails", async () => {
    const cases: [Parameters<typeof fakes>[0], string, string[]][] = [
      [
        { secret: sdkError("ResourceNotFoundException") },
        "ResourceNotFoundException: cannot read the session secret",
        ["read true"],
      ],
      [
        { describe: [sdkError("AccessDeniedException")] },
        "AccessDeniedException: cannot describe the key value store",
        ["read true", "describe true"],
      ],
      [
        { update: [sdkError("ValidationException")] },
        "ValidationException: cannot update the key value store",
        ["read true", "describe true", "list true", "update true etag-1"],
      ],
      [
        { write: sdkError("ThrottlingException") },
        "ThrottlingException: cannot write the session secret",
        [
          "read true",
          "describe true",
          "list true",
          "update true etag-1",
          "sleep 15000",
          "write true",
        ],
      ],
    ];
    for (const [options, reason, calls] of cases) {
      const f = fakes(options);
      await assert.rejects(
        ensureSessionKeys(f.deps, props()),
        (error: Error & { reason: string }) => {
          assert.equal(error.reason, reason);
          assert.ok(!error.reason.includes("SECRETMESSAGE"));
          return true;
        },
      );
      assert.deepEqual(f.calls, calls, reason);
    }
  });

  it("retries the KVS update on an ETag conflict up to three attempts", async () => {
    const f = fakes({
      update: [sdkError("ConflictException"), sdkError("PreconditionFailed", 412)],
    });
    await ensureSessionKeys(f.deps, props());
    assert.deepEqual(f.calls, [
      "read true",
      "describe true",
      "list true",
      "update true etag-1",
      "describe true",
      "list true",
      "update true etag-2",
      "describe true",
      "list true",
      "update true etag-3",
      "sleep 15000",
      "write true",
    ]);
    const g = fakes({ update: [1, 2, 3].map(() => sdkError("ConflictException")) });
    await assert.rejects(ensureSessionKeys(g.deps, props()), {
      reason: "ConflictException: key value store update conflicts",
    });
    assert.equal(g.calls.filter((c) => c.startsWith("update")).length, 3);
    assert.ok(!g.calls.some((c) => c.startsWith("write")));
  });

  describe("READY poll", () => {
    const sleeps = (calls: string[]) => calls.filter((c) => c === "sleep 2000").length;

    it("polls every 2 s until READY (any case)", async () => {
      const f = fakes({ describe: ["PROVISIONING", "PROVISIONING", "PROVISIONING", "Ready"] });
      await ensureSessionKeys(f.deps, props());
      assert.equal(sleeps(f.calls), 3);
      assert.equal(f.calls.filter((c) => c.startsWith("describe")).length, 4);
      assert.ok(f.calls.indexOf("list true") > f.calls.lastIndexOf("sleep 2000"));
    });

    it("treats ResourceNotFoundException and ConflictException as not ready yet", async () => {
      const f = fakes({
        describe: [
          sdkError("ResourceNotFoundException"),
          sdkError("ResourceNotFoundException"),
          "READY",
        ],
      });
      await ensureSessionKeys(f.deps, props());
      assert.equal(sleeps(f.calls), 2);
      const g = fakes({ describe: [sdkError("ConflictException"), "READY"] });
      await ensureSessionKeys(g.deps, props());
      assert.equal(sleeps(g.calls), 1);
    });

    it("fails after 60 s when the store never becomes READY", async () => {
      for (const step of ["PROVISIONING", sdkError("ResourceNotFoundException")]) {
        const f = fakes({ describe: [step] });
        await assert.rejects(ensureSessionKeys(f.deps, props()), {
          reason: "SessionKeysError: key value store not ready",
        });
        assert.equal(f.now(), 60_000);
        assert.ok(!f.calls.some((c) => c.startsWith("list") || c.startsWith("write")));
      }
    });

    it("fails at once on a FAILED status or another error", async () => {
      for (const [step, reason] of [
        ["IMPORT_FAILED", "SessionKeysError: key value store not ready"],
        ["import_failed", "SessionKeysError: key value store not ready"],
        ["IMPORT_FAILURE", "SessionKeysError: key value store not ready"],
        [
          sdkError("AccessDeniedException"),
          "AccessDeniedException: cannot describe the key value store",
        ],
      ] as const) {
        const f = fakes({ describe: [step] });
        await assert.rejects(ensureSessionKeys(f.deps, props()), { reason });
        assert.equal(sleeps(f.calls), 0);
      }
    });
  });
});

type Put = { url: string; init: RequestInit; body: Record<string, unknown> };

function handler(
  f: ReturnType<typeof fakes>,
  respond: (url: string) => Response | Promise<Response> = () =>
    new Response(null, { status: 200 }),
) {
  const puts: Put[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    puts.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return respond(String(url));
  }) as typeof globalThis.fetch;
  return { run: createSessionKeysHandler({ ...f.deps, fetch }), puts };
}

const cfnEvent = (overrides: Record<string, unknown> = {}) => ({
  RequestType: "Create",
  ServiceToken: "arn:aws:lambda:eu-north-1:123456789012:function:SessionKeys",
  ResponseURL: RESPONSE_URL,
  StackId: "arn:aws:cloudformation:eu-north-1:123456789012:stack/prod-platform/abc",
  RequestId: "req-1",
  LogicalResourceId: "ArtifactsSessionKeysABCD1234",
  ResourceType: "Custom::ArtifactSessionKeys",
  ResourceProperties: {
    ServiceToken: "arn:aws:lambda:eu-north-1:123456789012:function:SessionKeys",
    SecretArn: SECRET_ARN,
    KeyValueStoreArn: KVS_ARN,
    Rotation: "initial",
  },
  ...overrides,
});

/** Console output written while `fn` runs. */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; output: string[] }> {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    return { value: await fn(), output };
  } catch (error) {
    return { error, output };
  } finally {
    console.log = original;
  }
}

describe("session-keys handler", () => {
  it("responds SUCCESS to Create with the fixed physical id, the ids copied and NoEcho", async () => {
    const f = fakes();
    const h = handler(f);
    const { output } = await capture(() => h.run(cfnEvent()));
    assert.equal(h.puts.length, 1);
    const [put] = h.puts;
    assert.equal(put.url, RESPONSE_URL);
    assert.equal(put.init.method, "PUT");
    assert.deepEqual(put.init.headers, { "content-type": "" });
    assert.ok(put.init.signal instanceof AbortSignal);
    const current = parseKeySet(f.state.writes[0]).current;
    assert.deepEqual(put.body, {
      Status: "SUCCESS",
      Reason: "session keys ensured",
      PhysicalResourceId: "session-keys",
      StackId: cfnEvent().StackId,
      RequestId: "req-1",
      LogicalResourceId: "ArtifactsSessionKeysABCD1234",
      NoEcho: true,
      Data: { CurrentKid: current },
    });
    assert.deepEqual(output, ['artifact session-keys {"request":"Create","result":"ok"}']);
  });

  it("keeps the event's physical id on Update", async () => {
    const f = fakes({ secret: set(K1, [K1, KEY1, "initial"]), kvs: { [K1]: KEY1 } });
    const h = handler(f);
    await capture(() =>
      h.run(cfnEvent({ RequestType: "Update", PhysicalResourceId: "session-keys" })),
    );
    assert.equal(h.puts[0].body.Status, "SUCCESS");
    assert.equal(h.puts[0].body.PhysicalResourceId, "session-keys");
    assert.deepEqual(h.puts[0].body.Data, { CurrentKid: K1 });
  });

  it("touches nothing on Delete", async () => {
    const f = fakes();
    const h = handler(f);
    await capture(() =>
      h.run(
        cfnEvent({
          RequestType: "Delete",
          PhysicalResourceId: "session-keys",
          ResourceProperties: {},
        }),
      ),
    );
    assert.deepEqual(f.calls, []);
    assert.equal(h.puts[0].body.Status, "SUCCESS");
    assert.equal(h.puts[0].body.PhysicalResourceId, "session-keys");
    assert.deepEqual(h.puts[0].body.Data, {});
  });

  it("responds FAILED with a fixed reason, no key material and no SDK message", async () => {
    const generated = fakes({ write: sdkError("ThrottlingException") });
    const cases: [ReturnType<typeof fakes>, Record<string, unknown>, string][] = [
      [fakes({ secret: "garbage" }), {}, "SessionKeysError: the session secret is malformed"],
      [generated, {}, "ThrottlingException: cannot write the session secret"],
      [fakes(), { RequestType: "Bogus" }, "SessionKeysError: invalid request"],
      [
        fakes(),
        {
          ResourceProperties: {
            SecretArn: "arn:aws:s3:::x",
            KeyValueStoreArn: KVS_ARN,
            Rotation: "a",
          },
        },
        "SessionKeysError: invalid resource properties",
      ],
      [
        fakes(),
        { ResourceProperties: { SecretArn: SECRET_ARN, KeyValueStoreArn: "kvs", Rotation: "a" } },
        "SessionKeysError: invalid resource properties",
      ],
      [
        fakes(),
        {
          ResourceProperties: { SecretArn: SECRET_ARN, KeyValueStoreArn: KVS_ARN, Rotation: "a b" },
        },
        "SessionKeysError: invalid resource properties",
      ],
    ];
    for (const [f, overrides, reason] of cases) {
      const h = handler(f);
      const event = cfnEvent(overrides);
      const { output } = await capture(() => h.run(event));
      const [put] = h.puts;
      assert.equal(put.body.Status, "FAILED", reason);
      assert.equal(put.body.Reason, reason);
      assert.ok(String(put.body.Reason).length <= 256);
      assert.equal(put.body.PhysicalResourceId, "session-keys");
      assert.deepEqual(put.body.Data, {});
      assert.equal(put.body.NoEcho, true);
      const name = reason.split(":", 1)[0];
      const request =
        typeof event.RequestType === "string" && event.RequestType !== "Bogus"
          ? event.RequestType
          : "unknown";
      assert.deepEqual(output, [
        `artifact session-keys ${JSON.stringify({ request, result: "failed", name })}`,
      ]);
      const text = String(put.init.body);
      assert.ok(!text.includes("SECRETMESSAGE"));
      for (const key of Object.values(VECTORS.keys)) assert.ok(!text.includes(key));
      // A key generated before the failure (written to the KVS) is in no response or log.
      for (const key of Object.values(f.state.kvs)) {
        assert.ok(!text.includes(key));
        assert.ok(!output.join("\n").includes(key));
      }
    }
    assert.equal(Object.keys(generated.state.kvs).length, 1);
  });

  it("never puts a generated key into the response body", async () => {
    const f = fakes();
    const h = handler(f);
    await capture(() => h.run(cfnEvent()));
    const written = parseKeySet(f.state.writes[0]) as KeySet;
    const text = String(h.puts[0].init.body);
    for (const { key } of Object.values(written.keys)) assert.ok(!text.includes(key));
    for (const key of Object.values(VECTORS.keys)) assert.ok(!text.includes(key));
  });

  it("logs and throws when the response PUT fails or the ResponseURL is invalid", async () => {
    for (const [respond, status] of [
      [() => new Response("denied", { status: 403 }), 403],
      [
        () => {
          throw new TypeError("network down");
        },
        0,
      ],
    ] as const) {
      const h = handler(fakes(), respond);
      const { error, output } = await capture(() => h.run(cfnEvent()));
      assert.ok(error instanceof Error);
      assert.ok(
        output.includes(`artifact session-keys response failed {"status":${status}}`),
        output.join(),
      );
    }
    for (const url of ["http://example.com/x", "not a url", undefined]) {
      const f = fakes();
      const h = handler(f);
      const { error, output } = await capture(() => h.run(cfnEvent({ ResponseURL: url })));
      assert.ok(error instanceof Error);
      assert.equal(h.puts.length, 0);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(output, [
        'artifact session-keys {"request":"Create","result":"failed","name":"SessionKeysError"}',
      ]);
    }
  });
});
