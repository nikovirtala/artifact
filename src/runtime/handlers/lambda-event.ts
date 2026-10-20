// HTTP API payload 2.0 events (docs/decisions/0066): the raw target for the traversal guard
// (0055), cookie stripping before the app sees the event, and the fixed-field request-shape line.
import type { RawTargetHook } from "../../http/raw-target.ts";

/** The fields of an HTTP API payload format 2.0 event this code reads. */
export type HttpApiEvent = {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  body: string | null;
  isBase64Encoded: boolean;
  requestContext: {
    requestId: string;
    routeKey: string;
    domainName: string;
    http: { method: string; path: string; protocol: string; sourceIp: string; userAgent: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/**
 * A shallow copy without `cookies` and without any `Cookie` header (any case). The control plane
 * authenticates by bearer token only, so the view-domain session cookie never enters the app,
 * its errors or its logs.
 */
export function stripCookies<E extends { cookies?: unknown; headers?: Record<string, unknown> }>(
  event: E,
): E {
  const { cookies: _cookies, ...rest } = event;
  if (rest.headers === undefined) return rest as E;
  const headers = Object.fromEntries(
    Object.entries(rest.headers).filter(([name]) => name.toLowerCase() !== "cookie"),
  );
  return { ...rest, headers } as E;
}

/** `rawPath` + `rawQueryString` of the Lambda event that `hono/aws-lambda` puts in `c.env`. */
export const lambdaRawTarget: RawTargetHook = (c) => {
  const event = (c.env as { event?: Partial<HttpApiEvent> } | undefined)?.event;
  if (typeof event?.rawPath !== "string") return undefined;
  const query = event.rawQueryString;
  return query ? `${event.rawPath}?${query}` : event.rawPath;
};

const MAX_CONTENT_TYPE = 100;

/** The media type of `content-type`, lowercased, parameters dropped, at most 100 characters. */
function mediaType(headers: Record<string, string | undefined>): string {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  return (value?.[1] ?? "").split(";", 1)[0].trim().toLowerCase().slice(0, MAX_CONTENT_TYPE);
}

/**
 * `artifact request {…}` for an event with a body: fixed fields only (no body, headers other
 * than the media type, path or query), so the deployment can show whether API Gateway
 * base64-encodes JSON bodies (V3c in ADR 0066). `undefined` without a body.
 */
export function requestShapeLine(event: HttpApiEvent): string | undefined {
  if (typeof event.body !== "string" || event.body === "") return undefined;
  return `artifact request ${JSON.stringify({
    requestId: event.requestContext?.requestId,
    method: event.requestContext?.http?.method,
    routeKey: event.routeKey ?? event.requestContext?.routeKey,
    contentType: mediaType(event.headers ?? {}),
    isBase64Encoded: event.isBase64Encoded === true,
    bodyLength: event.body.length,
  })}`;
}
