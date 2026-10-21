// The Lambda environment contract (docs/decisions/0066, 0082): what the construct writes, with
// tokens replaced by placeholders, parses with the runtime's own parser.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArtifactIdentity, AWS_LIMIT_DEFAULTS } from "../../src/cdk/index.ts";
import { parseControlEnv, parseSweepEnv, parseViewingEnv } from "../../src/runtime/env.ts";
import { hosting, resources } from "./helpers.ts";

const PLACEHOLDERS: Record<string, string> = {
  ARTIFACT_BUCKET: "bucket",
  ARTIFACT_TOKEN_SECRET_ARN: "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf",
  ARTIFACT_SESSION_SECRET_ARN: "arn:aws:secretsmanager:eu-north-1:000000000000:secret:s-AbCdEf",
  ARTIFACT_OIDC_ISSUER: "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_example",
  ARTIFACT_OIDC_AUTHORIZE_URL: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/authorize",
  ARTIFACT_OIDC_TOKEN_URL: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/token",
  ARTIFACT_OIDC_LOGOUT_URL: "https://login.auth.eu-north-1.amazoncognito.com/logout",
  ARTIFACT_OIDC_CLIENT_ID: "client",
};

/** The environment of each `index.handler` function with one, by its construct id. */
function environments(template: ReturnType<typeof hosting>["template"]) {
  return Object.fromEntries(
    resources(template, "AWS::Lambda::Function").flatMap(([id, f]) => {
      const vars = (f.Properties as { Environment?: { Variables: Record<string, unknown> } })
        .Environment?.Variables;
      if (vars === undefined) return [];
      const name = id.replace(/^Artifacts/, "").replace(/[0-9A-F]{8}$/, "");
      const env = Object.entries(vars).map(([k, v]) => [
        k,
        typeof v === "string" ? v : PLACEHOLDERS[k],
      ]);
      return [[name, Object.fromEntries(env) as Record<string, string>]];
    }),
  );
}

describe("environment contract", () => {
  it("parses with src/runtime/env.ts, defaults and custom limits alike", () => {
    const { maxBodyBytes, ...core } = AWS_LIMIT_DEFAULTS;
    const { ControlFunction: control, SweepFunction: sweep } = environments(hosting().template);
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
    const custom = environments(hosting({ limits }).template);
    for (const parsed of [
      parseControlEnv(custom.ControlFunction),
      parseSweepEnv(custom.SweepFunction),
    ]) {
      assert.deepEqual(parsed.limits, { maxFileBytes: 1024, maxPublishBytes: 2048, maxFiles: 10 });
    }
  });

  it("gives the viewing function an environment parseViewingEnv accepts", () => {
    const { template, construct, stack } = hosting();
    const { ViewFunction: view } = environments(template);
    assert.deepEqual(parseViewingEnv(view), {
      bucket: "bucket",
      viewDomain: "art.example.dev",
      sessionSecretArn: PLACEHOLDERS.ARTIFACT_SESSION_SECRET_ARN,
      oidc: {
        issuer: PLACEHOLDERS.ARTIFACT_OIDC_ISSUER,
        authorizeUrl: PLACEHOLDERS.ARTIFACT_OIDC_AUTHORIZE_URL,
        tokenUrl: PLACEHOLDERS.ARTIFACT_OIDC_TOKEN_URL,
        logoutUrl: PLACEHOLDERS.ARTIFACT_OIDC_LOGOUT_URL,
        clientId: PLACEHOLDERS.ARTIFACT_OIDC_CLIENT_ID,
      },
      owners: ["owner@example.com"],
    });
    // The issuer is the pool's ProviderURL, which equals the ID token's iss (F13).
    const [[, fn]] = resources(template, "AWS::Lambda::Function").filter(([id]) =>
      id.startsWith("ArtifactsViewFunction"),
    );
    const vars = (fn.Properties as { Environment: { Variables: Record<string, unknown> } })
      .Environment.Variables;
    const pool = stack.resolve(construct.identity.userPool.userPoolId) as { Ref: string };
    assert.deepEqual(vars.ARTIFACT_OIDC_ISSUER, { "Fn::GetAtt": [pool.Ref, "ProviderURL"] });
  });

  it("keeps the viewing environment within 3500 bytes, counting tokens at their bound", () => {
    const owners = Array.from({ length: 50 }, (_, i) => `owner-${i}-${"x".repeat(40)}@example.com`);
    assert.throws(
      () => hosting({ identity: ArtifactIdentity.cognito({ owners }) }),
      /^Error: viewing environment exceeds 3500 bytes \(owners use \d+\); use fewer owners or a shorter view domain$/,
    );
    const fits = owners.slice(0, 20);
    hosting({ identity: ArtifactIdentity.cognito({ owners: fits }) });
  });
});
