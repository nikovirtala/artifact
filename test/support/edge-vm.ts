// Runs the shipped viewer-request function (docs/decisions/0080) in node:vm the way CloudFront
// Functions would: the dist file rendered by the construct's own renderEdgeFunction, with only
// its two import lines swapped for injected fakes, in a context that lacks what the
// cloudfront-js-2.0 runtime lacks (process, timers, require, fetch) and a one-argument console.log.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { renderEdgeFunction } from "../../src/cdk/edge.ts";

export const EDGE_SOURCE = new URL("../../src/runtime/edge/viewer-request.js", import.meta.url);
export const EDGE_DIST = new URL("../../dist/assets/edge/viewer-request.js", import.meta.url);
export const IMPORT_LINES = ['import cf from "cloudfront";', 'import crypto from "crypto";'];

export type EdgeHeaders = Record<string, { value: string }>;
export type EdgeCookies = Record<string, { value: string }>;
export type EdgeQuery = Record<string, { value: string; multiValue?: { value: string }[] }>;
export type EdgeRequest = {
  method: string;
  uri: string;
  querystring: EdgeQuery;
  headers: EdgeHeaders;
  cookies: EdgeCookies;
};
export type EdgeResponse = {
  statusCode: number;
  statusDescription: string;
  headers: EdgeHeaders;
  body: { encoding: string; data: string };
};
export type EdgeEvent = {
  version: string;
  context: Record<string, string>;
  viewer: { ip: string };
  request: EdgeRequest;
};

export type LoadedEdge = {
  handler(event: EdgeEvent): Promise<EdgeRequest | EdgeResponse>;
  /** Every key the function asked the KeyValueStore for. */
  readonly gets: string[];
  readonly logs: string[];
  /** Evaluates `code` in the function's context (to probe the sandbox). */
  run(code: string): unknown;
};

/** The rendered dist file with the two import lines replaced by the injected fakes. */
export function sandboxSource(viewDomain: string): string {
  const rendered = renderEdgeFunction(readFileSync(EDGE_DIST, "utf8"), viewDomain);
  const lines = rendered.split("\n");
  if (lines[0] !== IMPORT_LINES[0] || lines[1] !== IMPORT_LINES[1]) {
    throw new Error("edge-vm: the first two lines are not the cloudfront and crypto imports");
  }
  return ["const cf = __cf;", "const crypto = __crypto;", ...lines.slice(2)].join("\n");
}

export function loadEdge(options: {
  viewDomain: string;
  kvs: Record<string, string>;
  now: number;
  /** Every KVS get throws, as on a KVS outage. */
  kvsFails?: boolean;
}): LoadedEdge {
  const gets: string[] = [];
  const logs: string[] = [];
  const { kvs, kvsFails = false } = options;
  const context = createContext({
    __crypto: {
      createHmac: (algorithm: string, key: string) => createHmac(algorithm, key),
      createHash: (algorithm: string) => createHash(algorithm),
    },
    __cf: {
      kvs: () => ({
        get: async (key: string) => {
          gets.push(key);
          if (kvsFails) throw new Error("key value store unavailable");
          if (!Object.hasOwn(kvs, key)) throw new Error("key not found");
          return kvs[key];
        },
      }),
    },
    __now: options.now,
    Buffer,
    console: {
      log: (...args: unknown[]) => {
        if (args.length !== 1) throw new Error("console.log takes exactly one argument");
        logs.push(String(args[0]));
      },
    },
  });
  runInContext("Date.now = function () { return __now * 1000; };", context);
  runInContext(sandboxSource(options.viewDomain), context, { filename: "viewer-request.js" });
  const handler = (context as { handler?: LoadedEdge["handler"] }).handler;
  if (typeof handler !== "function") throw new Error("edge-vm: no top-level handler");
  return {
    // The result is plain data; copying it into this realm lets deepStrictEqual compare it.
    handler: async (event) => JSON.parse(JSON.stringify(await handler(event))),
    gets,
    logs,
    run: (code) => runInContext(code, context),
  };
}

/** A documented v1.0 viewer-request event: lowercase header names, cookies apart from headers. */
export function fakeEvent(options: {
  host?: string;
  uri?: string;
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  querystring?: EdgeQuery;
}): EdgeEvent {
  const headers: EdgeHeaders = {};
  if (options.host !== undefined) headers.host = { value: options.host };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = { value };
  }
  const cookies: EdgeCookies = {};
  for (const [name, value] of Object.entries(options.cookies ?? {})) cookies[name] = { value };
  return {
    version: "1.0",
    context: {
      distributionDomainName: "d111111abcdef8.cloudfront.net",
      distributionId: "EDFDVBD6EXAMPLE",
      eventType: "viewer-request",
      requestId: "4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==",
    },
    viewer: { ip: "198.51.100.11" },
    request: {
      method: options.method ?? "GET",
      uri: options.uri ?? "/",
      querystring: options.querystring ?? {},
      headers,
      cookies,
    },
  };
}

export const isResponse = (r: EdgeRequest | EdgeResponse): r is EdgeResponse => "statusCode" in r;
