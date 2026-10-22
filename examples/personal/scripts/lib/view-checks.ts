// The pure predicates of the viewing-plane smoke checks S20–S41 (docs/decisions/0086).
import { type LogEvent, since } from "./logs.ts";
import { SESSION_COOKIE, TRANSACTION_COOKIE } from "./session-cookie.ts";

/**
 * The labels of the needles found in any event, never the values: a FAIL detail names what
 * leaked without printing it (the values are also registered with `checks.secret()`).
 */
export function leaks(
  events: readonly LogEvent[],
  needles: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(needles)
    .filter(([, value]) => value !== "" && events.some((e) => e.message.includes(value)))
    .map(([label]) => label);
}

export type ViewLine = { method: string; path: string; cookies: number; [key: string]: unknown };

const VIEW_PREFIX = "artifact view ";

/** The viewing Lambda's access line (`artifact view {…}`, anywhere in the message); never throws. */
export function parseViewLine(message: string): ViewLine | undefined {
  const at = message.indexOf(VIEW_PREFIX);
  if (at === -1) return undefined;
  try {
    const value = JSON.parse(message.slice(at + VIEW_PREFIX.length).trim()) as Partial<ViewLine>;
    return typeof value?.method === "string" &&
      typeof value.path === "string" &&
      typeof value.cookies === "number"
      ? (value as ViewLine)
      : undefined;
  } catch {
    return undefined;
  }
}

/** S28/S29 positive control: an access line for `path` at or after `time` with no cookies. */
export function viewLineFor(
  events: readonly LogEvent[],
  path: string,
  time: number,
): ViewLine | undefined {
  for (const event of events) {
    if (!since(event, time)) continue;
    const line = parseViewLine(event.message);
    if (line?.path === path && line.cookies === 0) return line;
  }
  return undefined;
}

/** Where the edge sends a navigation without a valid session (S21, S30–S32). */
export function loginLocation(view: string, returnUrl: string): string {
  return `https://${view}/__artifact/login?return=${encodeURIComponent(returnUrl)}`;
}

/** S33: the names of the authorize-URL parts that are wrong; empty when all hold. */
export function authorizeProblems(
  location: string,
  expected: { loginDomainUrl: string; clientId: string; view: string },
): string[] {
  const prefix = `${expected.loginDomainUrl.replace(/\/$/, "")}/oauth2/authorize?`;
  if (!location.startsWith(prefix)) return ["location"];
  const q = new URL(location).searchParams;
  const problems: string[] = [];
  if (q.get("client_id") !== expected.clientId) problems.push("client_id");
  if (q.get("code_challenge_method") !== "S256") problems.push("code_challenge_method");
  if (q.get("response_type") !== "code") problems.push("response_type");
  if (!q.get("state")) problems.push("state");
  if (!q.get("nonce")) problems.push("nonce");
  if (q.get("redirect_uri") !== `https://${expected.view}/__artifact/callback`) {
    problems.push("redirect_uri");
  }
  return problems;
}

/** The first `Set-Cookie` header for cookie `name`, whole (value and attributes). */
export function setCookie(setCookies: readonly string[], name: string): string | undefined {
  return setCookies.find((c) => c.startsWith(`${name}=`));
}

/** The value of a `Set-Cookie` header (between `name=` and the first `;`). */
export const cookieValue = (header: string) => header.slice(header.indexOf("=") + 1).split(";")[0];

/** Attribute names and `name=value` attributes of a `Set-Cookie` header, as written. */
const attributes = (header: string) =>
  header
    .split(";")
    .slice(1)
    .map((a) => a.trim());

/** S33: the transaction cookie carries `Secure`, `HttpOnly`, `Path=/` and `Max-Age=600`. */
export function loginCookieOk(header: string | undefined): boolean {
  if (header === undefined) return false;
  const attrs = attributes(header);
  return ["Secure", "HttpOnly", "Path=/", "Max-Age=600"].every((a) => attrs.includes(a));
}

/** S40: the logout clears the session cookie on the view domain. */
export function logoutCookieOk(setCookies: readonly string[], view: string): boolean {
  const header = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=;`));
  if (header === undefined) return false;
  const attrs = attributes(header);
  return [`Domain=${view}`, "Path=/", "Max-Age=0"].every((a) => attrs.includes(a));
}

const TX_KID = /^t1\.([0-9a-f]{16})\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** S41: the `kid` of the first `__Host-artifact_login=t1.<kid>.…` value, else `undefined`. */
export function loginCookieKid(setCookies: readonly string[]): string | undefined {
  const header = setCookies.find((c) => c.startsWith(`${TRANSACTION_COOKIE}=t1.`));
  return header === undefined ? undefined : TX_KID.exec(cookieValue(header))?.[1];
}
