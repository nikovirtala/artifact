// The Lambda environment contract (docs/decisions/0066, 0067): written by the construct,
// parsed here; errors name the variable and never echo the bucket or the ARN.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseControlEnv, parseSweepEnv, parseViewingEnv } from "../../src/runtime/env.ts";

const ARN = "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf";
const LIMITS = '{"maxFileBytes":3145728,"maxPublishBytes":3145728,"maxFiles":500}';
const CONTROL = {
  ARTIFACT_BUCKET: "bucket-SECRETNAME",
  ARTIFACT_VIEW_DOMAIN: "art.example.dev",
  ARTIFACT_TOKEN_SECRET_ARN: ARN,
  ARTIFACT_LIMITS: LIMITS,
  ARTIFACT_MAX_BODY_BYTES: "4500000",
};

/** Asserts `fn` throws an error naming `variable` and quoting none of `hidden`. */
function throwsNaming(fn: () => unknown, variable: string, hidden: string[] = []) {
  assert.throws(fn, (error: Error) => {
    assert.match(error.message, new RegExp(`^artifact: ${variable} `));
    for (const h of hidden) assert.ok(!error.message.includes(h), `${variable} echoes ${h}`);
    return true;
  });
}

describe("parseControlEnv", () => {
  it("parses the construct's environment", () => {
    assert.deepEqual(parseControlEnv(CONTROL), {
      bucket: "bucket-SECRETNAME",
      viewDomain: "art.example.dev",
      tokenSecretArn: ARN,
      limits: { maxFileBytes: 3145728, maxPublishBytes: 3145728, maxFiles: 500 },
      maxBodyBytes: 4500000,
    });
  });

  it("names a missing or invalid variable without echoing its value", () => {
    for (const name of Object.keys(CONTROL)) {
      throwsNaming(() => parseControlEnv({ ...CONTROL, [name]: undefined }), name);
      throwsNaming(() => parseControlEnv({ ...CONTROL, [name]: "" }), name);
    }
    throwsNaming(
      () => parseControlEnv({ ...CONTROL, ARTIFACT_VIEW_DOMAIN: "https://SECRETDOMAIN/" }),
      "ARTIFACT_VIEW_DOMAIN",
      ["SECRETDOMAIN"],
    );
    for (const arn of [
      "arn:aws:s3:::SECRETARN",
      "arn:aws:secretsmanager:eu-north-1:1:secret:SECRETARN",
    ]) {
      throwsNaming(
        () => parseControlEnv({ ...CONTROL, ARTIFACT_TOKEN_SECRET_ARN: arn }),
        "ARTIFACT_TOKEN_SECRET_ARN",
        ["SECRETARN"],
      );
    }
    for (const limits of [
      "[]",
      "{",
      "null",
      '{"maxFileBytes":1,"maxPublishBytes":1}',
      '{"maxFileBytes":1,"maxPublishBytes":1,"maxFiles":1,"maxLabelChars":1}',
      '{"maxFileBytes":0,"maxPublishBytes":1,"maxFiles":1}',
      '{"maxFileBytes":1.5,"maxPublishBytes":1,"maxFiles":1}',
      '{"maxFileBytes":"1","maxPublishBytes":1,"maxFiles":1}',
    ]) {
      throwsNaming(
        () => parseControlEnv({ ...CONTROL, ARTIFACT_LIMITS: limits }),
        "ARTIFACT_LIMITS",
      );
    }
    for (const cap of ["0", "-1", "1.5", "4e6", "x"]) {
      throwsNaming(
        () => parseControlEnv({ ...CONTROL, ARTIFACT_MAX_BODY_BYTES: cap }),
        "ARTIFACT_MAX_BODY_BYTES",
      );
    }
  });
});

describe("parseViewingEnv", () => {
  const COGNITO = "https://login-SECRETPREFIX.auth.eu-north-1.amazoncognito.com";
  const VIEWING = {
    ARTIFACT_BUCKET: "bucket-SECRETNAME",
    ARTIFACT_VIEW_DOMAIN: "art.example.dev",
    ARTIFACT_SESSION_SECRET_ARN: ARN,
    ARTIFACT_OIDC_ISSUER: "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Test",
    ARTIFACT_OIDC_AUTHORIZE_URL: `${COGNITO}/oauth2/authorize`,
    ARTIFACT_OIDC_TOKEN_URL: `${COGNITO}/oauth2/token`,
    ARTIFACT_OIDC_LOGOUT_URL: `${COGNITO}/logout`,
    ARTIFACT_OIDC_CLIENT_ID: "abc123+_-XYZ",
    ARTIFACT_OWNERS: '["owner@example.com","second@example.com"]',
  };

  it("parses the construct's environment", () => {
    assert.deepEqual(parseViewingEnv(VIEWING), {
      bucket: "bucket-SECRETNAME",
      viewDomain: "art.example.dev",
      sessionSecretArn: ARN,
      oidc: {
        issuer: VIEWING.ARTIFACT_OIDC_ISSUER,
        authorizeUrl: VIEWING.ARTIFACT_OIDC_AUTHORIZE_URL,
        tokenUrl: VIEWING.ARTIFACT_OIDC_TOKEN_URL,
        logoutUrl: VIEWING.ARTIFACT_OIDC_LOGOUT_URL,
        clientId: "abc123+_-XYZ",
      },
      owners: ["owner@example.com", "second@example.com"],
    });
  });

  it("needs neither the token secret nor the limits", () => {
    const parsed = parseViewingEnv({ ...VIEWING, ARTIFACT_TOKEN_SECRET_ARN: undefined });
    assert.equal(parsed.bucket, "bucket-SECRETNAME");
  });

  it("names a missing or invalid variable without echoing its value", () => {
    for (const name of Object.keys(VIEWING)) {
      throwsNaming(() => parseViewingEnv({ ...VIEWING, [name]: undefined }), name);
      throwsNaming(() => parseViewingEnv({ ...VIEWING, [name]: "" }), name);
    }
    throwsNaming(
      () => parseViewingEnv({ ...VIEWING, ARTIFACT_VIEW_DOMAIN: "https://SECRETDOMAIN/" }),
      "ARTIFACT_VIEW_DOMAIN",
      ["SECRETDOMAIN"],
    );
    throwsNaming(
      () => parseViewingEnv({ ...VIEWING, ARTIFACT_SESSION_SECRET_ARN: "arn:aws:s3:::SECRETARN" }),
      "ARTIFACT_SESSION_SECRET_ARN",
      ["SECRETARN"],
    );
    for (const name of [
      "ARTIFACT_OIDC_ISSUER",
      "ARTIFACT_OIDC_AUTHORIZE_URL",
      "ARTIFACT_OIDC_TOKEN_URL",
      "ARTIFACT_OIDC_LOGOUT_URL",
    ]) {
      for (const url of ["http://SECRETHOST/x", "SECRETHOST", "ftp://SECRETHOST/"]) {
        throwsNaming(() => parseViewingEnv({ ...VIEWING, [name]: url }), name, ["SECRETHOST"]);
      }
    }
    for (const id of ["a b", "x".repeat(129), "SECRET/ID", "é"]) {
      throwsNaming(
        () => parseViewingEnv({ ...VIEWING, ARTIFACT_OIDC_CLIENT_ID: id }),
        "ARTIFACT_OIDC_CLIENT_ID",
        ["SECRET"],
      );
    }
    const many = JSON.stringify(Array.from({ length: 51 }, (_, i) => `o${i}@example.com`));
    for (const owners of [
      "[]",
      "{",
      '"secret@example.com"',
      '["SECRET@example.com"]',
      '["secret-not-an-email"]',
      '["secret@example.com", 5]',
      '[" secret@example.com"]',
      many,
    ]) {
      throwsNaming(
        () => parseViewingEnv({ ...VIEWING, ARTIFACT_OWNERS: owners }),
        "ARTIFACT_OWNERS",
        ["secret", "SECRET"],
      );
    }
    const fifty = JSON.stringify(Array.from({ length: 50 }, (_, i) => `o${i}@example.com`));
    assert.equal(parseViewingEnv({ ...VIEWING, ARTIFACT_OWNERS: fifty }).owners.length, 50);
  });
});

describe("parseSweepEnv", () => {
  it("needs only the bucket and the limits", () => {
    const env = { ARTIFACT_BUCKET: "b", ARTIFACT_LIMITS: LIMITS };
    assert.deepEqual(parseSweepEnv(env), {
      bucket: "b",
      limits: { maxFileBytes: 3145728, maxPublishBytes: 3145728, maxFiles: 500 },
    });
    throwsNaming(() => parseSweepEnv({ ARTIFACT_LIMITS: LIMITS }), "ARTIFACT_BUCKET");
    throwsNaming(() => parseSweepEnv({ ARTIFACT_BUCKET: "b" }), "ARTIFACT_LIMITS");
    throwsNaming(
      () => parseSweepEnv({ ARTIFACT_BUCKET: "b", ARTIFACT_LIMITS: "{}" }),
      "ARTIFACT_LIMITS",
    );
  });
});
