// The Cognito identity in M9 (docs/decisions/0069): the user pool and validated owners, no users.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Match } from "aws-cdk-lib/assertions";
import { ArtifactIdentity } from "../../src/cdk/index.ts";
import { hosting } from "./helpers.ts";

describe("ArtifactIdentity.cognito", () => {
  it("creates one user pool without self sign-up, with email sign-in and recovery", () => {
    const { template, construct } = hosting();
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Delete",
      Properties: Match.objectLike({
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        UsernameAttributes: ["email"],
        AutoVerifiedAttributes: ["email"],
        AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] },
        UserPoolName: Match.absent(),
      }),
    });
    template.resourceCountIs("AWS::Cognito::UserPoolUser", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
    assert.ok(construct.identity.userPool);
  });

  it("normalises owners and keeps them on the binding", () => {
    const { construct } = hosting({
      identity: ArtifactIdentity.cognito({ owners: [" Owner@Example.com ", "b@example.org"] }),
    });
    assert.deepEqual(construct.identity.owners, ["owner@example.com", "b@example.org"]);
  });

  it("rejects 0 or more than 50 owners, non-emails and duplicates without echoing the list", () => {
    const secret = "hidden-person@example.com";
    const cases: [unknown, RegExp][] = [
      [[], /give 1 to 50 emails, got 0/],
      [Array.from({ length: 51 }, (_, i) => `o${i}@example.com`), /got 51/],
      [[secret, "not-an-email"], /entry 1 is not an email address/],
      [[secret, ""], /entry 1 is not an email address/],
      [[secret, "HIDDEN-person@example.com "], /entry 1 repeats an earlier owner/],
      ["a@example.com", /must be an array/],
    ];
    for (const [owners, message] of cases) {
      assert.throws(
        () => ArtifactIdentity.cognito({ owners: owners as string[] }),
        (error: Error) => {
          assert.match(error.message, /^identity owners: /);
          assert.match(error.message, message);
          assert.ok(!error.message.includes(secret.split("@")[0]));
          return true;
        },
      );
    }
  });

  it("must be given as an ArtifactIdentity", () => {
    assert.throws(
      () => hosting({ identity: { _bind: () => ({}) } as unknown as ArtifactIdentity }),
      /identity must be an ArtifactIdentity/,
    );
  });
});
