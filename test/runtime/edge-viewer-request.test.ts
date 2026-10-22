// The CloudFront viewer-request function (docs/decisions/0080) in node:vm with a fake
// KeyValueStore holding the shared session vectors' keys and the vectors' clock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PLACEHOLDER_LINE, renderEdgeFunction } from "../../src/cdk/edge.ts";
import {
  EDGE_DIST,
  EDGE_SOURCE,
  type EdgeRequest,
  type EdgeResponse,
  fakeEvent,
  IMPORT_LINES,
  isResponse,
  loadEdge,
} from "../support/edge-vm.ts";

type Vectors = {
  now: number;
  keys: Record<string, string>;
  valid: { name: string; cookie: string }[];
  invalid: { name: string; cookie: string }[];
};
const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/session-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const VIEW = "view.example.dev";
const ID = "01hzx3k5m7n9p1q3r5s7t9v1w3";
const ART = `${ID}.${VIEW}`;
const SESSION = "__Secure-artifact_session";
const TX = "__Host-artifact_login";
const NAVIGATE = { "sec-fetch-mode": "navigate", accept: "text/html" };
const VALID = vectors.valid[0].cookie;

const edge = (options: { kvsFails?: boolean } = {}) =>
  loadEdge({ viewDomain: VIEW, kvs: vectors.keys, now: vectors.now, ...options });

function response(result: EdgeRequest | EdgeResponse): EdgeResponse {
  assert.ok(isResponse(result), "expected a function-generated response");
  return result;
}
function request(result: EdgeRequest | EdgeResponse): EdgeRequest {
  assert.ok(!isResponse(result), `expected the request, got ${JSON.stringify(result)}`);
  return result;
}
const loginUrl = (target: string) =>
  `https://${VIEW}/__artifact/login?return=${encodeURIComponent(target)}`;

function assertText(res: EdgeResponse, status: number, data: string) {
  assert.equal(res.statusCode, status);
  assert.equal(res.headers["cache-control"].value, "no-store");
  assert.equal(res.headers["content-type"].value, "text/plain; charset=utf-8");
  assert.deepEqual(res.body, { encoding: "text", data });
}

describe("edge viewer-request: no session cookie", () => {
  const { handler } = edge();

  it("redirects a GET navigation to login with the exact return URL", async () => {
    const cases: [string, Parameters<typeof fakeEvent>[0]["querystring"], string][] = [
      [
        "/p",
        { a: { value: "1" }, b: { value: "2", multiValue: [{ value: "2" }, { value: "3" }] } },
        `https://${ART}/p?a=1&b=2&b=3`,
      ],
      ["/p", { x: { value: "" } }, `https://${ART}/p?x=`],
      ["/p", {}, `https://${ART}/p`],
    ];
    for (const [uri, querystring, target] of cases) {
      const res = response(
        await handler(fakeEvent({ host: ART, uri, querystring, headers: NAVIGATE })),
      );
      assert.equal(res.statusCode, 302, target);
      assert.equal(res.statusDescription, "Found");
      assert.equal(res.headers.location.value, loginUrl(target));
      assert.equal(res.headers["cache-control"].value, "no-store");
    }
    const gallery = response(await handler(fakeEvent({ host: VIEW, headers: NAVIGATE })));
    assert.equal(gallery.headers.location.value, loginUrl(`https://${VIEW}/`));
  });

  it("treats a GET without sec-fetch-mode as a navigation only when it accepts text/html", async () => {
    const html = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
    assert.equal(response(await handler(fakeEvent({ host: ART, headers: html }))).statusCode, 302);
    const noAccept = response(await handler(fakeEvent({ host: ART })));
    assertText(noAccept, 401, "unauthorized\n");
  });

  it("answers 401 to non-navigation GETs, HEAD and POST", async () => {
    const cases: [string, Record<string, string>][] = [
      ["GET", { "sec-fetch-mode": "cors", accept: "*/*" }],
      ["GET", { accept: "*/*" }],
      ["GET", { "sec-fetch-mode": "no-cors", accept: "text/html" }],
      ["HEAD", NAVIGATE],
      ["POST", NAVIGATE],
    ];
    for (const [method, headers] of cases) {
      const res = response(await handler(fakeEvent({ host: ART, method, headers })));
      assertText(res, 401, "unauthorized\n");
      assert.equal(res.statusDescription, "Unauthorized");
      assert.equal(res.headers.location, undefined);
    }
  });
});

describe("edge viewer-request: session vectors", () => {
  it("sends every invalid vector to login (302 navigation, 401 otherwise)", async () => {
    const { handler } = edge();
    for (const v of vectors.invalid) {
      const cookies = { [SESSION]: v.cookie };
      const nav = response(await handler(fakeEvent({ host: ART, headers: NAVIGATE, cookies })));
      assert.equal(nav.statusCode, 302, v.name);
      const api = response(await handler(fakeEvent({ host: ART, cookies })));
      assert.equal(api.statusCode, 401, v.name);
    }
  });

  it("lets both valid vectors through (current and previous kid)", async () => {
    const { handler } = edge();
    for (const v of vectors.valid) {
      const req = request(
        await handler(fakeEvent({ host: ART, cookies: { [SESSION]: v.cookie } })),
      );
      assert.equal(req.headers["x-artifact-host"].value, ART, v.name);
    }
  });

  it("fails closed when the KeyValueStore throws", async () => {
    const { handler, gets } = edge({ kvsFails: true });
    const cookies = { [SESSION]: VALID };
    const res = response(await handler(fakeEvent({ host: ART, headers: NAVIGATE, cookies })));
    assert.equal(res.statusCode, 302);
    assert.deepEqual(gets, [VALID.split(".")[1]]);
  });

  it("never asks the KeyValueStore about a malformed cookie", async () => {
    const { handler, gets } = edge();
    for (const name of [
      "v2 prefix",
      "missing segment",
      "uppercase kid",
      "bad base64url",
      "empty",
    ]) {
      const v = vectors.invalid.find((x) => x.name === name);
      assert.ok(v, name);
      await handler(fakeEvent({ host: ART, cookies: { [SESSION]: v.cookie } }));
    }
    assert.deepEqual(gets, []);
  });
});

describe("edge viewer-request: hosts, cookies and x-artifact-host", () => {
  const { handler } = edge();

  it("answers 403 to an unknown or missing Host, with or without a valid cookie", async () => {
    for (const host of [`api.${VIEW}`, "evil.example", `${ART}:8443`, `${VIEW}.`, "", undefined]) {
      for (const cookies of [{}, { [SESSION]: VALID }] as Record<string, string>[]) {
        const res = response(await handler(fakeEvent({ host, headers: NAVIGATE, cookies })));
        assertText(res, 403, "forbidden: unexpected Host header\n");
        assert.equal(res.statusDescription, "Forbidden");
      }
    }
  });

  it("strips every cookie and sets the normalised x-artifact-host, overwriting the client's", async () => {
    const cookies = { [SESSION]: VALID, [TX]: "t1.x", other: "1" };
    const headers = { "x-artifact-host": "evil.example", accept: "text/html" };
    for (const [host, normalised] of [
      [`${ID.toUpperCase()}.${VIEW.toUpperCase()}:443`, ART],
      [`${VIEW}:443`, VIEW],
      [ART, ART],
    ]) {
      const req = request(await handler(fakeEvent({ host, uri: "/v/2/a.css", headers, cookies })));
      assert.deepEqual(req.cookies, {}, host);
      assert.deepEqual(req.headers["x-artifact-host"], { value: normalised }, host);
      assert.equal(req.uri, "/v/2/a.css");
      assert.equal(req.headers.accept.value, "text/html");
    }
  });

  it("passes the login routes through on the main host with only the transaction cookie", async () => {
    for (const uri of ["/__artifact/login", "/__artifact/callback", "/__artifact/logout"]) {
      const cookies = { [SESSION]: VALID, [TX]: "t1.abc", other: "1" };
      const req = request(await handler(fakeEvent({ host: VIEW, uri, cookies })));
      assert.deepEqual(req.cookies, { [TX]: { value: "t1.abc" } }, uri);
      assert.deepEqual(req.headers["x-artifact-host"], { value: VIEW }, uri);
      const bare = request(await handler(fakeEvent({ host: `${VIEW}:443`, uri })));
      assert.deepEqual(bare.cookies, {}, uri);
      assert.deepEqual(bare.headers["x-artifact-host"], { value: VIEW }, uri);
    }
  });

  it("gives the login routes no passthrough on an artifact host or another path", async () => {
    const cases: [string, string][] = [
      [ART, "/__artifact/login"],
      [ART, "/__artifact/callback"],
      [VIEW, "/__artifact/login/"],
      [VIEW, "/__artifact/loginx"],
      [VIEW, "/__artifact/version"],
    ];
    for (const [host, uri] of cases) {
      const res = response(await handler(fakeEvent({ host, uri, cookies: { [TX]: "t1.abc" } })));
      assert.equal(res.statusCode, 401, `${host}${uri}`);
    }
    const req = request(
      await handler(
        fakeEvent({
          host: ART,
          uri: "/__artifact/login",
          cookies: { [SESSION]: VALID, [TX]: "t" },
        }),
      ),
    );
    assert.deepEqual(req.cookies, {});
  });
});

describe("edge viewer-request: the shipped source", () => {
  const source = readFileSync(EDGE_SOURCE, "utf8");

  it("keeps the shipped imports, the empty line and one placeholder line (source and dist)", () => {
    for (const [name, text] of [
      ["source", source],
      ["dist", readFileSync(EDGE_DIST, "utf8")],
    ]) {
      const lines = text.split("\n");
      assert.deepEqual(lines.slice(0, 3), [...IMPORT_LINES, ""], name);
      assert.equal(lines.filter((l) => l === PLACEHOLDER_LINE).length, 1, name);
    }
    assert.equal(readFileSync(EDGE_DIST, "utf8"), source);
  });

  it("uses nothing the cloudfront-js-2.0 runtime lacks", () => {
    const forbidden =
      /setTimeout|setInterval|process\.|eval\(|new Function|require\(|timingSafeEqual|async \(|async function (?!handler\()|=>/;
    assert.doesNotMatch(source, forbidden);
    assert.deepEqual(
      source.split("\n").filter((l) => /^\s*import\b/.test(l) || /\bimport\s*\(/.test(l)),
      IMPORT_LINES,
    );
    assert.equal(source.match(/\bawait\b/g)?.length, 1);
    assert.equal(source.match(/\basync function\b/g)?.length, 1);
    assert.match(source, /^async function handler\(event\) \{$/m);
    assert.doesNotMatch(source, /^export\b/m);
  });

  it("runs in a sandbox without process, timers, require or fetch", () => {
    const { run } = edge();
    for (const name of ["process", "setTimeout", "setInterval", "require", "fetch"]) {
      assert.equal(run(`typeof ${name}`), "undefined", name);
    }
    assert.throws(() => run('console.log("a", "b")'), /exactly one argument/);
  });

  it("stays under 10,240 bytes with a 253-character view domain", () => {
    const longest = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    assert.equal(longest.length, 253);
    const rendered = renderEdgeFunction(source, longest);
    assert.ok(Buffer.byteLength(rendered) < 10_240, String(Buffer.byteLength(rendered)));
    assert.ok(rendered.includes(`const VIEW_DOMAIN = ${JSON.stringify(longest)};`));
  });
});

describe("renderEdgeFunction", () => {
  const source = readFileSync(EDGE_SOURCE, "utf8");

  it("substitutes the view domain for the placeholder line", () => {
    const rendered = renderEdgeFunction(source, VIEW);
    assert.ok(rendered.includes(`\nconst VIEW_DOMAIN = "${VIEW}";\n`));
    assert.ok(!rendered.includes("__ARTIFACT_VIEW_DOMAIN__"));
    assert.equal(rendered.split("\n").length, source.split("\n").length);
  });

  it("requires the placeholder exactly once as a whole line", () => {
    const without = source.replace(`${PLACEHOLDER_LINE}\n`, "");
    const twice = `${source}${PLACEHOLDER_LINE}\n`;
    const indented = source.replace(PLACEHOLDER_LINE, `  ${PLACEHOLDER_LINE}`);
    for (const text of [without, twice, indented]) {
      assert.throws(() => renderEdgeFunction(text, VIEW), {
        message:
          "artifact: the edge function must hold the view-domain placeholder line exactly once",
      });
    }
  });

  it("refuses a function of 10,240 bytes or more", () => {
    // Rendering with "x" shrinks the placeholder line by `shrink` bytes.
    const shrink = PLACEHOLDER_LINE.length - 'const VIEW_DOMAIN = "x";'.length;
    const sized = (bytes: number) =>
      `${source}//${"x".repeat(bytes - Buffer.byteLength(source) - 2 + shrink)}`;
    assert.equal(Buffer.byteLength(renderEdgeFunction(sized(10_239), "x")), 10_239);
    assert.throws(
      () => renderEdgeFunction(sized(10_240), "x"),
      /CloudFront Functions need it under 10240$/,
    );
  });
});
