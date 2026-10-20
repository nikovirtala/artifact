// The control Lambda handler (docs/decisions/0066) on Lambda-shaped HTTP API payload 2.0 events
// and in-memory stores: guards, AWS limits, MCP, the request-shape line and cookie stripping.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTROL_ROUTE_KEYS } from "../../src/cdk/routes.ts";
import type { ArtifactService } from "../../src/core/artifact-service.ts";
import { createControlHandler } from "../../src/runtime/handlers/control.ts";
import {
  type HttpApiEvent,
  requestShapeLine,
  stripCookies,
} from "../../src/runtime/handlers/lambda-event.ts";
import { PACKAGE_VERSION } from "../../src/version.ts";
import { harness } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const TOKEN = "art_good";
const VIEW = "art.example.dev";
const API_HOST = "api.art.example.dev";
const MIB = 1024 * 1024;
const LIMITS = { maxFileBytes: 3 * MIB, maxPublishBytes: 3 * MIB, maxFiles: 500 };
const MAX_BODY = 4_500_000;

function setup(options: { service?: ArtifactService } = {}) {
  const h = harness({ limits: LIMITS });
  const service = options.service ?? h.service;
  const handler = createControlHandler({
    service,
    verifyToken: async (t) => t === TOKEN,
    viewDomain: VIEW,
    maxBodyBytes: MAX_BODY,
  });
  return { ...h, service, handler };
}

let requestCounter = 0;

function routeKeyFor(path: string): string {
  if (path === "/mcp") return CONTROL_ROUTE_KEYS.mcp;
  if (path === "/api") return CONTROL_ROUTE_KEYS.api;
  return CONTROL_ROUTE_KEYS.apiProxy;
}

type EventOptions = {
  body?: string;
  headers?: Record<string, string>;
  cookies?: string[];
  isBase64Encoded?: boolean;
  rawPath?: string;
  token?: string | null;
};

/** A payload 2.0 event as API Gateway sends it (lowercase header names, `cookies` split out). */
function event(method: string, target: string, options: EventOptions = {}): HttpApiEvent {
  const [path, query = ""] = target.split("?");
  const rawPath = options.rawPath ?? path;
  const routeKey = routeKeyFor(rawPath);
  const token = options.token === undefined ? TOKEN : options.token;
  const headers: Record<string, string> = {
    host: API_HOST,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...options.headers,
  };
  const requestId = `req-${++requestCounter}`;
  return {
    version: "2.0",
    routeKey,
    rawPath,
    rawQueryString: query,
    headers,
    ...(options.cookies ? { cookies: options.cookies } : {}),
    requestContext: {
      accountId: "000000000000",
      apiId: "abc123",
      domainName: API_HOST,
      domainPrefix: "api",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "t" },
      requestId,
      routeKey,
      stage: "$default",
      time: "20/Oct/2026:12:00:00 +0000",
      timeEpoch: 1_760_961_600_000,
    },
    body: options.body ?? null,
    isBase64Encoded: options.isBase64Encoded ?? false,
  } as HttpApiEvent;
}

type Result = { statusCode: number; body: string; isBase64Encoded: boolean; headers?: object };

async function send(
  handler: ReturnType<typeof setup>["handler"],
  method: string,
  target: string,
  options: EventOptions = {},
) {
  const result = (await handler(event(method, target, options), {} as never)) as Result;
  const text = result.isBase64Encoded
    ? Buffer.from(result.body, "base64").toString("utf8")
    : result.body;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: result.statusCode, json, result };
}

const publishBody = (files: Record<string, unknown>) => JSON.stringify({ files });

/** Everything written to the console and to stdout/stderr while `fn` runs. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const chunks: string[] = [];
  const methods = ["log", "error", "warn", "info", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      chunks.push(
        args.map((a) => (a instanceof Error ? `${a.stack} ${String(a)}` : String(a))).join(" "),
      );
    };
  }
  const sink = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, output: chunks.join("\n") };
  } finally {
    methods.forEach((m, i) => {
      console[m] = originals[i];
    });
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe("control handler: guards", () => {
  it("answers 401 without a token and with a wrong one, 403 with Origin", async () => {
    const { handler } = setup();
    const none = await send(handler, "GET", "/api/artifacts", { token: null });
    assert.equal(none.status, 401);
    assert.equal(none.json.error, "unauthorized");
    const wrong = await send(handler, "GET", "/api/artifacts", { token: "art_bad" });
    assert.equal(wrong.status, 401);
    const origin = await send(handler, "GET", "/api/artifacts", {
      headers: { origin: "https://example.com" },
    });
    assert.equal(origin.status, 403);
    assert.equal(origin.json.error, "forbidden");
    assert.equal((await send(handler, "GET", "/api/artifacts")).status, 200);
  });

  it("answers GET /api with the version", async () => {
    const { handler } = setup();
    const res = await send(handler, "GET", "/api");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { version: PACKAGE_VERSION });
  });

  it("refuses path traversal in rawPath before URL normalisation", async () => {
    const { handler } = setup();
    const res = await send(handler, "GET", "/api/artifacts/%2e%2e/x");
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "bad_request");
  });
});

describe("control handler: publish", () => {
  it("publishes with view-domain URLs; republish makes version 2", async () => {
    const { handler } = setup();
    const created = await send(handler, "POST", "/api/artifacts", {
      body: publishBody({ "index.html": "<p>1</p>" }),
    });
    assert.equal(created.status, 201);
    const { id, version, url } = created.json as { id: string; version: number; url: string };
    assert.equal(version, 1);
    assert.equal(url, `https://${id}.${VIEW}/`);
    const updated = await send(handler, "PUT", `/api/artifacts/${id}`, {
      body: publishBody({ "index.html": "<p>2</p>" }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.version, 2);
    assert.equal(updated.json.url, url);
  });

  it("accepts a base64-encoded event body", async () => {
    const { handler } = setup();
    const res = await send(handler, "POST", "/api/artifacts", {
      body: Buffer.from(publishBody({ "index.html": "<p>b64</p>" })).toString("base64"),
      isBase64Encoded: true,
    });
    assert.equal(res.status, 201);
  });

  it("publishes a binary file just under 3 MiB as {base64}", async () => {
    const { handler } = setup();
    const index = "<p>x</p>";
    const binary = Buffer.alloc(3 * MIB - index.length, 0xab);
    const res = await send(handler, "POST", "/api/artifacts", {
      body: publishBody({ "index.html": index, "a.png": { base64: binary.toString("base64") } }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  });

  it("rejects a 3.5 MiB file with the core's too_large (file, 3 MiB)", async () => {
    const { handler } = setup();
    const res = await send(handler, "POST", "/api/artifacts", {
      body: publishBody({ "index.html": "x".repeat(3.5 * MIB) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(
      [res.json.error, res.json.subject, res.json.limit],
      ["too_large", "file", 3_145_728],
    );
  });

  it("rejects a body over 4,500,000 bytes with too_large (publish)", async () => {
    const { handler } = setup();
    const res = await send(handler, "POST", "/api/artifacts", {
      body: publishBody({ "index.html": "x".repeat(MAX_BODY) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual([res.json.error, res.json.subject], ["too_large", "publish"]);
  });
});

/** An MCP client whose requests go through the Lambda handler as payload 2.0 events. */
async function mcpThroughLambda(handler: ReturnType<typeof setup>["handler"]) {
  return connectMcp(`https://${API_HOST}/mcp`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    handler: async (request) => {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = request.method === "GET" ? undefined : await request.text();
      const result = (await handler(
        event(request.method, url.pathname + url.search, { body, headers, token: null }),
        {} as never,
      )) as Result & { headers?: Record<string, string> };
      return new Response(
        result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body,
        { status: result.statusCode, headers: result.headers },
      );
    },
  });
}

describe("control handler: MCP", () => {
  it("publishes, lists, reads and rolls back", async () => {
    const { handler } = setup();
    const mcp = await mcpThroughLambda(handler);
    try {
      const first = await mcp.call("artifact_publish", { files: { "index.html": "<p>1</p>" } });
      assert.equal(first.isError, false, JSON.stringify(first.value));
      const id = first.value.id as string;
      assert.equal(first.value.url, `https://${id}.${VIEW}/`);
      await mcp.call("artifact_publish", { id, files: { "index.html": "<p>2</p>" } });
      const listed = await mcp.call("artifact_list", { all: true });
      assert.equal(listed.isError, false);
      assert.ok(JSON.stringify(listed.value).includes(id));
      const read = await mcp.call("artifact_read", { id });
      assert.equal(read.isError, false);
      assert.match(JSON.stringify(read.result), /<p>2<\/p>/);
      const rolled = await mcp.call("artifact_rollback", { id, version: 1 });
      assert.equal(rolled.isError, false);
      assert.equal(rolled.value.version, 1);
    } finally {
      await mcp.close();
    }
  });

  it("refuses file_path with invalid_input", async () => {
    const { handler } = setup();
    const mcp = await mcpThroughLambda(handler);
    try {
      const res = await mcp.call("artifact_publish", { file_path: "/etc/passwd" });
      assert.equal(res.isError, true);
      assert.equal(res.value.error, "invalid_input");
      assert.equal(res.value.field, "file_path");
    } finally {
      await mcp.close();
    }
  });
});

describe("control handler: request-shape line", () => {
  const KEYS = ["requestId", "method", "routeKey", "contentType", "isBase64Encoded", "bodyLength"];

  it("logs fixed fields only for events with a body", async () => {
    const { handler } = setup();
    const marker = "MARKERbody";
    const { output } = await capture(() =>
      send(handler, "POST", "/api/artifacts", {
        body: publishBody({ "index.html": `<p>${marker}</p>` }),
        headers: { "content-type": "Application/JSON; charset=utf-8" },
        cookies: ["s=MARKERcookie"],
        token: "MARKERtoken",
      }),
    );
    const lines = output.split("\n").filter((l) => l.startsWith("artifact request "));
    assert.equal(lines.length, 1);
    const fields = JSON.parse(lines[0].slice("artifact request ".length));
    assert.deepEqual(Object.keys(fields), KEYS);
    assert.equal(fields.method, "POST");
    assert.equal(fields.routeKey, CONTROL_ROUTE_KEYS.apiProxy);
    assert.equal(fields.contentType, "application/json");
    assert.equal(fields.isBase64Encoded, false);
    assert.equal(typeof fields.bodyLength, "number");
    assert.match(fields.requestId, /^req-/);
    for (const m of ["MARKERbody", "MARKERcookie", "MARKERtoken"]) {
      assert.ok(!output.includes(m), m);
    }
  });

  it("reflects isBase64Encoded and the MCP route key; no line without a body", async () => {
    const encoded = requestShapeLine(
      event("POST", "/mcp", { body: Buffer.from("{}").toString("base64"), isBase64Encoded: true }),
    );
    assert.ok(encoded !== undefined);
    const fields = JSON.parse(encoded.slice("artifact request ".length));
    assert.equal(fields.isBase64Encoded, true);
    assert.equal(fields.routeKey, CONTROL_ROUTE_KEYS.mcp);
    assert.equal(requestShapeLine(event("GET", "/api/artifacts")), undefined);
    const { handler } = setup();
    const { output } = await capture(() => send(handler, "GET", "/api/artifacts"));
    assert.ok(!output.includes("artifact request"));
  });
});

describe("control handler: cookies", () => {
  it("leaves no trace of a session cookie in any log, on success and on errors", async () => {
    const marker = "COOKIEMARKER7c1e";
    const h = harness({ limits: LIMITS });
    const failing = Object.create(h.service) as ArtifactService;
    failing.list = async () => {
      throw new Error("forced failure");
    };
    const ok = setup({ service: h.service }).handler;
    const broken = setup({ service: failing }).handler;
    const withCookie = {
      cookies: [`__Secure-artifact_session=${marker}`],
      headers: { cookie: `__Secure-artifact_session=${marker}`, Cookie: `x=${marker}` },
    };
    const { value, output } = await capture(async () => [
      await send(ok, "GET", "/api", withCookie),
      await send(ok, "POST", "/mcp", {
        ...withCookie,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        headers: { ...withCookie.headers, accept: "application/json, text/event-stream" },
      }),
      await send(ok, "GET", "/api/artifacts", { ...withCookie, token: "art_bad" }),
      await send(ok, "GET", "/api/artifacts", {
        ...withCookie,
        headers: { ...withCookie.headers, origin: "https://x.example" },
      }),
      await send(broken, "GET", "/api/artifacts", withCookie),
    ]);
    assert.deepEqual(
      value.map((r) => r.status),
      [200, 200, 401, 403, 500],
    );
    assert.match(output, /forced failure/);
    assert.ok(!output.includes(marker));
  });
});

describe("stripCookies", () => {
  it("drops cookies and every Cookie header case-insensitively without mutating the input", () => {
    const input = {
      ...event("GET", "/api"),
      cookies: ["a=1"],
      headers: { cookie: "a=1", COOKIE: "b=2", "x-other": "y" },
    } as HttpApiEvent;
    const copy = structuredClone(input);
    const stripped = stripCookies(input);
    assert.equal(stripped.cookies, undefined);
    assert.ok(!("cookies" in stripped));
    assert.deepEqual(stripped.headers, { "x-other": "y" });
    assert.deepEqual(input, copy);
  });
});
