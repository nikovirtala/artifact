// Bearer token check as a port (docs/decisions/0054). The guard parses `Authorization` and
// answers 401; a verifier only says whether the presented token is valid. Locally it compares
// with `ARTIFACT_TOKEN` in constant time (docs/decisions/0027).
import { createHash, timingSafeEqual } from "node:crypto";

export type TokenVerifier = (presented: string) => Promise<boolean>;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** The verifier for one configured token; `undefined` (no token) means no check. */
export function localTokenVerifier(token: string | undefined): TokenVerifier | undefined {
  if (token === undefined) return undefined;
  const expected = digest(token);
  return async (presented) => timingSafeEqual(digest(presented), expected);
}
