// The edge function's Host rules equal DomainHostPolicy.classify (docs/decisions/0080, 0053): the
// edge answers 403 exactly for the hosts the policy rejects.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { DomainHostPolicy } from "../../src/http/host-policy.ts";
import { fakeEvent, isResponse, loadEdge } from "../support/edge-vm.ts";

const VIEW = "art.example.dev";
const id = "01hzx3k5m7n9p1q3r5s7t9v1w3";
const ID = id.toUpperCase();
const policy = new DomainHostPolicy({ viewDomain: VIEW });
const { handler } = loadEdge({ viewDomain: VIEW, kvs: {}, now: 1_790_000_000 });

/** The edge's verdict on `host` with no cookie: true when it answers 403. */
async function edgeRejects(host: string): Promise<boolean> {
  const result = await handler(fakeEvent({ host, uri: "/" }));
  if (!isResponse(result)) throw new Error(`no cookie passed the edge for ${JSON.stringify(host)}`);
  assert.ok([401, 403].includes(result.statusCode), String(result.statusCode));
  return result.statusCode === 403;
}

// The DomainHostPolicy cases of test/http/host-policy.test.ts, plus the edge's own.
const HOSTS = [
  VIEW,
  "ART.Example.Dev",
  `${VIEW}:443`,
  `${id}.${VIEW}`,
  `${ID}.${VIEW}`,
  `${id}.ART.EXAMPLE.DEV`,
  `${id}.${VIEW}:443`,
  `www.${VIEW}`,
  `api.${VIEW}`,
  `notanid.${VIEW}`,
  `x.${id}.${VIEW}`,
  `.${VIEW}`,
  `${id}1.${VIEW}`,
  "evil.example",
  `${id}.${VIEW}.evil.example`,
  `${id}.evilart.example.dev`,
  `evil${VIEW}`,
  "example.dev",
  `${id}.localhost`,
  "localhost",
  "127.0.0.1",
  "[::1]",
  "10.0.0.1",
  "[::1]:443",
  `${VIEW}:80`,
  `${VIEW}:8443`,
  `${VIEW}:4400`,
  `${VIEW}:`,
  `${id}.${VIEW}:80`,
  `${id}.${VIEW}:`,
  `${VIEW}:443:443`,
  `${VIEW}.`,
  `${id}.${VIEW}.`,
  "",
  // the edge's additions
  `${id}.${VIEW}:8443`,
  `a.${id}.${VIEW}`,
  `${ID}.${VIEW}:443`,
];

describe("edge host parity with DomainHostPolicy", () => {
  it("agrees on the fixed table", async () => {
    for (const host of HOSTS) {
      const expected = policy.classify(host).kind === "reject";
      assert.equal(await edgeRejects(host), expected, JSON.stringify(host));
    }
  });

  it("agrees on hosts built from random parts", async () => {
    const parts = [id, ID, VIEW, VIEW.toUpperCase(), "example.dev", ".", ":", ":443", ":8443"];
    const more = ["api", "www", "x", "-", "1", "[::1]", "127.0.0.1", "evil.example", "art"];
    const part = fc.oneof(
      fc.constantFrom(...parts, ...more),
      fc.string({ maxLength: 3 }),
      fc.stringMatching(/^[0-9a-hjkmnp-tv-zA-Z]{25,27}$/),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(part, { maxLength: 5 }), async (pieces) => {
        const host = pieces.join("");
        return (await edgeRejects(host)) === (policy.classify(host).kind === "reject");
      }),
      { numRuns: 1000 },
    );
  });
});
