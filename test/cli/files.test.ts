import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { collectFiles } from "../../src/cli/files.ts";
import { CliError } from "../../src/cli/output.ts";

const dir = mkdtempSync(join(tmpdir(), "artifact-files-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, body: string | Uint8Array): string {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
}

const rejectsWith = (code: string) => (error: unknown) => {
  assert.ok(error instanceof CliError);
  assert.equal(error.code, code);
  return true;
};

describe("collectFiles", () => {
  it("sends an .html or .htm file alone as index.html", async () => {
    const warnings: string[] = [];
    const page = write("single/page.html", "<h1>hi</h1>");
    assert.deepEqual(await collectFiles(page, (w) => warnings.push(w)), {
      files: { "index.html": "<h1>hi</h1>" },
      skipped: [],
    });
    const upper = write("single/OTHER.HTM", "<p>x</p>");
    assert.deepEqual(await collectFiles(upper, (w) => warnings.push(w)), {
      files: { "index.html": "<p>x</p>" },
      skipped: [],
    });
    assert.deepEqual(warnings, []);
  });

  it("rejects a non-html file and a missing path", async () => {
    const css = write("single/site.css", "body{}");
    await assert.rejects(
      collectFiles(css, () => {}),
      rejectsWith("invalid_input"),
    );
    await assert.rejects(
      collectFiles(join(dir, "nope"), () => {}),
      rejectsWith("io_error"),
    );
  });

  it("walks a directory: nested paths, text as strings, binary and invalid UTF-8 as base64", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    write("site/index.html", "<p>é</p>");
    write("site/css/site.css", "body{}");
    write("site/data/x.json", "{}");
    write("site/img/logo.png", png);
    write("site/notes.txt", latin1);
    write("site/.env", "SECRET=1");
    write("site/.git/config", "[core]");
    write("site/img/.DS_Store", "x");
    symlinkSync(join(dir, "single", "page.html"), join(dir, "site", "link.html"));
    const warnings: string[] = [];
    const { files, skipped } = await collectFiles(join(dir, "site"), (w) => warnings.push(w));
    assert.deepEqual(skipped, []);
    assert.deepEqual(files, {
      "css/site.css": "body{}",
      "data/x.json": "{}",
      "img/logo.png": { base64: Buffer.from(png).toString("base64") },
      "index.html": "<p>é</p>",
      "notes.txt": { base64: Buffer.from(latin1).toString("base64") },
    });
    assert.deepEqual(warnings, ["artifact: skipping symlink link.html"]);
  });

  it("skips file types the server rejects and names them", async () => {
    write("odd/index.html", "x");
    write("odd/README", "read me");
    write("odd/src/app.ts", "let x = 1;");
    write("odd/run.sh", "echo");
    write("odd/style.CSS", "a{}");
    const warnings: string[] = [];
    const { files, skipped } = await collectFiles(join(dir, "odd"), (w) => warnings.push(w));
    assert.deepEqual(Object.keys(files), ["index.html", "style.CSS"]);
    assert.deepEqual(skipped, ["README", "run.sh", "src/app.ts"]);
    assert.deepEqual(warnings, [
      "skipped 3 file(s) with unsupported types: README, run.sh, src/app.ts",
    ]);
  });

  it("refuses a directory without index.html or with nothing left to send", async () => {
    write("noindex/page.html", "x");
    await assert.rejects(
      collectFiles(join(dir, "noindex"), () => {}),
      (error) => {
        rejectsWith("invalid_input")(error);
        assert.match((error as Error).message, /has no index\.html at its top level$/);
        return true;
      },
    );
    write("nothing/notes.ts", "x");
    write("nothing/.env", "x");
    const warnings: string[] = [];
    await assert.rejects(
      collectFiles(join(dir, "nothing"), (w) => warnings.push(w)),
      (error) => {
        rejectsWith("invalid_input")(error);
        assert.match((error as Error).message, /has no files to publish$/);
        return true;
      },
    );
    assert.deepEqual(warnings, ["skipped 1 file(s) with unsupported types: notes.ts"]);
  });
});
