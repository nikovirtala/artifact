// The viewing Lambda handler (docs/decisions/0082) on Lambda function URL events (payload 2.0
// shape) as CloudFront forwards them: the viewer's host in x-artifact-host, cookies already
// stripped by the edge (and again here). Runs on the in-memory store and on the fake S3 endpoint
// through createS3Store.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ArtifactService } from "../../src/core/artifact-service.ts";
import { GALLERY_CSP } from "../../src/http/headers.ts";
import { DomainHostPolicy } from "../../src/http/host-policy.ts";
import { createS3Store } from "../../src/runtime/adapters/s3-store.ts";
import type { KeySet } from "../../src/runtime/auth/session.ts";
import {
  SESSION_COOKIE,
  sessionKeys,
  signTransaction,
  TRANSACTION_COOKIE,
} from "../../src/runtime/auth/session.ts";
import { createKeyCache } from "../../src/runtime/auth/session-keys-loader.ts";
import { type HttpApiEvent, keepCookies } from "../../src/runtime/handlers/lambda-event.ts";
import { createViewingHandler, viewingEvent } from "../../src/runtime/handlers/viewing.ts";
import { type FakeS3, fakeS3Client, startFakeS3 } from "../support/fake-s3-server.ts";
import { fakeClock, fakeIdGen, harness, recordingNotifier } from "../support/fakes.ts";

const VIEW = "art.example.dev";
const FN_HOST = "abcdefghijklmnopqrstuvwxyz012345.lambda-url.eu-north-1.on.aws";
const KID = "0123456789abcdef";
const KEYS: KeySet = {
  version: 1,
  current: KID,
  keys: { [KID]: { key: "test-only-viewing-key-not-for-any-use-000000", rotation: "a" } },
};
const OIDC = {
  issuer: "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Test",
  clientId: "client123",
  authorizeUrl: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/authorize",
  tokenUrl: "https://login.auth.eu-north-1.amazoncognito.com/oauth2/token",
  logoutUrl: "https://login.auth.eu-north-1.amazoncognito.com/logout",
};
const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

type Result = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
  cookies?: string[];
};

let counter = 0;

/** A function URL event as CloudFront sends it through OAC. */
function event(
  method: string,
  target: string,
  options: { host?: string | null; headers?: Record<string, string>; cookies?: string[] } = {},
): HttpApiEvent {
  const [rawPath, rawQueryString = ""] = target.split(/\?(.*)/s);
  const host = options.host === undefined ? VIEW : options.host;
  const requestId = `req-${++counter}`;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString,
    headers: {
      host: FN_HOST,
      "x-amz-cf-id": "cfid",
      ...(host === null ? {} : { "x-artifact-host": host }),
      ...options.headers,
    },
    ...(options.cookies ? { cookies: options.cookies } : {}),
    requestContext: {
      accountId: "anonymous",
      apiId: "abcdefghijklmnopqrstuvwxyz012345",
      domainName: FN_HOST,
      domainPrefix: "abcdefghijklmnopqrstuvwxyz012345",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "t" },
      requestId,
      routeKey: "$default",
      stage: "$default",
      time: "21/Oct/2026:12:00:00 +0000",
      timeEpoch: 1_792_000_000_000,
    },
    body: null,
    isBase64Encoded: false,
  } as HttpApiEvent;
}

/** Console output written while `fn` runs. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const lines: string[] = [];
  const methods = ["log", "error", "warn", "info"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) =>
      lines.push(args.map((a) => (a instanceof Error ? `${a.stack}` : String(a))).join(" "));
  }
  try {
    return { value: await fn(), output: lines.join("\n") };
  } finally {
    methods.forEach((m, i) => {
      console[m] = originals[i];
    });
  }
}

function makeHandler(service: ArtifactService) {
  const loads = { calls: 0 };
  const fetches: string[] = [];
  const handler = createViewingHandler({
    service,
    viewDomain: VIEW,
    loadKeys: createKeyCache(async () => {
      loads.calls++;
      return KEYS;
    }),
    oidc: OIDC,
    owners: ["owner@example.com"],
    fetch: (async (url: string) => {
      fetches.push(String(url));
      throw new TypeError("no network in tests");
    }) as typeof globalThis.fetch,
    now: () => 1_790_000_000_000,
  });
  const send = async (e: HttpApiEvent) => (await handler(e, {} as never)) as Result;
  return { send, loads, fetches };
}

const accessLines = (output: string) =>
  output
    .split("\n")
    .filter((l) => l.startsWith("artifact view "))
    .map((l) => JSON.parse(l.slice("artifact view ".length)));

/** Publishes P (index.html + style.css) twice, so v1 is pinned and v2 current. */
async function publishP(service: ArtifactService): Promise<string> {
  const page = (n: number) => `<!doctype html><html><body><h1>P${n}</h1></body></html>`;
  const created = await service.publish({
    files: { "index.html": page(1), "style.css": "h1{color:red}", "docs/index.html": "<p>d</p>" },
  });
  assert.ok(created.ok);
  const updated = await service.publish({
    id: created.value.id,
    files: { "index.html": page(2), "style.css": "h1{color:blue}" },
  });
  assert.ok(updated.ok);
  return created.value.id;
}

/** The R11 checks, against any store behind `service`. */
function viewingCases(name: string, service: () => ArtifactService, id: () => string) {
  describe(`viewing handler (${name})`, () => {
    const at = () => `${id()}.${VIEW}`;

    it("serves the current page with no-cache, no CSP and the ADR 0025 headers", async () => {
      const { send } = makeHandler(service());
      const res = await send(event("GET", "/", { host: at() }));
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /<h1>P2<\/h1>/);
      assert.match(res.body, /data-version="2"/);
      assert.equal(res.headers["cache-control"], "no-cache");
      assert.equal(res.headers["content-security-policy"], undefined);
      for (const [k, v] of Object.entries(SECURITY)) assert.equal(res.headers[k], v, k);
    });

    it("serves pinned files as immutable and the version route as no-store", async () => {
      const { send } = makeHandler(service());
      const pinned = await send(event("GET", "/v/1/style.css", { host: at() }));
      assert.equal(pinned.statusCode, 200);
      assert.equal(pinned.body, "h1{color:red}");
      assert.equal(pinned.headers["cache-control"], "public, max-age=31536000, immutable");
      const current = await send(event("GET", "/style.css", { host: at() }));
      assert.equal(current.body, "h1{color:blue}");
      assert.equal(current.headers["cache-control"], "no-cache");
      const version = await send(event("GET", "/__artifact/version", { host: at() }));
      assert.equal(version.statusCode, 200);
      assert.deepEqual(JSON.parse(version.body), { version: 2 });
      assert.equal(version.headers["cache-control"], "no-store");
      const redirect = await send(event("GET", "/v/1", { host: at() }));
      assert.equal(redirect.statusCode, 308);
      assert.equal(redirect.headers["cache-control"], "no-store");
    });

    it("answers HEAD with 200 and no body", async () => {
      const { send } = makeHandler(service());
      const res = await send(event("HEAD", "/", { host: at() }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, "");
      assert.equal(res.headers["cache-control"], "no-cache");
    });

    it("answers a missing file and a non-GET with 404 no-store", async () => {
      const { send } = makeHandler(service());
      for (const [method, path] of [
        ["GET", "/nope.css"],
        ["GET", "/v/9/index.html"],
        ["POST", "/"],
      ]) {
        const res = await send(event(method, path, { host: at() }));
        assert.equal(res.statusCode, 404, `${method} ${path}`);
        assert.equal(res.headers["cache-control"], "no-store");
        assert.equal(res.headers["x-content-type-options"], "nosniff");
      }
    });

    it("refuses traversal in the raw path with 400 before any route", async () => {
      const { send } = makeHandler(service());
      for (const path of ["/x%2f..%2fy", "/..%5cx", "/%2e%2e/index.html", "/a/%2e%2e/b"]) {
        for (const host of [at(), VIEW]) {
          const res = await send(event("GET", path, { host }));
          assert.equal(res.statusCode, 400, `${host}${path}`);
          assert.equal(res.body, "bad request: unsafe path\n");
          assert.equal(res.headers["cache-control"], "no-store");
        }
      }
    });

    it("serves the gallery with its CSP and no-store", async () => {
      const { send } = makeHandler(service());
      const res = await send(event("GET", "/"));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-security-policy"], GALLERY_CSP);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.ok(res.body.includes(`https://${id()}.${VIEW}/`));
    });
  });
}

describe("viewing handler: in-memory store", () => {
  const h = harness();
  let id = "";
  before(async () => {
    id = await publishP(h.service);
  });
  viewingCases(
    "memory",
    () => h.service,
    () => id,
  );
});

describe("viewing handler: fake S3 through createS3Store", () => {
  let s3: FakeS3;
  let service: ArtifactService;
  let id = "";
  before(async () => {
    s3 = await startFakeS3();
    const store = createS3Store({ client: fakeS3Client(s3.endpoint), bucket: "view" });
    const clock = fakeClock();
    service = new ArtifactService({
      blobs: store,
      pointers: store,
      notifier: recordingNotifier(),
      clock,
      ids: fakeIdGen(),
    });
    id = await publishP(service);
  });
  after(() => s3.close());
  viewingCases(
    "fake S3",
    () => service,
    () => id,
  );
});

describe("viewing handler: hosts, platform routes and path mode", () => {
  const h = harness();
  let id = "";
  before(async () => {
    id = await publishP(h.service);
  });

  it("refuses a missing, empty or rejected x-artifact-host with 403 without the app", async () => {
    const reads: string[] = [];
    const spy = Object.create(h.service) as ArtifactService;
    spy.read = async (x) => {
      reads.push(x);
      return h.service.read(x);
    };
    spy.list = async (o) => {
      reads.push("list");
      return h.service.list(o);
    };
    const { send } = makeHandler(spy);
    for (const host of [
      null,
      "",
      "evil.example",
      FN_HOST,
      `notanartifactid.${VIEW}`,
      `a.${id}.${VIEW}`,
      `${VIEW}:8443`,
      `${VIEW}.`,
    ]) {
      const { value: res, output } = await capture(() => send(event("GET", "/", { host })));
      assert.equal(res.statusCode, 403, String(host));
      assert.equal(res.body, "forbidden: unexpected Host header\n");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(accessLines(output)[0]?.status, 403);
    }
    assert.deepEqual(reads, []);
  });

  it("uses x-artifact-host, not the function URL host, and accepts :443 and any case", async () => {
    const { send } = makeHandler(h.service);
    for (const host of [
      `${id}.${VIEW}`,
      `${id.toUpperCase()}.ART.example.dev`,
      `${id}.${VIEW}:443`,
    ]) {
      const res = await send(event("GET", "/", { host }));
      assert.equal(res.statusCode, 200, host);
      assert.match(res.body, /<h1>P2<\/h1>/);
    }
  });

  it("answers an unknown main-host path with 404, the security headers and no-store", async () => {
    const { send } = makeHandler(h.service);
    const res = await send(event("GET", "/foo"));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body, "not found\n");
    assert.equal(res.headers["cache-control"], "no-store");
    for (const [k, v] of Object.entries(SECURITY)) assert.equal(res.headers[k], v, k);
  });

  it("turns path mode off on the main host", async () => {
    const { send } = makeHandler(h.service);
    for (const path of ["/a", "/a/", `/a/${id}`, `/a/${id}/`, `/a/${id}/style.css`]) {
      const res = await send(event("GET", path));
      assert.equal(res.statusCode, 404, path);
      assert.equal(res.headers["cache-control"], "no-store");
    }
  });

  it("serves no event stream on any host", async () => {
    const { send } = makeHandler(h.service);
    for (const host of [VIEW, `${id}.${VIEW}`]) {
      const res = await send(event("GET", `/__artifact/events?id=${id}`, { host }));
      assert.equal(res.statusCode, 404, host);
      assert.equal(res.headers["cache-control"], "no-store");
    }
  });

  it("serves an inert reload client (transport none)", async () => {
    const { send } = makeHandler(h.service);
    const res = await send(event("GET", "/__artifact/reload.js", { host: `${id}.${VIEW}` }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-cache");
    assert.ok(
      res.body.startsWith(
        `const __artifactReloadConfig = { transport: "none", viewSuffix: ".${VIEW}", pathMode: false };\n`,
      ),
    );
  });

  it("serves the login routes on the main host, with Set-Cookie in the result's cookies", async () => {
    const { send, loads } = makeHandler(h.service);
    const res = await send(event("GET", "/__artifact/login?return=https%3A%2F%2Fexample.com%2F"));
    assert.equal(res.statusCode, 302);
    assert.ok(res.headers.location?.startsWith(`${OIDC.authorizeUrl}?response_type=code&`));
    assert.match(
      res.headers.location,
      /&redirect_uri=https%3A%2F%2Fart\.example\.dev%2F__artifact%2Fcallback&/,
    );
    assert.equal(res.cookies?.length, 1);
    assert.ok(res.cookies?.[0].startsWith(`${TRANSACTION_COOKIE}=t1.${KID}.`));
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(loads.calls, 1);
    const onArtifact = await send(event("GET", "/__artifact/login", { host: `${id}.${VIEW}` }));
    assert.equal(onArtifact.statusCode, 404);
    const head = await send(event("HEAD", "/__artifact/callback?code=x&state=y"));
    assert.equal(head.statusCode, 405);
    assert.equal(head.headers.allow, "GET");
  });

  it("lets only the transaction cookie reach the callback", async () => {
    const { send, fetches } = makeHandler(h.service);
    const state = "s".repeat(43);
    const tx = signTransaction(sessionKeys(KEYS), KID, {
      s: state,
      n: "n",
      v: "v",
      r: `https://${VIEW}/`,
      exp: 1_790_000_600,
    });
    const { value: res } = await capture(() =>
      send(
        event("GET", `/__artifact/callback?code=abc&state=${state}`, {
          cookies: [`${SESSION_COOKIE}=v1.x`, `${TRANSACTION_COOKIE}=${tx}`, "other=1"],
        }),
      ),
    );
    // The transaction cookie got through: the callback reached the token endpoint.
    assert.equal(res.statusCode, 502);
    assert.deepEqual(fetches, [OIDC.tokenUrl]);
  });
});

describe("viewing handler: cookies and the access line", () => {
  const MARK = "COOKIEMARK9f3a";
  const h = harness();
  let id = "";
  before(async () => {
    id = await publishP(h.service);
  });

  it("keeps cookies out of the app's event: none on viewing paths, only the transaction cookie on login", () => {
    const hosts = new DomainHostPolicy({ viewDomain: VIEW });
    const cookies = [`${SESSION_COOKIE}=${MARK}`, `${TRANSACTION_COOKIE}=t1.${MARK}`, `x=${MARK}`];
    const headers = { cookie: cookies.join("; "), Cookie: `y=${MARK}` };
    const page = viewingEvent(
      event("GET", "/", { host: `${id}.${VIEW}`, cookies, headers }),
      hosts,
    );
    assert.ok(page);
    assert.equal(page.cookies, undefined);
    assert.ok(!JSON.stringify(page).includes(MARK));
    assert.equal(page.headers.host, `${id}.${VIEW}`);
    assert.equal(page.requestContext.domainName, `${id}.${VIEW}`);
    for (const path of ["/__artifact/login", "/__artifact/callback", "/__artifact/logout"]) {
      const login = viewingEvent(event("GET", path, { cookies, headers }), hosts);
      assert.deepEqual(login?.cookies, [`${TRANSACTION_COOKIE}=t1.${MARK}`], path);
      assert.deepEqual(login?.headers.cookie, `${TRANSACTION_COOKIE}=t1.${MARK}`);
      assert.equal(login?.headers.Cookie, undefined);
      const json = JSON.stringify(login);
      assert.ok(!json.includes(`${SESSION_COOKIE}=`) && !json.includes(`x=${MARK}`), path);
      const onArtifact = viewingEvent(
        event("GET", path, { host: `${id}.${VIEW}`, cookies, headers }),
        hosts,
      );
      assert.ok(!JSON.stringify(onArtifact).includes(MARK), path);
    }
    for (const path of ["/__artifact/login/", "/__artifact/loginx", "/x/__artifact/login"]) {
      assert.ok(
        !JSON.stringify(viewingEvent(event("GET", path, { cookies }), hosts)).includes(MARK),
      );
    }
    assert.equal(viewingEvent(event("GET", "/", { host: "evil.example" }), hosts), undefined);
  });

  it("logs one fixed-field access line without the query, cookies or headers", async () => {
    const failing = Object.create(h.service) as ArtifactService;
    failing.readServed = async () => {
      throw new Error("forced failure");
    };
    const ok = makeHandler(h.service).send;
    const broken = makeHandler(failing).send;
    const withCookies = {
      cookies: [`${SESSION_COOKIE}=${MARK}`, `${TRANSACTION_COOKIE}=${MARK}`],
      headers: { cookie: `z=${MARK}`, "user-agent": `UA${MARK}` },
    };
    const long = `/${"p".repeat(300)}`;
    const { value, output } = await capture(async () => [
      await ok(
        event("GET", `/?code=${MARK}&state=${MARK}`, { ...withCookies, host: `${id}.${VIEW}` }),
      ),
      await ok(event("GET", `/__artifact/callback?code=${MARK}&state=${MARK}`, withCookies)),
      await broken(event("GET", "/", { ...withCookies, host: `${id}.${VIEW}` })),
      await ok(event("GET", long, { host: `${id}.${VIEW}` })),
    ]);
    assert.deepEqual(
      value.map((r) => r.statusCode),
      [200, 400, 500, 404],
    );
    assert.equal(value[2].headers["cache-control"], "no-store");
    assert.match(output, /forced failure/);
    assert.ok(!output.includes(MARK));
    const lines = accessLines(output);
    assert.equal(lines.length, 4);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line), [
        "requestId",
        "method",
        "host",
        "path",
        "status",
        "cookies",
        "ms",
      ]);
      assert.equal(typeof line.ms, "number");
      assert.match(line.requestId, /^req-/);
    }
    assert.deepEqual(
      lines.map((l) => [l.method, l.host, l.path, l.status, l.cookies]),
      [
        ["GET", `${id}.${VIEW}`, "/", 200, 3],
        ["GET", VIEW, "/__artifact/callback", 400, 3],
        ["GET", `${id}.${VIEW}`, "/", 500, 3],
        ["GET", `${id}.${VIEW}`, long.slice(0, 256), 404, 0],
      ],
    );
  });
});

describe("keepCookies", () => {
  it("keeps only the named cookies in the array and in every Cookie header, without mutating", () => {
    const input = {
      cookies: ["a=1", "keep=2", " keep = 3", "keepx=4"],
      headers: { cookie: "a=1; keep=2", COOKIE: "b=2", other: "y" },
    };
    const copy = structuredClone(input);
    const kept = keepCookies(input, ["keep"]);
    assert.deepEqual(kept.cookies, ["keep=2", " keep = 3"]);
    assert.deepEqual(kept.headers, { cookie: "keep=2", other: "y" });
    assert.deepEqual(input, copy);
    const none = keepCookies({ cookies: ["a=1"], headers: { cookie: "a=1" } }, ["keep"]);
    assert.equal(Object.hasOwn(none, "cookies"), false);
    assert.deepEqual(none.headers, {});
  });
});
