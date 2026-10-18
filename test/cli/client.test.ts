import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createClient, DEFAULT_SERVER, resolveServer } from "../../src/cli/client.ts";
import { CliError, UsageError } from "../../src/cli/output.ts";
import { freePort } from "../support/e2e.ts";

describe("resolveServer", () => {
  it("prefers --server over ARTIFACT_SERVER over the default", () => {
    assert.equal(resolveServer(undefined, {}), DEFAULT_SERVER);
    assert.equal(resolveServer(undefined, { ARTIFACT_SERVER: "" }), DEFAULT_SERVER);
    assert.equal(resolveServer(undefined, { ARTIFACT_SERVER: "http://e:1" }), "http://e:1");
    assert.equal(resolveServer("https://f:2/", { ARTIFACT_SERVER: "http://e:1" }), "https://f:2");
  });

  it("rejects anything but an http(s) URL as a usage error", () => {
    assert.throws(() => resolveServer("localhost:4400", {}), UsageError);
    assert.throws(() => resolveServer("ftp://x/", {}), /--server must be an http\(s\) URL/);
    assert.throws(
      () => resolveServer(undefined, { ARTIFACT_SERVER: "nope" }),
      /ARTIFACT_SERVER must be an http\(s\) URL, got "nope"/,
    );
  });
});

describe("createClient", () => {
  let server: Server;
  let base: string;
  const seen: IncomingHttpHeaders[] = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === "/api/fail") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "version_conflict", message: "current is 2", currentVersion: 2 }),
        );
      } else if (req.url === "/api/html") {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<p>bad gateway</p>");
      } else if (req.url === "/api/bytes") {
        res.end(Buffer.from([0, 255, 1]));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("sends the bearer token only when set, and never Origin or Sec-Fetch-Site", async () => {
    seen.length = 0;
    const withToken = createClient({ server: base, token: "s3cret" });
    assert.deepEqual((await withToken.json("POST", "/api/x", { body: { a: 1 } })).body, {
      ok: true,
    });
    await withToken.bytes("/api/bytes");
    await createClient({ server: base }).json("GET", "/api/x");
    await createClient({ server: base, token: "" }).json("GET", "/api/x");
    assert.equal(seen.length, 4);
    assert.equal(seen[0].authorization, "Bearer s3cret");
    assert.equal(seen[0]["content-type"], "application/json");
    assert.equal(seen[1].authorization, "Bearer s3cret");
    assert.equal(seen[2].authorization, undefined);
    assert.equal(seen[3].authorization, undefined);
    for (const headers of seen) {
      assert.equal(headers.origin, undefined);
      assert.equal(headers["sec-fetch-site"], undefined);
    }
  });

  it("returns raw bytes", async () => {
    const { body } = await createClient({ server: base }).bytes("/api/bytes");
    assert.deepEqual(body, new Uint8Array([0, 255, 1]));
  });

  it("maps the API error body to a CliError with its code and other fields", async () => {
    await assert.rejects(createClient({ server: base }).json("GET", "/api/fail"), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "version_conflict");
      assert.equal(error.message, "current is 2");
      assert.deepEqual(error.details, { currentVersion: 2 });
      return true;
    });
  });

  it("maps any other non-2xx response to bad_response", async () => {
    await assert.rejects(createClient({ server: base }).bytes("/api/html"), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "bad_response");
      assert.equal(error.message, `unexpected HTTP 502 from ${base}/api/html`);
      assert.deepEqual(error.details, {});
      return true;
    });
  });

  it("reports no_server with the URL and how to start one when nothing listens", async () => {
    const closed = `http://127.0.0.1:${await freePort()}`;
    await assert.rejects(
      createClient({ server: closed }).json("GET", "/api/artifacts"),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "no_server");
        assert.ok(
          error.message.includes(`no artifact server answered at ${closed}`),
          error.message,
        );
        assert.match(error.message, /ECONNREFUSED/);
        assert.match(error.message, /`artifact serve`/);
        return true;
      },
    );
  });
});
