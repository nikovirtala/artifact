// The session key set on the viewing Lambda (docs/decisions/0079): read from the session secret
// and cached per warm instance for 5 minutes, as the token list is (0065; token-verifier.ts is
// left as it is so the control bundle does not change). After a rotation a warm instance may
// still hold the old set while the callback sees a transaction cookie signed with the new kid,
// so an unknown kid forces one reload, at most once per 60 seconds, which also bounds the
// Secrets Manager calls forged kids can cause.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { type KeySet, parseKeySet } from "./session.ts";

export const KEY_CACHE_TTL_MS = 300_000;
export const KEY_MISS_RELOAD_MS = 60_000;

/** Loads and parses the session secret of `arn`; a secret without `SecretString` is malformed. */
export function sessionSecretLoader(
  arn: string,
  client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({}),
): () => Promise<KeySet> {
  return async () => {
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (SecretString === undefined) throw new TypeError("the session secret has no SecretString");
    return parseKeySet(SecretString);
  };
}

export type KeyCache = {
  /** The cached set while younger than the TTL, else a reload; a failed load rejects. */
  get(): Promise<KeySet>;
  /**
   * The cached set if it holds `kid`. Otherwise one forced reload (shared by concurrent misses,
   * at most once per `missReloadMs`); if that is not allowed yet or fails, the cached set as it
   * is, so the caller's verification fails closed.
   */
  forKid(kid: string): Promise<KeySet>;
};

export function createKeyCache(
  load: () => Promise<KeySet>,
  options: { ttlMs?: number; missReloadMs?: number; now?: () => number } = {},
): KeyCache {
  const { ttlMs = KEY_CACHE_TTL_MS, missReloadMs = KEY_MISS_RELOAD_MS, now = Date.now } = options;
  let cache: { set: KeySet; at: number } | undefined;
  let loading: Promise<KeySet> | undefined;
  let forcing: Promise<KeySet> | undefined;
  let lastForced: number | undefined;

  const reload = async (): Promise<KeySet> => {
    const set = await load();
    cache = { set, at: now() };
    return set;
  };

  const get = (): Promise<KeySet> => {
    if (cache !== undefined && now() - cache.at < ttlMs) return Promise.resolve(cache.set);
    loading ??= reload().finally(() => {
      loading = undefined;
    });
    return loading;
  };

  const force = (fallback: KeySet): Promise<KeySet> => {
    forcing ??= (async () => {
      lastForced = now();
      try {
        return await reload();
      } catch (error) {
        const name = (error as Error | undefined)?.name ?? "Error";
        console.log(
          `artifact login ${JSON.stringify({ result: "error", reason: "session_keys", name })}`,
        );
        return fallback;
      } finally {
        forcing = undefined;
      }
    })();
    return forcing;
  };

  return {
    get,
    async forKid(kid) {
      const cold = cache === undefined;
      const set = cold ? await get() : (cache as { set: KeySet }).set;
      // A cold instance has just loaded the newest set; a reload would read the same.
      if (Object.hasOwn(set.keys, kid) || cold) return set;
      if (forcing !== undefined) return forcing;
      if (lastForced !== undefined && now() - lastForced < missReloadMs) return set;
      return force(set);
    },
  };
}
