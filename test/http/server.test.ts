import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { listen, PortInUseError } from "../../src/http/server.ts";

const handler: RequestListener = (_req, res) => res.end("ok");

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe("listen", () => {
  it("binds 127.0.0.1 and ::1, or warns that ::1 is unavailable", async () => {
    const port = await freePort();
    const warnings: string[] = [];
    const listening = await listen(handler, { port, warn: (m) => warnings.push(m) });
    try {
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
      const addresses = listening.servers.map((s) => (s.address() as AddressInfo).address);
      if (addresses.includes("::1")) {
        assert.deepEqual(warnings, []);
        assert.equal(await (await fetch(`http://[::1]:${port}/`)).text(), "ok");
      } else {
        assert.deepEqual(addresses, ["127.0.0.1"]);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /::1 unavailable \(E[A-Z]+\); listening on 127\.0\.0\.1 only/);
      }
    } finally {
      await listening.close();
    }
    const again = await listen(handler, { port, warn: () => {} });
    await again.close();
  });

  it("reports an occupied port with the --port / ARTIFACT_PORT message", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    try {
      await assert.rejects(listen(handler, { port, warn: () => {} }), (error) => {
        assert.ok(error instanceof PortInUseError);
        assert.equal(error.port, port);
        assert.equal(
          error.message,
          `artifact: port ${port} is already in use; pick another with --port <n> or ARTIFACT_PORT=<n>`,
        );
        return true;
      });
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("binds only the given host", async () => {
    const port = await freePort();
    const listening = await listen(handler, { port, host: "127.0.0.1", warn: () => {} });
    try {
      assert.equal(listening.servers.length, 1);
      assert.equal((listening.servers[0].address() as AddressInfo).address, "127.0.0.1");
    } finally {
      await listening.close();
    }
  });
});
