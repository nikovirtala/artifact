import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import {
  injectReloadScript,
  injectReloadScriptBytes,
  reloadScriptTag,
} from "../../src/core/inject.ts";

const anyTag = /<script src="\/__artifact\/reload\.js" data-version="\d+" defer><\/script>/gi;

function countTags(html: string): number {
  return [...html.matchAll(anyTag)].length;
}

describe("injectReloadScript", () => {
  it("builds the documented tag", () => {
    assert.equal(
      reloadScriptTag(7),
      '<script src="/__artifact/reload.js" data-version="7" defer></script>',
    );
    assert.throws(() => reloadScriptTag(0), RangeError);
  });

  it("inserts before the last </body>, case-insensitively", () => {
    const tag = reloadScriptTag(2);
    assert.equal(
      injectReloadScript("<html><body><p>x</p></body></html>", 2),
      `<html><body><p>x</p>${tag}</body></html>`,
    );
    assert.equal(
      injectReloadScript("<BODY>a</BODY>b</Body >c", 2),
      `<BODY>a</BODY>b${tag}</Body >c`,
    );
  });

  it("appends at the end when there is no </body>", () => {
    assert.equal(injectReloadScript("<h1>hi</h1>", 1), `<h1>hi</h1>${reloadScriptTag(1)}`);
    assert.equal(injectReloadScript("", 1), reloadScriptTag(1));
  });

  it("never yields two tags when re-injecting", () => {
    const once = injectReloadScript("<body>x</body>", 1);
    const twice = injectReloadScript(once, 2);
    assert.equal(countTags(twice), 1);
    assert.equal(twice, `<body>x${reloadScriptTag(2)}</body>`);
  });

  it("property: exactly one tag, placed before the last </body> or at the end", () => {
    const fragment = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.constantFrom("</body>", "</BODY>", "</body >", "<body>", "</html>", "<script>", "</"),
      fc.integer({ min: 1, max: 99 }).map(reloadScriptTag),
    );
    fc.assert(
      fc.property(
        fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join("")),
        fc.integer({ min: 1, max: 10_000 }),
        (html, version) => {
          const out = injectReloadScript(html, version);
          const tag = reloadScriptTag(version);
          assert.equal(countTags(out), 1);
          const at = out.indexOf(tag);
          const rest = out.slice(at + tag.length);
          assert.ok(rest === "" || /^<\/body\s*>/i.test(rest), "tag precedes </body> or ends");
          assert.ok(!/<\/body\s*>/i.test(rest.replace(/^<\/body\s*>/i, "")), "last </body>");
          if (countTags(html) === 0) assert.equal(out.slice(0, at) + rest, html);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("injectReloadScriptBytes", () => {
  it("property: arbitrary bytes keep every original byte around exactly one tag", () => {
    const tagBytes = (v: number) => new TextEncoder().encode(reloadScriptTag(v));
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.uint8Array({ maxLength: 16 }),
            fc
              .constantFrom("</body>", "</BODY>", "é</body>ü")
              .map((s) => new TextEncoder().encode(s)),
          ),
          { maxLength: 8 },
        ),
        fc.integer({ min: 1, max: 500 }),
        (parts, version) => {
          const input = new Uint8Array(parts.flatMap((p) => [...p]));
          const original = input.slice();
          const out = injectReloadScriptBytes(input, version);
          assert.deepEqual(input, original, "input not mutated");
          const tag = tagBytes(version);
          assert.equal(out.length, input.length + tag.length);
          const asLatin1 = (b: Uint8Array) => String.fromCharCode(...b);
          const at = asLatin1(out).indexOf(asLatin1(tag));
          assert.ok(at >= 0);
          assert.equal(countTags(asLatin1(out)), 1);
          const without = new Uint8Array([
            ...out.subarray(0, at),
            ...out.subarray(at + tag.length),
          ]);
          assert.deepEqual(without, input);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("leaves non-ascii utf-8 intact", () => {
    const html = "<body>héllo 👋</body>";
    const out = new TextDecoder().decode(
      injectReloadScriptBytes(new TextEncoder().encode(html), 3),
    );
    assert.equal(out, `<body>héllo 👋${reloadScriptTag(3)}</body>`);
  });
});
