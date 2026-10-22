// Who may view artifacts (docs/decisions/0069, 0084). The Cognito identity creates the user pool
// (unchanged since M9) and, with the M10 login, the public app client, the managed login domain
// and branding, and one invited user per owner.
import { createHash } from "node:crypto";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  CfnUserPoolUser,
  ManagedLoginVersion,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import { normaliseOwners } from "./validate.ts";

/** The OpenID Connect endpoints the viewing Lambda's login uses. */
export interface ArtifactOidcBinding {
  /** The ID token's `iss`: the pool's provider URL (`https://cognito-idp.<region>.amazonaws.com/<id>`). */
  readonly issuer: string;
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly logoutUrl: string;
}

/** What an identity creates inside the hosting construct. */
export interface ArtifactIdentityBinding {
  readonly userPool: UserPool;
  /** Trimmed, lowercased owner emails. */
  readonly owners: readonly string[];
  /** The public app client of the login (code flow + PKCE). */
  readonly userPoolClient: UserPoolClient;
  /** The managed login (v2) prefix domain. */
  readonly userPoolDomain: UserPoolDomain;
  /** One invited user per owner. */
  readonly ownerUsers: readonly CfnUserPoolUser[];
  readonly oidc: ArtifactOidcBinding;
}

export abstract class ArtifactIdentity {
  /** A Cognito user pool for the given owners (1–50 emails; no self sign-up). */
  static cognito(props: { owners: string[] }): ArtifactIdentity {
    return new CognitoIdentity(normaliseOwners(props?.owners));
  }

  /** @internal */
  abstract _bind(scope: Construct, options: { viewDomain: string }): ArtifactIdentityBinding;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The managed login prefix: the view domain (which makes it unique for its owner without the
 * account id) and a hash that also separates two instances. Cognito rejects prefixes containing
 * `aws`, `amazon` or `cognito`, so those fall back to `artifact-<16 hex>`.
 */
function loginDomainPrefix(viewDomain: string, address: string): string {
  const hash = sha256(`${viewDomain}\n${address}`);
  const prefix = `${viewDomain.toLowerCase().replaceAll(".", "-").slice(0, 54)}-${hash.slice(0, 8)}`;
  return /aws|amazon|cognito/.test(prefix) ? `artifact-${hash.slice(0, 16)}` : prefix;
}

class CognitoIdentity extends ArtifactIdentity {
  readonly #owners: readonly string[];

  constructor(owners: string[]) {
    super();
    this.#owners = Object.freeze([...owners]);
  }

  /** @internal */
  _bind(scope: Construct, options: { viewDomain: string }): ArtifactIdentityBinding {
    const { viewDomain } = options;
    // Live since M9 (ArtifactsUserPool7CD5D19D): no prop may change, or the pool is updated.
    const userPool = new UserPool(scope, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // Owners are recreated from the props, so the pool holds nothing to keep.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Public (no secret): PKCE S256 protects the code, which is all Cognito supports (V8).
    const userPoolClient = new UserPoolClient(scope, "ViewClient", {
      userPool,
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL],
        callbackUrls: [`https://${viewDomain}/__artifact/callback`],
        logoutUrls: [`https://${viewDomain}/`],
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      // Used once, at the callback.
      idTokenValidity: Duration.minutes(60),
    });
    const userPoolDomain = new UserPoolDomain(scope, "LoginDomain", {
      userPool,
      cognitoDomain: { domainPrefix: loginDomainPrefix(viewDomain, scope.node.addr) },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    // Managed login v2 shows pages for a client only once it has a branding style.
    const branding = new CfnManagedLoginBranding(scope, "ManagedLoginBranding", {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(userPoolDomain);
    // Ids from the email's hash, so adding or removing an owner never replaces another one.
    // Without messageAction, Cognito emails the invitation with a temporary password (A10).
    const ownerUsers = this.#owners.map(
      (email) =>
        new CfnUserPoolUser(scope, `Owner${sha256(email).slice(0, 12)}`, {
          userPoolId: userPool.userPoolId,
          username: email,
          desiredDeliveryMediums: ["EMAIL"],
          userAttributes: [
            { name: "email", value: email },
            { name: "email_verified", value: "true" },
          ],
        }),
    );
    const baseUrl = userPoolDomain.baseUrl();
    return {
      userPool,
      owners: this.#owners,
      userPoolClient,
      userPoolDomain,
      ownerUsers,
      oidc: {
        issuer: userPool.userPoolProviderUrl,
        clientId: userPoolClient.userPoolClientId,
        authorizeUrl: `${baseUrl}/oauth2/authorize`,
        tokenUrl: `${baseUrl}/oauth2/token`,
        logoutUrl: `${baseUrl}/logout`,
      },
    };
  }
}
