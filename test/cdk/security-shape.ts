// The least-privilege shape of an `ArtifactHosting` template (docs/decisions/0070), compared as
// sets of expanded statements, so CDK merging statements (`@aws-cdk/aws-iam:minimizePolicies`)
// or splitting policies does not change the result.
import assert from "node:assert/strict";
import { Stack } from "aws-cdk-lib";
import type { Template } from "aws-cdk-lib/assertions";
import type { ArtifactHosting } from "../../src/cdk/index.ts";

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: unknown;
};
type Resource = { Type: string; Properties: Record<string, unknown> };

const AUTO_DELETE = "CustomS3AutoDeleteObjectsCustomResourceProvider";
const list = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

/** `Effect Action Resource` for every action × resource of the statements. */
function triples(statements: Statement[]): string[] {
  return statements
    .flatMap((s) =>
      list(s.Action).flatMap((action) =>
        list(s.Resource).map((resource) => `${s.Effect} ${action} ${JSON.stringify(resource)}`),
      ),
    )
    .sort();
}

/** Every statement attached to the role `logicalId`: inline policies and `AWS::IAM::Policy`. */
function roleStatements(resources: Record<string, Resource>, logicalId: string): Statement[] {
  const role = resources[logicalId];
  const inline = (
    (role.Properties.Policies as { PolicyDocument: { Statement: Statement[] } }[]) ?? []
  ).flatMap((p) => p.PolicyDocument.Statement);
  const attached = Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .filter((r) => (r.Properties.Roles as { Ref?: string }[]).some((ref) => ref.Ref === logicalId))
    .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  return [...inline, ...attached];
}

const logicalIdOf = (stack: Stack, value: string) =>
  (stack.resolve(value) as { Ref?: string; "Fn::GetAtt"?: [string, string] }).Ref ??
  (stack.resolve(value) as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];

export function assertSecurityShape(
  template: Template,
  construct: ArtifactHosting,
  options: { destroy: boolean },
): void {
  const stack = Stack.of(construct);
  const resources = template.toJSON().Resources as Record<string, Resource>;
  const r = (value: string) => stack.resolve(value);
  const objects = r(construct.bucket.arnForObjects("*"));
  const bucket = r(construct.bucket.bucketArn);
  const s3 = (extra: Statement[]): Statement[] => [
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: objects,
    },
    { Effect: "Allow", Action: "s3:ListBucket", Resource: bucket },
    ...extra,
  ];
  const logs = (fn: ArtifactHosting["controlFunction"]): Statement => ({
    Effect: "Allow",
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Resource: r(fn.logGroup.logGroupArn),
  });
  const sweepArn = r(construct.sweepFunction.functionArn);
  const expected: Record<string, Statement[]> = {
    [logicalIdOf(stack, construct.controlFunction.role?.roleArn as string)]: s3([
      logs(construct.controlFunction),
      {
        Effect: "Allow",
        Action: "secretsmanager:GetSecretValue",
        Resource: r(construct.tokenSecret.secretArn),
      },
    ]),
    [logicalIdOf(stack, construct.sweepFunction.role?.roleArn as string)]: s3([
      logs(construct.sweepFunction),
    ]),
    [logicalIdOf(stack, construct.schedulerRole.roleArn)]: [
      {
        Effect: "Allow",
        Action: "lambda:InvokeFunction",
        Resource: [sweepArn, { "Fn::Join": ["", [sweepArn, ":*"]] }],
      },
    ],
  };

  // The stack holds this one construct: its roles are exactly the three (plus CDK's provider).
  const ownRoles = Object.entries(resources)
    .filter(([id, res]) => res.Type === "AWS::IAM::Role" && !id.startsWith(AUTO_DELETE))
    .map(([id]) => id);
  assert.deepEqual(ownRoles.sort(), Object.keys(expected).sort());
  for (const [id, statements] of Object.entries(expected)) {
    assert.deepEqual(triples(roleStatements(resources, id)), triples(statements), id);
    const role = resources[id];
    assert.equal(role.Properties.ManagedPolicyArns, undefined, `${id} has managed policies`);
    for (const t of triples(roleStatements(resources, id))) {
      assert.doesNotMatch(t.split(" ")[1], /\*/, `${id}: wildcard action ${t}`);
    }
  }

  const trust = resources[logicalIdOf(stack, construct.schedulerRole.roleArn)].Properties
    .AssumeRolePolicyDocument as { Statement: Statement[] };
  assert.deepEqual(trust.Statement, [
    {
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "aws:SourceAccount": r(stack.account) } },
      Effect: "Allow",
      Principal: { Service: "scheduler.amazonaws.com" },
    },
  ]);

  // Bucket policy: the two TLS denies, and an Allow only for the auto-delete provider.
  const [policy] = Object.values(resources).filter(
    (res) =>
      res.Type === "AWS::S3::BucketPolicy" &&
      JSON.stringify(res.Properties.Bucket) === JSON.stringify(r(construct.bucket.bucketName)),
  );
  const tuples = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement.flatMap(
    (s) =>
      list(s.Action).flatMap((action) =>
        list(s.Resource).map((resource) =>
          JSON.stringify([s.Effect, s.Principal, action, resource, s.Condition ?? null]),
        ),
      ),
  );
  const denies = tuples.filter((t) => t.startsWith('["Deny"'));
  const allows = tuples.filter((t) => t.startsWith('["Allow"'));
  const tlsDenies = [
    { Bool: { "aws:SecureTransport": "false" } },
    { NumericLessThan: { "s3:TlsVersion": 1.2 } },
  ].flatMap((condition) =>
    [bucket, objects].map((resource) =>
      JSON.stringify(["Deny", { AWS: "*" }, "s3:*", resource, condition]),
    ),
  );
  assert.deepEqual(denies.sort(), tlsDenies.sort());
  if (!options.destroy) {
    assert.deepEqual(allows, []);
  } else {
    assert.ok(allows.length > 0);
    for (const allow of allows) assert.ok(allow.includes(`${AUTO_DELETE}Role`), allow);
  }
}
