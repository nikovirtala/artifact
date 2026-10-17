import assert from "node:assert/strict";
import { posix, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import fc from "fast-check";
import {
  contentTypeFor,
  isArtifactId,
  manifestKey,
  metaKey,
  normalizePath,
  srcKey,
  validateFilePath,
  versionPrefix,
  wwwKey,
} from "../../src/core/paths.ts";

describe("normalizePath", () => {
  it("accepts and normalises relative paths", () => {
    for (const [input, expected] of [
      ["index.html", "index.html"],
      ["./index.html", "index.html"],
      ["a//b/./c.css", "a/b/c.css"],
      [".well-known/x.json", ".well-known/x.json"],
      ["a..b/c...js", "a..b/c...js"],
    ]) {
      assert.deepEqual(normalizePath(input), { ok: true, value: expected }, input);
    }
  });

  it("rejects unsafe paths as invalid_path", () => {
    for (const input of [
      "",
      ".",
      "./",
      "/etc/passwd",
      "//x.html",
      "../x.html",
      "a/../../x.html",
      "a/..",
      "a\\b.html",
      "..\\x.html",
      "a\0.html",
      "a\n.html",
      "C:/x.html",
      "c:x.html",
      "dir/",
    ]) {
      const result = normalizePath(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      if (!result.ok) {
        assert.equal(result.error.code, "invalid_path");
        assert.equal(result.error.path, input);
      }
    }
  });

  it("property: accepted paths stay inside the version directory", () => {
    const versionDir = "/root/artifacts/01h0000000000000000000000/v/1/src";
    const nativeDir = resolve(versionDir);
    const chars = fc.constantFrom("a", "B", ".", "/", "\\", "\0", ":", "%", " ", "é", "~", "-");
    const pathArb = fc.oneof(
      fc.string({ unit: chars, maxLength: 24 }),
      fc
        .array(fc.constantFrom("..", ".", "", "a", "b.html", "..a", "a..", "%2e%2e", "\\.."), {
          maxLength: 6,
        })
        .map((segments) => segments.join("/")),
      fc.string({ maxLength: 24 }),
    );
    fc.assert(
      fc.property(pathArb, (input) => {
        const result = normalizePath(input);
        if (!result.ok) return;
        const p = result.value;
        assert.ok(posix.join(versionDir, p).startsWith(`${versionDir}/`), p);
        assert.ok(posix.resolve(versionDir, p).startsWith(`${versionDir}/`), p);
        assert.ok(resolve(nativeDir, p).startsWith(nativeDir + sep), p);
        assert.ok(!p.split("/").includes(".."), p);
        assert.deepEqual(normalizePath(p), { ok: true, value: p }, "idempotent");
        const key = srcKey("01h0000000000000000000000a", 1, p);
        assert.ok(key.startsWith(versionPrefix("01h0000000000000000000000a", 1)));
      }),
      { numRuns: 2000 },
    );
  });
});

describe("content types", () => {
  it("derives types from the extension allowlist, case-insensitively", () => {
    assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor("a/b/APP.JS"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor("m.mjs"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor("f.woff2"), "font/woff2");
    assert.equal(contentTypeFor("p.jpg"), "image/jpeg");
    for (const ext of [
      "html",
      "css",
      "js",
      "mjs",
      "json",
      "svg",
      "png",
      "jpg",
      "gif",
      "webp",
      "avif",
      "ico",
      "woff",
      "woff2",
      "txt",
      "md",
      "csv",
      "pdf",
      "mp4",
      "webm",
    ]) {
      assert.ok(contentTypeFor(`x.${ext}`), ext);
    }
  });

  it("rejects disallowed or missing extensions as invalid_path", () => {
    for (const input of ["run.sh", "a.exe", "README", ".html", "x.htm", "x.jpeg", "x.toString"]) {
      const result = validateFilePath(input);
      assert.equal(result.ok, false, input);
      if (!result.ok) assert.equal(result.error.code, "invalid_path");
    }
  });

  it("validateFilePath returns the normalised path with its content type", () => {
    assert.deepEqual(validateFilePath("./css//site.css"), {
      ok: true,
      value: { path: "css/site.css", contentType: "text/css; charset=utf-8" },
    });
  });
});

describe("keys", () => {
  const id = "01hzx3k5m7n9p1q3r5s7t9v1w3";

  it("follows the documented layout", () => {
    assert.equal(metaKey(id), `artifacts/${id}/meta.json`);
    assert.equal(manifestKey(id, 3), `artifacts/${id}/v/3/manifest.json`);
    assert.equal(srcKey(id, 3, "a/b.css"), `artifacts/${id}/v/3/src/a/b.css`);
    assert.equal(wwwKey(id, 3, "index.html"), `artifacts/${id}/v/3/www/index.html`);
  });

  it("isArtifactId accepts only 26-char lowercase crockford base32", () => {
    assert.ok(isArtifactId(id));
    assert.ok(!isArtifactId(id.toUpperCase()));
    assert.ok(!isArtifactId(`${id}0`));
    assert.ok(!isArtifactId("01hzx3k5m7n9p1q3r5s7t9v1wu"));
    assert.ok(!isArtifactId("../../../../etc/passwd/xxxx"));
  });
});
