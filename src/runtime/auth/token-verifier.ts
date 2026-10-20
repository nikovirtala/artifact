// Bearer tokens on AWS (docs/decisions/0065): the SHA-256 hashes from the token secret, cached
// per warm instance for 5 minutes so a revoked token stops within that bound. Refreshes are
// single-flight; a failed refresh rejects (no stale fallback) and is not cached (no negative
// caching), so the next request retries.
import { createHash, timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { TokenVerifier } from "../../http/token.ts";
import { parseTokenSecret } from "../../token-secret.ts";

export const TOKEN_CACHE_TTL_MS = 300_000;

export type TokenVerifierOptions = {
  /** The secret string; called at most once per `ttlMs` while it succeeds. */
  load: () => Promise<string>;
  now?: () => number;
  ttlMs?: number;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const { load, now = Date.now, ttlMs = TOKEN_CACHE_TTL_MS } = options;
  let cache: { digests: Buffer[]; fetchedAt: number } | undefined;
  let inFlight: Promise<Buffer[]> | undefined;

  const refresh = async (): Promise<Buffer[]> => {
    try {
      const { tokens } = parseTokenSecret(await load());
      const digests = tokens.map((t) => Buffer.from(t.sha256, "hex"));
      cache = { digests, fetchedAt: now() };
      return digests;
    } catch (error) {
      // The name only: neither the presented token nor the secret string is in the message.
      throw new Error(`artifact: token list unavailable: ${(error as Error).name}`);
    }
  };

  const digests = (): Promise<Buffer[]> => {
    if (cache !== undefined && now() - cache.fetchedAt < ttlMs) {
      return Promise.resolve(cache.digests);
    }
    inFlight ??= refresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return async (presented) => {
    const stored = await digests();
    const given = sha256(presented);
    let match = false;
    for (const digest of stored) {
      // No early exit: every stored hash is compared.
      if (timingSafeEqual(given, digest)) match = true;
    }
    return match;
  };
}

/** Loads the secret string of `arn`; a secret without `SecretString` is malformed. */
export function secretsManagerLoader(
  arn: string,
  client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({}),
): () => Promise<string> {
  return async () => {
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (SecretString === undefined) throw new TypeError("the token secret has no SecretString");
    return SecretString;
  };
}
