// Log reads and the pure log predicates of the smoke script (docs/decisions/0076). Every read is
// FilterLogEvents without a filter pattern (all events, A18), and all matching is local, so no
// CloudWatch filter syntax is relied on.
import type { CloudWatchLogsClient, FilteredLogEvent } from "@aws-sdk/client-cloudwatch-logs";
import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

export const MAX_PAGES = 50;
/** Clock skew allowed between this machine and CloudWatch timestamps. */
export const SKEW_MS = 5000;

export type LogEvent = { message: string; timestamp: number };

/** Every event of `group` since `startTime`, following `nextToken` (at most 50 pages). */
export async function fetchEvents(
  client: Pick<CloudWatchLogsClient, "send">,
  group: string,
  startTime: number,
): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const out = (await client.send(
      new FilterLogEventsCommand({ logGroupName: group, startTime, nextToken }),
    )) as { events?: FilteredLogEvent[]; nextToken?: string };
    for (const e of out.events ?? []) {
      events.push({ message: e.message ?? "", timestamp: e.timestamp ?? 0 });
    }
    nextToken = out.nextToken;
    if (nextToken === undefined) return events;
  }
  throw new Error(`too many log events since ${new Date(startTime).toISOString()}`);
}

export type AccessLine = { method: string; path: string; [key: string]: unknown };
export type RequestLine = {
  method: string;
  routeKey: string;
  contentType?: unknown;
  isBase64Encoded?: unknown;
  [key: string]: unknown;
};

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An access-log line (JSON with string `method` and `path`), else `undefined`; never throws. */
export function parseAccessLine(message: string): AccessLine | undefined {
  const value = parseObject(message.trim());
  return typeof value?.method === "string" && typeof value.path === "string"
    ? (value as AccessLine)
    : undefined;
}

const REQUEST_PREFIX = "artifact request ";

/** The JSON after `artifact request ` with string `method` and `routeKey`; never throws. */
export function parseRequestLine(message: string): RequestLine | undefined {
  const at = message.indexOf(REQUEST_PREFIX);
  if (at === -1) return undefined;
  const value = parseObject(message.slice(at + REQUEST_PREFIX.length).trim());
  return typeof value?.method === "string" && typeof value.routeKey === "string"
    ? (value as RequestLine)
    : undefined;
}

const RUNTIME_PREFIX = "artifact runtime ";

/**
 * The JSON after `artifact runtime ` (S19), else `undefined`; never throws. Like the request
 * line, it is found anywhere in the message: the managed runtime's text log format prefixes
 * `console.info` output with `<timestamp>\t<request id>\tINFO\t`.
 */
export function parseRuntimeLine(message: string): Record<string, unknown> | undefined {
  const at = message.indexOf(RUNTIME_PREFIX);
  if (at === -1) return undefined;
  return parseObject(message.slice(at + RUNTIME_PREFIX.length).trim());
}

/** A POST to `path`, whatever prefix API Gateway puts in `$context.path` (A19). */
export function postTo(line: AccessLine | undefined, path: string): boolean {
  return line?.method === "POST" && (line.path === path || line.path.endsWith(path));
}

export function since(event: LogEvent, time: number): boolean {
  return event.timestamp >= time - SKEW_MS;
}

/** The control function's request line of a POST on `routeKey` at or after `time`. */
export function findRequestLine(
  events: readonly LogEvent[],
  routeKey: string,
  time: number,
): RequestLine | undefined {
  for (const event of events) {
    if (!since(event, time)) continue;
    const line = parseRequestLine(event.message);
    if (line?.method === "POST" && line.routeKey === routeKey) return line;
  }
  return undefined;
}

/** Distinct `method path` (access) or `method routeKey` (control) pairs, at most 20. */
export function seenPairs(events: readonly LogEvent[], kind: "access" | "control", time: number) {
  const pairs = new Set<string>();
  for (const event of events) {
    if (!since(event, time)) continue;
    if (kind === "access") {
      const line = parseAccessLine(event.message);
      if (line) pairs.add(`${line.method} ${line.path}`);
    } else {
      const line = parseRequestLine(event.message);
      if (line) pairs.add(`${line.method} ${line.routeKey}`);
    }
  }
  return [...pairs].slice(0, 20);
}

export type CookieControls = {
  /** The path marker of the GET request (A). */
  pathMarker: string;
  mcpRouteKey: string;
  apiProxyRouteKey: string;
};

/**
 * S12: which positive controls are missing in events at or after `time`. Absence of the
 * cookie marker only counts once every control is present.
 */
export function missingControls(
  access: readonly LogEvent[],
  control: readonly LogEvent[],
  controls: CookieControls,
  time: number,
): string[] {
  const recentAccess = access.filter((e) => since(e, time));
  const lines = recentAccess.map((e) => parseAccessLine(e.message));
  const missing: string[] = [];
  if (!lines.some((l) => l?.path.includes(controls.pathMarker)))
    missing.push("access GET marker path");
  if (!lines.some((l) => postTo(l, "/mcp"))) missing.push("access POST /mcp");
  if (!lines.some((l) => postTo(l, "/api/artifacts"))) missing.push("access POST /api/artifacts");
  if (!findRequestLine(control, controls.mcpRouteKey, time)) {
    missing.push(`control POST ${controls.mcpRouteKey}`);
  }
  if (!findRequestLine(control, controls.apiProxyRouteKey, time)) {
    missing.push(`control POST ${controls.apiProxyRouteKey}`);
  }
  return missing;
}

/** The raw messages that contain `marker`, parsed or not. */
export function containing(events: readonly LogEvent[], marker: string): LogEvent[] {
  return events.filter((e) => e.message.includes(marker));
}
