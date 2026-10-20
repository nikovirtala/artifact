// The Lambda environment contract (docs/decisions/0066, 0067): written by the construct,
// parsed here; errors name the variable and never echo the bucket or the ARN.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseControlEnv } from "../../src/runtime/env.ts";

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
