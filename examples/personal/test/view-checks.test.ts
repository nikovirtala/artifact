// The pure predicates of the viewing-plane smoke checks (docs/decisions/0086); no AWS calls.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEvent } from "../scripts/lib/logs.ts";
import {
  authorizeProblems,
  leaks,
  loginCookieKid,
  loginLocation,
  logoutCookieOk,
  parseViewLine,
  setCookie,
  viewLineFor,
} from "../scripts/lib/view-checks.ts";

const T = 1_790_000_000_000;
const ev = (message: string, timestamp = T): LogEvent => ({ message, timestamp });
const COOKIE =
  "v1.0123456789abcdef.eyJzdWIiOiJ4IiwiZW1haWwiOiJ5IiwiaWF0IjoxLCJleHAiOjJ9.W9a4LWV1RzcEwRcCPT5db7_Ijd5ZZPeAsiferJdUDkA";
const [, , PAYLOAD, SIG] = COOKIE.split(".");
const MARKER = "0123456789abcdef0123456789abcdef";
const needles = { "cookie payload": PAYLOAD, "cookie signature": SIG, marker: MARKER };
const viewLine = (path: string, cookies: number) =>
  `2026-10-21T10:00:00.000Z\tid\tINFO\tartifact view ${JSON.stringify({
    requestId: "r",
    method: "GET",
    host: "p.view.example.dev",
    path,
    status: 404,
    cookies,
    ms: 3,
  })}`;

describe("leaks", () => {
  it("flags a cookie verbatim, its signature segment alone and the marker form", () => {
    assert.deepEqual(
      leaks([ev(`headers {"cookie":"__Secure-artifact_session=${COOKIE}"}`)], needles),
      ["cookie payload", "cookie signature"],
    );
    assert.deepEqual(leaks([ev(`sig ${SIG}`)], needles), ["cookie signature"]);
    assert.deepEqual(leaks([ev(`cookie: smoke_marker=${MARKER}`)], needles), ["marker"]);
  });

  it("does not flag the access line with cookies 0, and never returns values", () => {
    assert.deepEqual(leaks([ev(viewLine("/smokectlx.html", 0))], needles), []);
    const found = leaks([ev(COOKIE), ev(MARKER)], needles);
    assert.ok(found.every((label) => label in needles));
    assert.equal(found.join().includes(SIG), false);
  });
});

describe("view access line", () => {
  it("parses behind the runtime prefix and finds the control line", () => {
    assert.equal(parseViewLine(viewLine("/a", 0))?.path, "/a");
    for (const bad of ["", "artifact view {", 'artifact view {"path":"/a"}', "other"]) {
      assert.equal(parseViewLine(bad), undefined, bad);
    }
    const events = [
      ev(viewLine("/a", 1)),
      ev(viewLine("/a", 0), T - 60_000),
      ev(viewLine("/b", 0)),
    ];
    assert.equal(viewLineFor(events, "/a", T), undefined, "cookies 1 or too old");
    assert.equal(viewLineFor(events, "/b", T)?.cookies, 0);
  });
});

describe("loginCookieKid (S41)", () => {
  const tx = "t1.0123456789abcdef.eyJ4IjoxfQ.ivo6x8zPHRXM3c15RxFlNU8XLYaaIkes6UGtsAwO_W8";
  it("reads the kid of the first transaction cookie", () => {
    assert.equal(
      loginCookieKid([
        "__Secure-artifact_session=; Max-Age=0",
        `__Host-artifact_login=${tx}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`,
      ]),
      "0123456789abcdef",
    );
  });

  it("is undefined for another name, a v1 value or a non-hex kid", () => {
    assert.equal(loginCookieKid([`other=${tx}; Path=/`]), undefined);
    assert.equal(loginCookieKid([`__Host-artifact_login=${COOKIE}; Path=/`]), undefined);
    assert.equal(
      loginCookieKid([
        `__Host-artifact_login=${tx.replace("0123456789abcdef", "0123456789ABCDEF")}`,
      ]),
      undefined,
    );
    assert.equal(loginCookieKid([]), undefined);
  });
});

describe("login and logout helpers", () => {
  const view = "view.example.dev";
  it("builds the expected login location", () => {
    assert.equal(
      loginLocation(view, "https://p.view.example.dev/"),
      "https://view.example.dev/__artifact/login?return=https%3A%2F%2Fp.view.example.dev%2F",
    );
  });

  it("names every missing authorize parameter", () => {
    const base = "https://login.example.dev";
    const ok = `${base}/oauth2/authorize?client_id=c&response_type=code&code_challenge=x&code_challenge_method=S256&state=s&nonce=n&redirect_uri=${encodeURIComponent(`https://${view}/__artifact/callback`)}&scope=openid+email`;
    assert.deepEqual(authorizeProblems(ok, { loginDomainUrl: base, clientId: "c", view }), []);
    assert.deepEqual(
      authorizeProblems(`${base}/oauth2/authorize?client_id=d&response_type=token`, {
        loginDomainUrl: base,
        clientId: "c",
        view,
      }),
      ["client_id", "code_challenge_method", "response_type", "state", "nonce", "redirect_uri"],
    );
    assert.deepEqual(
      authorizeProblems("https://evil.example/oauth2/authorize?", {
        loginDomainUrl: base,
        clientId: "c",
        view,
      }),
      ["location"],
    );
  });

  it("reads a set-cookie value by name", () => {
    assert.equal(setCookie(["a=1; Path=/", "b=2; Path=/"], "b"), "b=2; Path=/");
    assert.equal(setCookie(["ab=1"], "a"), undefined);
  });

  it("checks the logout cookie (S40)", () => {
    const good = `__Secure-artifact_session=; Domain=${view}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
    assert.equal(logoutCookieOk([good], view), true);
    assert.equal(logoutCookieOk([good.replace("Max-Age=0", "Max-Age=60")], view), false);
    assert.equal(logoutCookieOk([good.replace(`Domain=${view}`, "Domain=other.dev")], view), false);
    assert.equal(logoutCookieOk(["__Host-artifact_login=; Path=/; Max-Age=0"], view), false);
  });
});
