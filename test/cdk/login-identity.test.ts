// The Cognito side of the M10 login (docs/decisions/0084): the public app client, the managed
// login domain and branding, one invited user per owner, and the OIDC binding the viewing Lambda
// reads. The user pool itself stays exactly as M9 created it (identity.test.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Template } from "aws-cdk-lib/assertions";
import { ArtifactHosting, ArtifactIdentity } from "../../src/cdk/index.ts";
import {
  baseProps,
  hosting,
  OWNER,
  resources,
  testStack,
  testZone,
  VIEW,
  viewCertificate,
  ZONE,
} from "./helpers.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ownerId = (email: string) => `Owner${sha256(email).slice(0, 12)}`;
const logicalIdOf = (built: ReturnType<typeof hosting>, value: string) =>
  (built.stack.resolve(value) as { Ref: string }).Ref;

describe("login identity", () => {
  it("creates one public code-flow client for the view domain", () => {
    const { template } = hosting();
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    const [[id, client]] = resources(template, "AWS::Cognito::UserPoolClient");
    assert.match(id, /^ArtifactsViewClient[0-9A-F]{8}$/);
    assert.deepEqual(client.Properties, {
      UserPoolId: { Ref: resources(template, "AWS::Cognito::UserPool")[0][0] },
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ["openid", "email"],
      CallbackURLs: [`https://${VIEW}/__artifact/callback`],
      LogoutURLs: [`https://${VIEW}/`],
      SupportedIdentityProviders: ["COGNITO"],
      PreventUserExistenceErrors: "ENABLED",
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      IdTokenValidity: 60,
      TokenValidityUnits: { IdToken: "minutes" },
    });
  });

  it("derives the managed login prefix from the view domain and the construct address", () => {
    const built = hosting();
    const [[id, domain]] = resources(built.template, "AWS::Cognito::UserPoolDomain");
    assert.match(id, /^ArtifactsLoginDomain[0-9A-F]{8}$/);
    const hash = sha256(`${VIEW}\n${built.construct.node.addr}`);
    assert.deepEqual(domain.Properties, {
      Domain: `art-example-dev-${hash.slice(0, 8)}`,
      UserPoolId: { Ref: resources(built.template, "AWS::Cognito::UserPool")[0][0] },
      ManagedLoginVersion: 2,
    });
  });

  it("truncates the domain part to 54 characters and avoids aws, amazon and cognito", () => {
    const prefix = (name: string) => {
      const stack = testStack();
      const hostedZone = testZone(stack);
      const construct = new ArtifactHosting(stack, "Artifacts", {
        ...baseProps(hostedZone),
        viewDomain: { name, hostedZone, certificate: viewCertificate(stack) },
      });
      const [[, domain]] = resources(Template.fromStack(stack), "AWS::Cognito::UserPoolDomain");
      return { domain: domain.Properties?.Domain, hash: sha256(`${name}\n${construct.node.addr}`) };
    };
    const long = prefix(`${"b".repeat(50)}.${ZONE}`);
    assert.equal(long.domain, `${"b".repeat(50)}-exa-${long.hash.slice(0, 8)}`);
    assert.ok((long.domain as string).length <= 63);
    for (const name of [`aws.${ZONE}`, `my-amazon.${ZONE}`, `cognito.${ZONE}`, `jaws.${ZONE}`]) {
      const { domain, hash } = prefix(name);
      assert.equal(domain, `artifact-${hash.slice(0, 16)}`, name);
    }
    assert.match(prefix(`a.ws.${ZONE}`).domain as string, /^a-ws-example-dev-[0-9a-f]{8}$/);
  });

  it("brands the client with Cognito's values", () => {
    const { template } = hosting();
    template.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 1);
    const [[id, branding]] = resources(template, "AWS::Cognito::ManagedLoginBranding");
    assert.match(id, /^ArtifactsManagedLoginBranding[0-9A-F]{8}$/);
    assert.deepEqual(branding.Properties, {
      UserPoolId: { Ref: resources(template, "AWS::Cognito::UserPool")[0][0] },
      ClientId: { Ref: resources(template, "AWS::Cognito::UserPoolClient")[0][0] },
      UseCognitoProvidedValues: true,
    });
  });

  it("invites one verified user per owner by email, with ids from the email's hash", () => {
    const owners = [OWNER, "second@example.org"];
    const built = hosting({ identity: ArtifactIdentity.cognito({ owners }) });
    const users = resources(built.template, "AWS::Cognito::UserPoolUser");
    assert.equal(users.length, 2);
    for (const email of owners) {
      const user = users.find(([id]) => id.startsWith(`Artifacts${ownerId(email)}`));
      assert.ok(user, email);
      assert.match(user[0], new RegExp(`^Artifacts${ownerId(email)}[0-9A-F]{8}$`));
      // Exact properties: no MessageAction, so Cognito sends the invitation.
      assert.deepEqual(user[1].Properties, {
        UserPoolId: { Ref: resources(built.template, "AWS::Cognito::UserPool")[0][0] },
        Username: email,
        DesiredDeliveryMediums: ["EMAIL"],
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      });
    }
    assert.deepEqual(
      built.construct.identity.ownerUsers.map((u) => logicalIdOf(built, u.ref)).sort(),
      users.map(([id]) => id).sort(),
    );
  });

  it("keeps every owner's logical id when an owner is added or removed", () => {
    const ids = (owners: string[]) =>
      resources(
        hosting({ identity: ArtifactIdentity.cognito({ owners }) }).template,
        "AWS::Cognito::UserPoolUser",
      ).map(([id]) => id);
    const one = ids([OWNER]);
    const two = ids(["first@example.org", OWNER]);
    assert.equal(one.length, 1);
    assert.ok(two.includes(one[0]));
    assert.deepEqual(
      ids(["first@example.org"]),
      two.filter((id) => id !== one[0]),
    );
  });

  it("binds the OIDC endpoints: the pool's provider URL and the login domain's URLs", () => {
    const built = hosting();
    const { identity } = built.construct;
    const r = (value: string) => built.stack.resolve(value);
    const pool = resources(built.template, "AWS::Cognito::UserPool")[0][0];
    const client = resources(built.template, "AWS::Cognito::UserPoolClient")[0][0];
    assert.deepEqual(r(identity.oidc.issuer), { "Fn::GetAtt": [pool, "ProviderURL"] });
    assert.deepEqual(r(identity.oidc.clientId), { Ref: client });
    for (const [key, path] of [
      ["authorizeUrl", "/oauth2/authorize"],
      ["tokenUrl", "/oauth2/token"],
      ["logoutUrl", "/logout"],
    ] as const) {
      assert.deepEqual(r(identity.oidc[key]), r(`${identity.userPoolDomain.baseUrl()}${path}`));
    }
    assert.match(JSON.stringify(r(identity.userPoolDomain.baseUrl())), /amazoncognito\.com/);
    assert.equal(logicalIdOf(built, identity.userPoolClient.userPoolClientId), client);
  });
});
