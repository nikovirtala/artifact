// The Lambda environment contract (docs/decisions/0066): what the construct writes, with tokens
// replaced by placeholders, parses with the runtime's own parser.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AWS_LIMIT_DEFAULTS } from "../../src/cdk/index.ts";
import { parseControlEnv, parseSweepEnv } from "../../src/runtime/env.ts";
import { hosting, resources } from "./helpers.ts";

const PLACEHOLDERS: Record<string, string> = {
  ARTIFACT_BUCKET: "bucket",
  ARTIFACT_TOKEN_SECRET_ARN: "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf",
};

function environments(template: ReturnType<typeof hosting>["template"]) {
  return resources(template, "AWS::Lambda::Function").map(([, f]) => {
    const vars = (f.Properties as { Environment: { Variables: Record<string, unknown> } })
      .Environment.Variables;
    return Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? v : PLACEHOLDERS[k]]),
    ) as Record<string, string>;
  });
}

describe("environment contract", () => {
  it("parses with src/runtime/env.ts, defaults and custom limits alike", () => {
    const { maxBodyBytes, ...core } = AWS_LIMIT_DEFAULTS;
    const [control, sweep] = environments(hosting().template).sort(
      (a, b) => Object.keys(b).length - Object.keys(a).length,
    );
    assert.deepEqual(parseControlEnv(control), {
      bucket: "bucket",
      viewDomain: "art.example.dev",
      tokenSecretArn: PLACEHOLDERS.ARTIFACT_TOKEN_SECRET_ARN,
      limits: core,
      maxBodyBytes,
    });
    assert.deepEqual(parseSweepEnv(sweep), { bucket: "bucket", limits: core });
    assert.deepEqual(Object.keys(sweep).sort(), ["ARTIFACT_BUCKET", "ARTIFACT_LIMITS"]);

    const limits = {
      maxFileBytes: 1024,
      maxPublishBytes: 2048,
      maxBodyBytes: 6_000_000,
      maxFiles: 10,
    };
    const custom = environments(hosting({ limits }).template).map((e) =>
      e.ARTIFACT_TOKEN_SECRET_ARN ? parseControlEnv(e) : parseSweepEnv(e),
    );
    for (const parsed of custom) {
      assert.deepEqual(parsed.limits, { maxFileBytes: 1024, maxPublishBytes: 2048, maxFiles: 10 });
    }
  });
});
