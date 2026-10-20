// The data bucket (docs/decisions/0070): private, SSE-S3, TLS 1.2+ only, no versioning, owner
// enforced, retained by default; DESTROY empties and deletes it (docs/decisions/0067).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RemovalPolicy } from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import { hosting, resources } from "./helpers.ts";

type Statement = { Effect: string; Principal?: unknown; Action: unknown; Condition?: unknown };

function policyStatements(template: ReturnType<typeof hosting>["template"]): Statement[] {
  const [[, policy]] = resources(template, "AWS::S3::BucketPolicy");
  return (policy.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument
    .Statement;
}

describe("ArtifactHosting bucket", () => {
  it("is private, encrypted, TLS-only, unversioned and owner-enforced", () => {
    const { template } = hosting();
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
      LifecycleConfiguration: {
        Rules: [{ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: "Enabled" }],
      },
      VersioningConfiguration: Match.absent(),
      BucketName: Match.absent(),
    });
  });

  it("denies non-TLS and TLS < 1.2 and allows nobody by default", () => {
    const statements = policyStatements(hosting().template);
    assert.deepEqual(
      statements.map((s) => [s.Effect, s.Condition]),
      [
        ["Deny", { Bool: { "aws:SecureTransport": "false" } }],
        ["Deny", { NumericLessThan: { "s3:TlsVersion": 1.2 } }],
      ],
    );
    for (const s of statements) assert.deepEqual(s.Principal, { AWS: "*" });
  });

  it("is retained by default, without auto-delete", () => {
    const { template } = hosting();
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
    const explicit = hosting({ dataRetention: { onDestroy: RemovalPolicy.RETAIN } }).template;
    explicit.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  it("is emptied and deleted under DESTROY, with one Allow for the auto-delete provider", () => {
    const { template } = hosting({ dataRetention: { onDestroy: RemovalPolicy.DESTROY } });
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
    const statements = policyStatements(template);
    const allows = statements.filter((s) => s.Effect === "Allow");
    assert.equal(allows.length, 1);
    assert.match(
      JSON.stringify(allows[0].Principal),
      /CustomS3AutoDeleteObjectsCustomResourceProviderRole/,
    );
    assert.equal(statements.filter((s) => s.Effect === "Deny").length, 2);
  });

  it("rejects onDestroy other than RETAIN or DESTROY and empty versions", () => {
    assert.throws(
      () => hosting({ dataRetention: { onDestroy: RemovalPolicy.SNAPSHOT } }),
      /dataRetention.onDestroy must be RemovalPolicy.RETAIN or RemovalPolicy.DESTROY/,
    );
    assert.throws(
      () => hosting({ dataRetention: { versions: {} } }),
      /dataRetention.versions must set keepLast, olderThan or both/,
    );
    assert.throws(
      () => hosting({ dataRetention: { versions: { keepLast: 0 } } }),
      /keepLast must be a positive integer/,
    );
  });
});
