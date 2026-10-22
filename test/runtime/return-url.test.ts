// The login `return` parameter (docs/decisions/0081): https on the view domain or one of its
// artifact subdomains, parsed without a base; anything else lands on the gallery.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainHostPolicy } from "../../src/http/host-policy.ts";
import { validateReturn } from "../../src/runtime/auth/return-url.ts";

const VIEW = "art.example.dev";
const ID = "01m55g1mv87q1zb2gpj07jz10e";
const hosts = new DomainHostPolicy({ viewDomain: VIEW });
const GALLERY = `https://${VIEW}/`;

describe("validateReturn", () => {
  it("keeps https URLs on the view domain and its artifact subdomains", () => {
    const cases: [string, string][] = [
      [`https://${VIEW}/`, `https://${VIEW}/`],
      [`https://${VIEW}`, `https://${VIEW}/`],
      [`https://${ID}.${VIEW}/docs/?a=1&b=2#top`, `https://${ID}.${VIEW}/docs/?a=1&b=2#top`],
      [`https://${ID.toUpperCase()}.ART.example.dev/p`, `https://${ID}.${VIEW}/p`],
      [`https://${VIEW}:443/x`, `https://${VIEW}/x`],
    ];
    for (const [value, expected] of cases) assert.equal(validateReturn(value, hosts), expected);
  });

  it("accepts exactly 2048 characters and refuses 2049", () => {
    const base = `https://${ID}.${VIEW}/`;
    const at = (n: number) => base + "a".repeat(n - base.length);
    assert.equal(validateReturn(at(2048), hosts), at(2048));
    assert.equal(validateReturn(at(2049), hosts), GALLERY);
  });

  it("sends everything else to the gallery", () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      ["https://art.example.dev/"],
      "",
      `http://${VIEW}/`,
      `http://${ID}.${VIEW}/`,
      `https://user@${VIEW}/`,
      `https://user:pass@${VIEW}/`,
      `https://:pass@${VIEW}/`,
      `https://${VIEW}:8443/`,
      `https://${VIEW}:80/`,
      "https://evil.example/",
      `https://${VIEW}.evil.example/`,
      `https://evil${VIEW}/`,
      `https://a.${ID}.${VIEW}/`,
      `https://notanartifactid.${VIEW}/`,
      `https://${VIEW}./`,
      "https://[::1]/",
      "https://127.0.0.1/",
      "/relative",
      "relative/path",
      `//${VIEW}/x`,
      "https:\\\\evil.example",
      "https:\\evil",
      `https:/\\${VIEW}.evil.example/`,
      "javascript:alert(1)",
      `data:text/html,<a href="https://${VIEW}/">`,
      `https://${VIEW}/\n`,
      `https://${VIEW}/a\tb`,
      `https://${VIEW}/\u0000`,
      `https://${VIEW}/\u007f`,
      `https://${VIEW}/\u0085`,
    ];
    for (const value of bad) assert.equal(validateReturn(value, hosts), GALLERY, String(value));
  });
});
