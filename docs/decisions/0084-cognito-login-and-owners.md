# 0084. Cognito app client, managed login and owner users

Status: Accepted (M10)

## Context

The login of 0081 runs OIDC code + PKCE against the construct's Cognito pool. M9 created only the pool and validated the owners, and deferred the users to the login, so the invitations would not expire before a sign-in page exists (0069). The pool is live (`ArtifactsUserPool7CD5D19D`), so M10 must not change it. Facts:

- A public app client has no secret, and that cannot change after creation. Callback URLs must be absolute, pre-registered `https` URLs. Cognito supports PKCE with `S256` only ([App clients](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html); [Using PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)) (V8).
- A prefix domain is `<prefix>.auth.<region>.amazoncognito.com`. With managed login version 2, an app client gets pages only once it has a branding style, which API and SDK callers create themselves. Managed login needs a feature plan other than Lite ([Prefix domain](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain-prefix.html); [CreateUserPoolDomain](https://docs.aws.amazon.com/cli/v1/reference/cognito-idp/create-user-pool-domain.html)) (V8). The live pool is `ESSENTIALS`, and new pools default to Essentials (F9, read-only `DescribeUserPool`).
- `AWS::Cognito::UserPoolUser` with `DesiredDeliveryMediums: [EMAIL]` emails the invitation with a temporary password when the stack deploys. Every property requires replacement on update. `email_verified` can be set to `true` ([AWS::Cognito::UserPoolUser](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpooluser.html)) (A10). The live pool's `UnusedAccountValidityDays` is 7.
- The pool's `ProviderURL` is `https://cognito-idp.<region>.amazonaws.com/<id>`, the ID token's `iss` (F13; [Verifying JSON web tokens](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html)).

## Decision

- **The pool is not modified:** no invitation template, no `featurePlan`, no new props. A construct test pins its properties, and the M9 fixture test of `examples/personal` shows that they are unchanged.
- **`ViewClient`** (`UserPoolClient`): `generateSecret: false`, the authorization code grant only, scopes `openid` and `email`, callback `https://<view>/__artifact/callback`, logout URL `https://<view>/`, the Cognito provider only, `preventUserExistenceErrors`, SRP auth, ID token validity 60 minutes (the token is used once, at the callback). Our client always sends `S256`.
- **`LoginDomain`** (`UserPoolDomain`, `NEWER_MANAGED_LOGIN`) with the prefix `<view domain, dots to dashes, at most 54 characters>-<8 hex>`. The hex is the start of `sha256(viewDomain + "\n" + node address)`. The view domain makes the global prefix unique for its owner without the account id, and the node address separates two instances. A prefix containing `aws`, `amazon` or `cognito`, which Cognito rejects, becomes `artifact-<16 hex>`. For `prod` it is `artifact-nikovirtala-dev-37f43323`.
- **`ManagedLoginBranding`** (`CfnManagedLoginBranding`) for the client with `UseCognitoProvidedValues: true`, created after the domain.
- **Owners:** one `CfnUserPoolUser` per owner with construct id `Owner<first 12 hex of sha256(email)>`. Adding or removing an owner therefore never changes another owner's logical id. Each user has `Username` = the email, `DesiredDeliveryMediums: [EMAIL]`, the `email` attribute and `email_verified` = `"true"`, and no `MessageAction`, so Cognito sends the invitation. Removing an owner from the props deletes that user.
- **Binding** (`construct.identity`): `userPoolClient`, `userPoolDomain`, `ownerUsers` and `oidc` = `{issuer: userPool.userPoolProviderUrl, clientId, authorizeUrl, tokenUrl, logoutUrl}`, where the URLs are the domain's base URL plus `/oauth2/authorize`, `/oauth2/token` and `/logout`. The viewing Lambda gets them through its environment (0082).

## Consequences

The first M10 deploy emails each owner an invitation. The owner must sign in within 7 days, or resend the invitation (`admin-create-user --message-action RESEND`) as the owner's own write; the guide covers this. Deploying with a different `ARTIFACT_OWNERS` than M9 invites or deletes users. The placeholder owner now appears in the synthesized templates, so the `examples/personal` test allows that one address and no other. A second instance gets its own prefix. Because every user property is replace-only, changing how users are created later would re-invite every owner.
