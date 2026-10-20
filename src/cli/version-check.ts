// The server-version warning (docs/decisions/0064): before talking to a remote server, ask
// `GET /api` once and warn on stderr when its major version differs from this CLI's. Every
// failure is silent and the check never changes a command's outcome.
import { PACKAGE_VERSION } from "../version.ts";

/** Only versions of this shape are printed, so no unvalidated server string reaches the terminal. */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/;

const CHECK_TIMEOUT_MS = 5000;

/** `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]`: the local server, never checked. */
export function isLoopbackServer(server: string): boolean {
  let host: string;
  try {
    host = new URL(server).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

const majorOf = (version: string) => version.split(/[.+-]/, 1)[0];

/** The warning line for `server`, or `undefined` when the majors match or anything fails. */
export async function checkServerVersion(options: {
  server: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  cliVersion?: string;
}): Promise<string | undefined> {
  const { server, token, fetch = globalThis.fetch, cliVersion = PACKAGE_VERSION } = options;
  let version: unknown;
  try {
    const response = await fetch(`${server}/api`, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.status !== 200) return undefined;
    ({ version } = (await response.json()) as { version?: unknown });
  } catch {
    return undefined;
  }
  if (typeof version !== "string" || !SEMVER.test(version)) return undefined;
  if (majorOf(version) === majorOf(cliVersion)) return undefined;
  return `artifact: warning: the server at ${server} runs artifact ${version}, this CLI is ${cliVersion}; major versions differ, so commands may fail or behave differently`;
}
