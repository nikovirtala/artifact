// The test resources stack (docs/decisions/0063), checked on its synthesized template only: it
// is defined here and deployed by the owner, never by tests or agents.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { App, BootstraplessSynthesizer } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { TestResourcesStack, type TestResourcesStackProps } from "../lib/test-resources-stack.ts";

function synth(props: Partial<TestResourcesStackProps> = {}) {
  const app = new App();
  const stack = new TestResourcesStack(app, "ArtifactTestResources", {
    synthesizer: new BootstraplessSynthesizer(),
    githubRepository: "owner/repo",
    ...props,
  });
  const template = Template.fromStack(stack);
  const artifact = app.synth().getStackByName(stack.stackName);
  return { template, artifact };
}

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Condition?: unknown;
  Principal?: unknown;
};

describe("TestResourcesStack", () => {
  it("has one private, SSE-S3, TLS-only bucket whose objects expire after a day", () => {
    const { template } = synth();
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      Properties: {
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
        LifecycleConfiguration: {
          Rules: [
            Match.objectLike({
              Status: "Enabled",
              ExpirationInDays: 1,
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            }),
          ],
        },
        VersioningConfiguration: Match.absent(),
        BucketName: Match.absent(),
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: "s3:*",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("needs no bootstrap: no Lambda, no custom resource, no asset", () => {
    const { template, artifact } = synth();
    const types = Object.values(
      template.toJSON().Resources as Record<string, { Type: string }>,
    ).map((r) => r.Type);
    assert.deepEqual(
      types.filter((t) => t === "AWS::Lambda::Function" || t.startsWith("Custom::")),
      [],
    );
    assert.deepEqual(artifact.assets, []);
  });

  it("lets only the repo's s3-contract environment assume the role, for an hour", () => {
    const { template } = synth();
    template.resourceCountIs("AWS::IAM::OIDCProvider", 1);
    template.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
    const roles = template.findResources("AWS::IAM::Role");
    assert.equal(Object.keys(roles).length, 1);
    const [role] = Object.values(roles) as {
      Properties: {
        MaxSessionDuration: number;
        AssumeRolePolicyDocument: { Statement: Statement[] };
      };
    }[];
    assert.equal(role.Properties.MaxSessionDuration, 3600);
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;
    assert.equal(trust.length, 1);
    assert.equal(trust[0].Action, "sts:AssumeRoleWithWebIdentity");
    assert.deepEqual(trust[0].Condition, {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:owner/repo:environment:s3-contract",
      },
    });
  });

  it("grants list on the bucket and get/put/delete on its objects, nothing else", () => {
    const { template } = synth();
    const policies = [
      ...Object.values(template.findResources("AWS::IAM::Policy")),
      ...Object.values(template.findResources("AWS::IAM::Role")).flatMap(
        (r) => (r as { Properties: { Policies?: unknown[] } }).Properties.Policies ?? [],
      ),
    ];
    const statements = policies.flatMap((p) => {
      const doc = p as { Properties?: { PolicyDocument: unknown }; PolicyDocument?: unknown };
      return ((doc.Properties?.PolicyDocument ?? doc.PolicyDocument) as { Statement: Statement[] })
        .Statement;
    });
    const bucketRef = Object.keys(template.findResources("AWS::S3::Bucket"))[0];
    assert.deepEqual(statements, [
      { Effect: "Allow", Action: "s3:ListBucket", Resource: { "Fn::GetAtt": [bucketRef, "Arn"] } },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": [bucketRef, "Arn"] }, "/*"]] },
      },
    ]);
  });

  it("imports an existing GitHub OIDC provider by ARN instead of creating one", () => {
    const arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com";
    const { template } = synth({ githubOidcProviderArn: arn, githubEnvironment: "ci" });
    template.resourceCountIs("AWS::IAM::OIDCProvider", 0);
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Federated: arn },
            Condition: {
              StringEquals: Match.objectLike({
                "token.actions.githubusercontent.com:sub": "repo:owner/repo:environment:ci",
              }),
            },
          }),
        ],
      },
    });
  });

  it("outputs the bucket name and the role ARN", () => {
    const { template } = synth();
    template.hasOutput("BucketName", {});
    template.hasOutput("RoleArn", {});
  });
});
