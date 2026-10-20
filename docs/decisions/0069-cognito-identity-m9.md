# 0069. Cognito identity in M9: the user pool and validated owners; users arrive with the M10 login

Status: Accepted (M9)

## Context

The construct API takes `identity: ArtifactIdentity.cognito({owners})` (`docs/01-plan-aws.md`, "Construct API"): a Cognito user pool with self sign-up off, an `AWS::Cognito::UserPoolUser` per owner whose invitation email carries a temporary password, and managed login on the view domain. M9 has no viewing plane and no login (M10). A CloudFormation-created user with `DesiredDeliveryMediums: [EMAIL]` gets the invitation when the stack deploys ([`AWS::Cognito::UserPoolUser`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpooluser.html), A10 in the M9 AWS facts); re-sending it later means `MessageAction: RESEND`, an update that replaces the user.

## Decision

- `ArtifactIdentity.cognito({owners})` validates and normalises the owners when called: 1 to 50 entries, each an email after trimming and lowercasing, no duplicates. Errors start with `identity owners:` and name the entry's index, never the list.
- Bound into `ArtifactHosting`, it creates one `UserPool`: `selfSignUpEnabled: false`, email as the sign-in alias, email auto-verified, account recovery by email only, `RemovalPolicy.DESTROY` (the owners are recreated from the props, so the pool holds nothing worth keeping). No physical name.
- **No users, app client or managed login in M9.** `construct.identity` exposes `{userPool, owners}`; M10 creates the owner users together with the login routes.

## Consequences

Invitations would expire (temporary passwords are valid for days) before any login page exists, so creating users now would make the owner re-send them in M10. The owners are still required and checked from M9, so the stage config and the `ARTIFACT_OWNERS` handling of `examples/personal` do not change in M10.
