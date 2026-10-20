// `artifact token create|revoke|list` against a fake Secrets Manager SDK module
// (docs/decisions/0065).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CliContext, type CliError, UsageError } from "../../src/cli/output.ts";
import { isMissingModule, run, type SecretsSdk } from "../../src/cli/token.ts";
import { hashToken, parseTokenSecret } from "../../src/token-secret.ts";

const ARN = "arn:aws:secretsmanager:eu-north-1:000000000000:secret:artifact-tokens-AbCdEf";
const EMPTY = '{"version":1,"tokens":[]}';

type Call = { op: "get" | "put"; input: Record<string, unknown> };

/** A fake `@aws-sdk/client-secrets-manager` holding one secret string. */
function fakeSdk(initial = EMPTY, options: { fail?: Error } = {}) {
  const state = { secret: initial, calls: [] as Call[], regions: [] as string[] };
  class GetSecretValueCommand {
    readonly input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class PutSecretValueCommand {
    readonly input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class SecretsManagerClient {
    constructor(config: { region: string }) {
      state.regions.push(config.region);
    }
    async send(command: GetSecretValueCommand | PutSecretValueCommand) {
      if (options.fail) throw options.fail;
      if (command instanceof GetSecretValueCommand) {
        state.calls.push({ op: "get", input: command.input });
        return { SecretString: state.secret };
      }
      state.calls.push({ op: "put", input: command.input });
      state.secret = command.input.SecretString as string;
      return {};
    }
  }
  const sdk = { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand };
  return { state, deps: { loadSdk: async () => sdk as unknown as SecretsSdk } };
}

function context() {
  const out = { stdout: "", stderr: "" };
  const ctx = {
    env: {},
    cwd: "/",
    home: "/",
    stdin: process.stdin,
    stdout: {
      write: (s: string) => {
        out.stdout += s;
        return true;
      },
    },
    stderr: {
      write: (s: string) => {
        out.stderr += s;
        return true;
      },
    },
  } as unknown as CliContext;
  return { ctx, out };
}

describe("artifact token create", () => {
  it("stores the hash, prints the token once and only on stdout", async () => {
    const { state, deps } = fakeSdk();
    const { ctx, out } = context();
    assert.equal(await run(["create", "laptop", "--secret", ARN], ctx, deps), 0);
    const token = out.stdout.trim();
    assert.match(token, /^art_[A-Za-z0-9_-]{43}$/);
    assert.equal(out.stdout, `${token}\n`);
    assert.match(out.stderr, /store this token now; it is not shown again/);
    assert.match(out.stderr, /up to 5 minutes/);
    assert.ok(!out.stderr.includes(token));
    const stored = parseTokenSecret(state.secret);
    assert.equal(stored.tokens.length, 1);
    assert.equal(stored.tokens[0].name, "laptop");
    assert.equal(stored.tokens[0].sha256, hashToken(token));
    assert.ok(!Number.isNaN(Date.parse(stored.tokens[0].createdAt)));
    assert.ok(!out.stdout.includes(stored.tokens[0].sha256));
    assert.ok(!out.stderr.includes(stored.tokens[0].sha256));
    assert.deepEqual(
      state.calls.map((c) => [c.op, c.input.SecretId]),
      [
        ["get", ARN],
        ["put", ARN],
      ],
    );
    assert.deepEqual(state.regions, ["eu-north-1"]);
  });

  it("prints {name, token} with --json", async () => {
    const { state, deps } = fakeSdk();
    const { ctx, out } = context();
    assert.equal(await run(["create", "ci", "--secret", ARN, "--json"], ctx, deps), 0);
    const printed = JSON.parse(out.stdout) as { name: string; token: string };
    assert.deepEqual(Object.keys(printed), ["name", "token"]);
    assert.equal(printed.name, "ci");
    assert.equal(parseTokenSecret(state.secret).tokens[0].sha256, hashToken(printed.token));
  });

  it("refuses a taken name and the 101st token", async () => {
    const { deps } = fakeSdk();
    await run(["create", "a", "--secret", ARN], context().ctx, deps);
    await assert.rejects(
      run(["create", "a", "--secret", ARN], context().ctx, deps),
      (e: CliError) => e.code === "token_exists",
    );
    const full = JSON.stringify({
      version: 1,
      tokens: Array.from({ length: 100 }, (_, i) => ({
        name: `t${i}`,
        sha256: "a".repeat(64),
        createdAt: "x",
      })),
    });
    await assert.rejects(
      run(["create", "b", "--secret", ARN], context().ctx, fakeSdk(full).deps),
      (e: CliError) => e.code === "too_many_tokens",
    );
  });
});

describe("artifact token revoke and list", () => {
  it("revokes by name and lists names and dates without hashes", async () => {
    const { state, deps } = fakeSdk();
    await run(["create", "a", "--secret", ARN], context().ctx, deps);
    await run(["create", "b", "--secret", ARN], context().ctx, deps);
    const hashes = parseTokenSecret(state.secret).tokens.map((t) => t.sha256);

    const listed = context();
    assert.equal(await run(["list", "--secret", ARN], listed.ctx, deps), 0);
    assert.match(listed.out.stdout, /^NAME +CREATED\na +\S+\nb +\S+\n$/);
    const json = context();
    await run(["list", "--secret", ARN, "--json"], json.ctx, deps);
    const { tokens } = JSON.parse(json.out.stdout) as { tokens: Record<string, unknown>[] };
    assert.deepEqual(
      tokens.map((t) => Object.keys(t)),
      [
        ["name", "createdAt"],
        ["name", "createdAt"],
      ],
    );

    const revoked = context();
    assert.equal(await run(["revoke", "a", "--secret", ARN], revoked.ctx, deps), 0);
    assert.match(revoked.out.stderr, /within 5 minutes/);
    assert.deepEqual(
      parseTokenSecret(state.secret).tokens.map((t) => t.name),
      ["b"],
    );
    await assert.rejects(
      run(["revoke", "a", "--secret", ARN], context().ctx, deps),
      (e: CliError) => e.code === "not_found",
    );
    for (const out of [listed.out, json.out, revoked.out]) {
      for (const hash of hashes) {
        assert.ok(!out.stdout.includes(hash) && !out.stderr.includes(hash));
      }
    }

    const empty = context();
    await run(["list", "--secret", ARN], empty.ctx, fakeSdk().deps);
    assert.equal(empty.out.stdout, "no tokens\n");
  });
});

describe("artifact token errors", () => {
  it("rejects a bad ARN, a bad name and a bad subcommand as usage errors", async () => {
    const { deps } = fakeSdk();
    const usage = [
      ["create", "a"],
      ["create", "a", "--secret", "arn:aws:s3:::bucket"],
      ["create", "a", "--secret", "arn:aws:secretsmanager:eu-north-1:123:secret:x"],
      ["create", "-bad", "--secret", ARN],
      ["create", "a b", "--secret", ARN],
      ["create", "--secret", ARN],
      ["list", "x", "--secret", ARN],
      ["rotate", "--secret", ARN],
      [],
    ];
    for (const args of usage) {
      await assert.rejects(run(args, context().ctx, deps), UsageError, args.join(" "));
    }
  });

  it("takes the client region from the ARN", async () => {
    const { state, deps } = fakeSdk();
    const arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:x-AbCdEf";
    await run(["list", "--secret", arn], context().ctx, deps);
    assert.deepEqual(state.regions, ["us-west-2"]);
  });

  it("maps AWS errors to aws_error and a malformed secret to bad_secret", async () => {
    const denied = Object.assign(new Error("not authorized to perform GetSecretValue"), {
      name: "AccessDeniedException",
    });
    await assert.rejects(
      run(["list", "--secret", ARN], context().ctx, fakeSdk(EMPTY, { fail: denied }).deps),
      (e: CliError) =>
        e.code === "aws_error" &&
        e.message === "AccessDeniedException: not authorized to perform GetSecretValue",
    );
    const secret = '{"version":1,"tokens":[{"name":"a","sha256":"SECRETVALUE"}]}';
    await assert.rejects(
      run(["list", "--secret", ARN], context().ctx, fakeSdk(secret).deps),
      (e: CliError) => e.code === "bad_secret" && !e.message.includes("SECRETVALUE"),
    );
  });

  it("names the install command when the SDK peer is missing", async () => {
    const missing = Object.assign(
      new Error("Cannot find package '@aws-sdk/client-secrets-manager' imported from /x"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    await assert.rejects(
      run(["list", "--secret", ARN], context().ctx, {
        loadSdk: () => Promise.reject(missing),
      }),
      (e: CliError) =>
        e.code === "missing_dependency" &&
        e.message.includes("npm install @aws-sdk/client-secrets-manager"),
    );
  });

  it("isMissingModule recognises a real failed import of that package only", async () => {
    const name = "@aws-sdk/definitely-missing-xyz";
    const error = await import(name).then(
      () => assert.fail("import should fail"),
      (e: unknown) => e,
    );
    assert.equal(isMissingModule(error, name), true);
    assert.equal(isMissingModule(error, "@aws-sdk/client-secrets-manager"), false);
    assert.equal(isMissingModule(new Error("boom"), name), false);
  });
});
