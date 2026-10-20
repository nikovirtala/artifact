// Who may view artifacts (docs/decisions/0069). In M9 the Cognito identity creates the user pool
// and validates the owners; owner users, the app client and managed login arrive with the M10
// login, because invitations would expire before a login page exists.
import { RemovalPolicy } from "aws-cdk-lib";
import { AccountRecovery, UserPool } from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import { normaliseOwners } from "./validate.ts";

/** What an identity creates inside the hosting construct. */
export interface ArtifactIdentityBinding {
  readonly userPool: UserPool;
  /** Trimmed, lowercased owner emails. */
  readonly owners: readonly string[];
}

export abstract class ArtifactIdentity {
  /** A Cognito user pool for the given owners (1–50 emails; no self sign-up). */
  static cognito(props: { owners: string[] }): ArtifactIdentity {
    return new CognitoIdentity(normaliseOwners(props?.owners));
  }

  /** @internal */
  abstract _bind(scope: Construct): ArtifactIdentityBinding;
}

class CognitoIdentity extends ArtifactIdentity {
  readonly #owners: readonly string[];

  constructor(owners: string[]) {
    super();
    this.#owners = Object.freeze([...owners]);
  }

  /** @internal */
  _bind(scope: Construct): ArtifactIdentityBinding {
    const userPool = new UserPool(scope, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // Owners are recreated from the props, so the pool holds nothing to keep.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    return { userPool, owners: this.#owners };
  }
}
