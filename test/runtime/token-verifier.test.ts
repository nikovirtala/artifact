// The control Lambda's token check (docs/decisions/0065): SHA-256 hashes from the secret,
// cached for 5 minutes, single-flight, no stale fallback and no negative caching.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { CliContext } from "../../src/cli/output.ts";
import { type SecretsSdk, run as tokenCommand } from "../../src/cli/token.ts";
import {
  createTokenVerifier,
  secretsManagerLoader,
} from "../../src/runtime/auth/token-verifier.ts";
import { hashToken } from "../../src/token-secret.ts";

const TTL = 300_000;
const secretWith = (...tokens: string[]) =>
  JSON.stringify({
    version: 1,
    tokens: tokens.map((t, i) => ({
      name: `t${i}`,
      sha256: hashToken(t),
      createdAt: "2026-10-20T12:00:00.000Z",
    })),
  });

function counted(load: () => Promise<string>) {
  const state = { loads: 0 };
  return {
    state,
    load: () => {
      state.loads++;
      return load();
    },
  };
}

describe("createTokenVerifier", () => {
  it("accepts listed tokens and rejects others", async () => {
    const verify = createTokenVerifier({ load: async () => secretWith("art_a", "art_b") });
    assert.equal(await verify("art_a"), true);
    assert.equal(await verify("art_b"), true);
    assert.equal(await verify("art_c"), false);
    assert.equal(await verify(""), false);
  });

  it("loads once within the TTL, also for an empty list", async () => {
    let t = 0;
    const { state, load } = counted(async () => secretWith());
    const verify = createTokenVerifier({ load, now: () => t, ttlMs: TTL });
    assert.equal(await verify("art_a"), false);
    t = TTL - 1;
    assert.equal(await verify("art_a"), false);
    assert.equal(state.loads, 1);
  });

  it("refreshes at exactly the TTL: a revoked token stops, a new one starts", async () => {
    let t = 0;
    let secret = secretWith("art_old");
    const { state, load } = counted(async () => secret);
    const verify = createTokenVerifier({ load, now: () => t, ttlMs: TTL });
    assert.equal(await verify("art_old"), true);
    secret = secretWith("art_new");
    t = TTL - 1;
    assert.equal(await verify("art_old"), true);
    assert.equal(await verify("art_new"), false);
    t = TTL;
    assert.equal(await verify("art_old"), false);
    assert.equal(await verify("art_new"), true);
    assert.equal(state.loads, 2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    let release: (s: string) => void = () => {};
    const { state, load } = counted(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const verify = createTokenVerifier({ load });
    const pending = [verify("art_a"), verify("art_b"), verify("art_x")];
    await new Promise((r) => setImmediate(r));
    release(secretWith("art_a", "art_b"));
    assert.deepEqual(await Promise.all(pending), [true, true, false]);
    assert.equal(state.loads, 1);
  });

  it("rejects without the token or secret when the list is unavailable, then retries", async () => {
    let t = 0;
    let mode: "fail" | "malformed" | "ok" = "fail";
    const { state, load } = counted(async () => {
      if (mode === "fail") {
        throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      }
      if (mode === "malformed") return '{"version":1,"tokens":[{"name":"x","sha256":"SECRETX"}]}';
      return secretWith("art_a");
    });
    const verify = createTokenVerifier({ load, now: () => t, ttlMs: TTL });
    await assert.rejects(verify("art_a"), {
      message: "artifact: token list unavailable: ThrottlingException",
    });
    mode = "malformed";
    await assert.rejects(verify("art_a"), (e: Error) => {
      assert.equal(e.message, "artifact: token list unavailable: TypeError");
      return !e.message.includes("art_a") && !e.message.includes("SECRETX");
    });
    mode = "ok";
    assert.equal(await verify("art_a"), true);
    assert.equal(state.loads, 3);

    // After a successful fetch, a failing refresh rejects instead of serving the old list.
    mode = "fail";
    t = TTL;
    await assert.rejects(verify("art_a"), /token list unavailable/);
  });
});

describe("secretsManagerLoader", () => {
  const ARN = "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf";

  it("reads SecretString of the ARN; a missing SecretString is malformed", async () => {
    const sent: unknown[] = [];
    let answer: { SecretString?: string } = { SecretString: secretWith("art_a") };
    const client = {
      send: async (command: unknown) => {
        sent.push(command);
        return answer;
      },
    } as unknown as SecretsManagerClient;
    assert.equal(await secretsManagerLoader(ARN, client)(), secretWith("art_a"));
    assert.ok(sent[0] instanceof GetSecretValueCommand);
    assert.deepEqual((sent[0] as GetSecretValueCommand).input, { SecretId: ARN });

    answer = {};
    const verify = createTokenVerifier({ load: secretsManagerLoader(ARN, client) });
    await assert.rejects(verify("art_a"), {
      message: "artifact: token list unavailable: TypeError",
    });
  });
});

describe("artifact token and the verifier", () => {
  it("a token created by the CLI verifies against the same secret", async () => {
    let secret = '{"version":1,"tokens":[]}';
    class GetSecretValueCommand {}
    class PutSecretValueCommand {
      readonly input: { SecretString: string };
      constructor(input: { SecretString: string }) {
        this.input = input;
      }
    }
    class SecretsManagerClient {
      async send(command: unknown) {
        if (command instanceof PutSecretValueCommand) secret = command.input.SecretString;
        return { SecretString: secret };
      }
    }
    const sdk = { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand };
    let stdout = "";
    const ctx = {
      env: {},
      stdout: {
        write: (s: string) => {
          stdout += s;
          return true;
        },
      },
      stderr: { write: () => true },
    } as unknown as CliContext;
    const arn = "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf";
    await tokenCommand(["create", "laptop", "--secret", arn], ctx, {
      loadSdk: async () => sdk as unknown as SecretsSdk,
    });
    const verify = createTokenVerifier({ load: async () => secret });
    assert.equal(await verify(stdout.trim()), true);
    assert.equal(await verify(`${stdout.trim()}x`), false);
  });
});
