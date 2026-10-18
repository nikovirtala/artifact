import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { type CliContext, CliError, EXIT, UsageError } from "../../src/cli/output.ts";
import { confirmed, deletePrompt, run } from "../../src/cli/rm.ts";

const ID = "01k0000000000000000000000a";
const UNKNOWN = "01k0000000000000000000000b";

describe("deletePrompt", () => {
  it("names the title, id and version count", () => {
    const v = (version: number) => ({ version, createdAt: "t" });
    assert.equal(
      deletePrompt({ id: ID, title: "My page", versions: [v(1), v(2)] }),
      `Delete "My page" (${ID}, 2 versions)? [y/N] `,
    );
    assert.equal(
      deletePrompt({ id: ID, versions: [v(1)] }),
      `Delete "(untitled)" (${ID}, 1 version)? [y/N] `,
    );
  });
});

describe("confirmed", () => {
  it("is true only on y or yes", () => {
    const answers: Record<string, boolean> = {
      y: true,
      yes: true,
      " YES\n": true,
      Y: true,
      n: false,
      no: false,
      "": false,
      yep: false,
    };
    for (const [answer, expected] of Object.entries(answers)) {
      assert.equal(confirmed(answer), expected, JSON.stringify(answer));
    }
  });
});

describe("rm run", () => {
  let server: Server;
  let base: string;
  const requests: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url !== `/api/artifacts/${ID}`) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", message: "artifact not found" }));
      } else if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        const versions = [1, 2, 3].map((version) => ({ version, createdAt: "t" }));
        res.end(JSON.stringify({ id: ID, title: "Report", currentVersion: 3, versions }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    requests.length = 0;
  });

  /** A context whose stdin is a TTY-like stream that answers `answer`. */
  function context(isTTY: boolean, answer?: string) {
    const stdin = Object.assign(new PassThrough(), { isTTY });
    if (answer !== undefined) stdin.end(`${answer}\n`);
    let stdout = "";
    let stderr = "";
    const sink = (write: (chunk: string) => void) => {
      const stream = new PassThrough();
      stream.setEncoding("utf8");
      stream.on("data", write);
      return stream;
    };
    const ctx: CliContext = {
      env: { ARTIFACT_SERVER: base },
      cwd: "/",
      home: "/",
      stdin,
      stdout: sink((c) => {
        stdout += c;
      }),
      stderr: sink((c) => {
        stderr += c;
      }),
    };
    return { ctx, out: () => stdout, err: () => stderr };
  }

  const tick = () => new Promise((r) => setImmediate(r));

  it("without a TTY and --yes is a usage error before any request", async () => {
    const { ctx } = context(false);
    await assert.rejects(
      run([ID], ctx),
      (error) => error instanceof UsageError && /--yes/.test(error.message),
    );
    assert.deepEqual(requests, []);
  });

  it("looks the artifact up, asks, and deletes on y", async () => {
    const { ctx, out, err } = context(true, "y");
    assert.equal(await run([ID], ctx), EXIT.ok);
    await tick();
    assert.deepEqual(requests, [`GET /api/artifacts/${ID}`, `DELETE /api/artifacts/${ID}`]);
    assert.equal(err(), `Delete "Report" (${ID}, 3 versions)? [y/N] `);
    assert.equal(out(), `deleted ${ID}\n`);
  });

  it("declining prints not deleted, exits 1 and sends no DELETE", async () => {
    const { ctx, out, err } = context(true, "n");
    assert.equal(await run([ID], ctx), EXIT.error);
    await tick();
    assert.deepEqual(requests, [`GET /api/artifacts/${ID}`]);
    assert.equal(err(), `Delete "Report" (${ID}, 3 versions)? [y/N] not deleted\n`);
    assert.equal(out(), "");
  });

  it("an unknown id fails with not_found before the prompt", async () => {
    const { ctx, err } = context(true, "y");
    await assert.rejects(
      run([UNKNOWN], ctx),
      (error) => error instanceof CliError && error.code === "not_found",
    );
    await tick();
    assert.deepEqual(requests, [`GET /api/artifacts/${UNKNOWN}`]);
    assert.equal(err(), "");
  });

  it("--yes sends one DELETE and no lookup, TTY or not", async () => {
    for (const isTTY of [true, false]) {
      requests.length = 0;
      const { ctx, err } = context(isTTY);
      assert.equal(await run([ID, "--yes"], ctx), EXIT.ok);
      await tick();
      assert.deepEqual(requests, [`DELETE /api/artifacts/${ID}`]);
      assert.equal(err(), "");
    }
  });
});
