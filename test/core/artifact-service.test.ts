import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createMemoryStore } from "../../src/adapters/memory-store.ts";
import { LIMITS, type Manifest } from "../../src/core/artifact-service.ts";
import { reloadScriptTag } from "../../src/core/inject.ts";
import type { BlobStore, PointerStore } from "../../src/core/ports.ts";
import { harness, recordingNotifier, text, unwrap } from "../support/fakes.ts";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("ArtifactService.publish", () => {
  it("creates an artifact at version 1 with src as published and www injected", async () => {
    const { service, store, notifier } = harness();
    const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const result = unwrap(
      await service.publish({
        title: "Demo",
        label: "first",
        files: { "index.html": page("hi"), "./css//site.css": "body{}", "img/logo.png": png },
      }),
    );
    assert.equal(result.version, 1);
    assert.match(result.id, /^[0-9a-hjkmnp-tv-z]{26}$/);
    const id = result.id;
    const v = `artifacts/${id}/v/1`;

    assert.equal(text((await store.get(`${v}/src/index.html`)) ?? new Uint8Array()), page("hi"));
    assert.equal(
      text((await store.get(`${v}/www/index.html`)) ?? new Uint8Array()),
      page(`hi${reloadScriptTag(1)}`),
    );
    assert.deepEqual(await store.get(`${v}/src/img/logo.png`), png);
    assert.deepEqual(await store.get(`${v}/www/img/logo.png`), png);
    assert.equal(text((await store.get(`${v}/www/css/site.css`)) ?? new Uint8Array()), "body{}");

    const manifest = JSON.parse(text((await store.get(`${v}/manifest.json`)) ?? new Uint8Array()));
    assert.deepEqual(manifest, {
      id,
      version: 1,
      label: "first",
      createdAt: "2026-10-17T12:00:00.000Z",
      files: [
        {
          path: "css/site.css",
          size: 6,
          sha256: createHash("sha256").update("body{}").digest("hex"),
          contentType: "text/css; charset=utf-8",
        },
        {
          path: "img/logo.png",
          size: 6,
          sha256: createHash("sha256").update(png).digest("hex"),
          contentType: "image/png",
        },
        {
          path: "index.html",
          size: page("hi").length,
          sha256: createHash("sha256").update(page("hi")).digest("hex"),
          contentType: "text/html; charset=utf-8",
        },
      ],
    } satisfies Manifest);

    assert.deepEqual(unwrap(await service.read(id)), {
      id,
      title: "Demo",
      currentVersion: 1,
      createdAt: "2026-10-17T12:00:00.000Z",
      updatedAt: "2026-10-17T12:00:00.000Z",
      versions: [{ version: 1, createdAt: "2026-10-17T12:00:00.000Z", label: "first" }],
    });
    assert.deepEqual(notifier.events, [{ type: "published", id, version: 1 }]);
  });

  it("republishing the same id adds version + 1 and keeps the title unless given", async () => {
    const { service, notifier, clock } = harness();
    const { id } = unwrap(await service.publish({ title: "T", files: { "index.html": "one" } }));
    clock.advance(1000);
    assert.deepEqual(unwrap(await service.publish({ id, files: { "index.html": "two" } })), {
      id,
      version: 2,
    });
    const details = unwrap(await service.read(id));
    assert.equal(details.currentVersion, 2);
    assert.equal(details.title, "T");
    assert.equal(details.updatedAt, "2026-10-17T12:00:01.000Z");
    assert.deepEqual(
      details.versions.map((v) => v.version),
      [1, 2],
    );
    unwrap(await service.publish({ id, title: "U", files: { "index.html": "three" } }));
    assert.equal(unwrap(await service.read(id)).title, "U");
    assert.equal(text(unwrap(await service.readFile(id)).body), "three");
    assert.equal(text(unwrap(await service.readFile(id, { version: 1 })).body), "one");
    assert.deepEqual(
      notifier.events.map((e) => e.version),
      [1, 2, 3],
    );
  });

  it("writes src/ then www/ then manifest.json, moves the pointer last, then notifies", async () => {
    const log: string[] = [];
    const store = createMemoryStore();
    const blobs: BlobStore = {
      ...store,
      put: (key, body, options) => {
        log.push(`put ${key.replace(/^artifacts\/[^/]+\//, "")}`);
        return store.put(key, body, options);
      },
    };
    const pointers: PointerStore = {
      ...store,
      write: (key, body, condition) => {
        log.push(`pointer ${"ifMatch" in condition ? "cas" : "create"}`);
        return store.write(key, body, condition);
      },
    };
    const notifier = recordingNotifier((e) => log.push(`notify ${e.version}`));
    const { service } = harness({ blobs, pointers, notifier });
    const files = { "index.html": "<body></body>", "a.css": "a", "b.js": "b" };
    const { id } = unwrap(await service.publish({ files }));
    log.length = 0;
    unwrap(await service.publish({ id, files }));
    const stage = (entry: string) =>
      entry.startsWith("put v/2/src/")
        ? 0
        : entry.startsWith("put v/2/www/")
          ? 1
          : entry === "put v/2/manifest.json"
            ? 2
            : entry === "pointer cas"
              ? 3
              : entry === "notify 2"
                ? 4
                : -1;
    const stages = log.map(stage);
    assert.ok(!stages.includes(-1), log.join("\n"));
    assert.deepEqual(
      stages,
      [...stages].sort((a, b) => a - b),
      log.join("\n"),
    );
    assert.deepEqual(
      log.filter((e) => /manifest|pointer|notify/.test(e)),
      ["put v/2/manifest.json", "pointer cas", "notify 2"],
    );
    assert.equal(log[0], "put v/2/src/index.html", "index.html claims the version first");
  });

  it("a crash before the pointer move leaves an orphan that is never current", async () => {
    const store = createMemoryStore();
    let crash = false;
    const pointers: PointerStore = {
      ...store,
      write: async (key, body, condition) => {
        if (crash) throw new Error("simulated crash");
        return store.write(key, body, condition);
      },
    };
    const { service, notifier } = harness({ blobs: store, pointers });
    const { id } = unwrap(await service.publish({ files: { "index.html": "v1" } }));

    crash = true;
    await assert.rejects(service.publish({ id, files: { "index.html": "orphan" } }), /crash/);
    assert.ok(await store.get(`artifacts/${id}/v/2/manifest.json`), "orphan was written");
    const details = unwrap(await service.read(id));
    assert.equal(details.currentVersion, 1);
    assert.deepEqual(
      details.versions.map((v) => v.version),
      [1],
    );
    assert.equal(text(unwrap(await service.readFile(id)).body), "v1");
    assert.equal(unwrap(await service.list())[0].currentVersion, 1);
    const orphan = await service.readFile(id, { version: 2 });
    assert.equal(!orphan.ok && orphan.error.code, "not_found");
    assert.deepEqual(
      notifier.events.map((e) => e.version),
      [1],
    );

    crash = false;
    assert.equal(unwrap(await service.publish({ id, files: { "index.html": "v3" } })).version, 3);
    assert.deepEqual(
      unwrap(await service.read(id)).versions.map((v) => v.version),
      [1, 3],
    );
  });

  it("a crash before the first pointer write leaves no listed artifact", async () => {
    const store = createMemoryStore();
    const pointers: PointerStore = {
      ...store,
      write: async () => {
        throw new Error("simulated crash");
      },
    };
    const { service } = harness({ blobs: store, pointers });
    await assert.rejects(service.publish({ files: { "index.html": "x" } }));
    assert.deepEqual(unwrap(await service.list()), []);
  });

  it("ifVersion: updates when current, version_conflict with the current version otherwise", async () => {
    const { service } = harness();
    const { id } = unwrap(await service.publish({ files: { "index.html": "1" } }));
    unwrap(await service.publish({ id, ifVersion: 1, files: { "index.html": "2" } }));
    const stale = await service.publish({ id, ifVersion: 1, files: { "index.html": "x" } });
    assert.deepEqual(stale, {
      ok: false,
      error: {
        code: "version_conflict",
        message: "version conflict: current version is 2",
        currentVersion: 2,
      },
    });
    assert.equal(unwrap(await service.read(id)).currentVersion, 2);
  });

  it("updating an unknown id is not_found", async () => {
    const { service } = harness();
    const result = await service.publish({
      id: "0000000000000000000000000z",
      files: { "index.html": "x" },
    });
    assert.equal(!result.ok && result.error.code, "not_found");
  });

  it("malformed ids are invalid_input pointing to artifact_list", async () => {
    const { service } = harness();
    const { id } = unwrap(await service.publish({ files: { "index.html": "x" } }));
    for (const bad of ["../../etc", "ABC", ""]) {
      for (const result of [
        await service.publish({ id: bad, files: { "index.html": "x" } }),
        await service.read(bad),
        await service.readFile(bad),
        await service.rollback(bad, 1),
        await service.delete(bad),
      ]) {
        assert.ok(!result.ok, bad);
        assert.equal(result.error.code, "invalid_input", bad);
        assert.equal("field" in result.error && result.error.field, "id", bad);
        assert.match(result.error.message, /artifact_list/);
      }
    }
    assert.equal(unwrap(await service.read(id)).id, id);
  });

  it("uppercase ids are lowercased before lookup", async () => {
    const { service } = harness();
    const { id } = unwrap(await service.publish({ files: { "index.html": "x" } }));
    const upper = id.toUpperCase();
    assert.equal(unwrap(await service.read(upper)).id, id);
    assert.equal(unwrap(await service.readFile(upper)).id, id);
    assert.deepEqual(unwrap(await service.publish({ id: upper, files: { "index.html": "y" } })), {
      id,
      version: 2,
    });
    assert.deepEqual(unwrap(await service.rollback(upper, 1)), { id, version: 1 });
    unwrap(await service.delete(upper));
    assert.equal((await service.read(id)).ok, false);
  });

  it("a failing notifier does not fail a committed publish", async () => {
    const notifier = recordingNotifier(() => {
      throw new Error("listener blew up");
    });
    const { service } = harness({ notifier });
    assert.equal(unwrap(await service.publish({ files: { "index.html": "x" } })).version, 1);
  });
});

describe("ArtifactService validation", () => {
  async function rejected(files: Record<string, string | Uint8Array>, label?: string) {
    const { service, store } = harness();
    const result = await service.publish({ files, label });
    assert.equal(result.ok, false);
    assert.deepEqual((await store.list("")).keys, [], "nothing written");
    return result.ok ? undefined : result.error;
  }

  it("requires index.html at the version root", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "sub/index.html": "x" },
      { "Index.htm": "x" },
      { "index.htm": "x" },
      { "a.css": "x" },
    ];
    for (const files of cases) {
      const error = await rejected(files);
      assert.equal(error?.code, "invalid_path");
    }
  });

  it("rejects unsafe, disallowed and duplicate paths as invalid_path", async () => {
    for (const bad of ["../x.html", "/abs.html", "a\\b.css", "a\0.css", "run.sh", "noext"]) {
      const error = await rejected({ "index.html": "x", [bad]: "y" });
      assert.deepEqual(
        error && { code: error.code, path: "path" in error && error.path },
        { code: "invalid_path", path: bad },
        bad,
      );
    }
    assert.equal(
      (await rejected({ "index.html": "x", "./index.html": "y" }))?.code,
      "invalid_path",
    );
    assert.equal(
      (await rejected({ "index.html": "x", "A.css": "1", "a.css": "2" }))?.code,
      "invalid_path",
    );
  });

  it("rejects reserved path prefixes without writing anything", async () => {
    const error = await rejected({ "index.html": "x", "v/1/index.html": "y" });
    assert.deepEqual(error && error.code === "invalid_path" && error.path, "v/1/index.html");
  });

  it("caps files per publish at 255", async () => {
    const files: Record<string, string> = { "index.html": "x" };
    for (let i = 0; i < 254; i++) files[`f${i}.txt`] = "";
    const { service } = harness();
    assert.equal(unwrap(await service.publish({ files })).version, 1);
    files.extra = "";
    files["f254.txt"] = "";
    assert.deepEqual(await rejected(files), {
      code: "invalid_input",
      message: "too many files: at most 255 per publish",
      field: "files",
      limit: 255,
    });
  });

  it("caps a file at 16 MiB and a publish at 64 MiB", async () => {
    const mib = 1024 * 1024;
    assert.equal(LIMITS.maxFileBytes, 16 * mib);
    assert.equal(LIMITS.maxPublishBytes, 64 * mib);
    const { service } = harness();
    unwrap(
      await service.publish({ files: { "index.html": "x", "big.mp4": new Uint8Array(16 * mib) } }),
    );
    assert.deepEqual(
      await rejected({ "index.html": "x", "big.mp4": new Uint8Array(16 * mib + 1) }),
      {
        code: "too_large",
        message: `file "big.mp4" exceeds the limit of ${16 * mib} bytes`,
        subject: "file",
        limit: 16 * mib,
        path: "big.mp4",
      },
    );
    const chunk = new Uint8Array(13 * mib);
    const error = await rejected({
      "index.html": "x",
      "1.mp4": chunk,
      "2.mp4": chunk,
      "3.mp4": chunk,
      "4.mp4": chunk,
      "5.mp4": chunk,
    });
    assert.deepEqual(error && error.code === "too_large" && [error.subject, error.limit], [
      "publish",
      64 * mib,
    ]);
  });

  it("caps the label at 60 characters", async () => {
    const { service } = harness();
    unwrap(await service.publish({ label: "x".repeat(60), files: { "index.html": "x" } }));
    unwrap(await service.publish({ label: "👋".repeat(60), files: { "index.html": "x" } }));
    assert.deepEqual(await rejected({ "index.html": "x" }, "x".repeat(61)), {
      code: "invalid_input",
      message: "label exceeds 60 characters",
      field: "label",
      limit: 60,
    });
  });
});

describe("ArtifactService htm and jpeg files", () => {
  it("injects the reload tag into .htm pages and copies .jpeg as-is", async () => {
    const { service, store } = harness();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    const { id } = unwrap(
      await service.publish({
        files: { "index.html": "<body></body>", "page.htm": "<body>p</body>", "a.jpeg": jpeg },
      }),
    );
    const v = `artifacts/${id}/v/1`;
    assert.equal(
      text((await store.get(`${v}/www/page.htm`)) ?? new Uint8Array()),
      `<body>p${reloadScriptTag(1)}</body>`,
    );
    assert.equal(
      text((await store.get(`${v}/src/page.htm`)) ?? new Uint8Array()),
      "<body>p</body>",
    );
    assert.deepEqual(await store.get(`${v}/www/a.jpeg`), jpeg);
    assert.equal(unwrap(await service.readFile(id, { path: "a.jpeg" })).contentType, "image/jpeg");
  });
});

describe("ArtifactService.readFile", () => {
  it("returns src bytes exactly as published, by version, defaulting to index.html", async () => {
    const { service } = harness();
    const html = `<body>${reloadScriptTag(9)}</body>`;
    const { id } = unwrap(
      await service.publish({ files: { "index.html": html, "data/x.json": "{}" } }),
    );
    assert.deepEqual(unwrap(await service.readFile(id)), {
      id,
      version: 1,
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      body: new TextEncoder().encode(html),
    });
    assert.equal(text(unwrap(await service.readFile(id, { path: "./data/x.json" })).body), "{}");
    const missing = await service.readFile(id, { path: "nope.css" });
    assert.equal(!missing.ok && missing.error.code, "not_found");
    const bad = await service.readFile(id, { path: "../x" });
    assert.equal(!bad.ok && bad.error.code, "invalid_path");
    const noVersion = await service.readFile(id, { version: 5 });
    assert.equal(!noVersion.ok && noVersion.error.code, "not_found");
  });
});

describe("ArtifactService.rollback", () => {
  it("moves only the pointer, emits a published event, and later publishes still increase", async () => {
    const { service, store, notifier } = harness();
    const { id } = unwrap(await service.publish({ files: { "index.html": "one" } }));
    unwrap(await service.publish({ id, files: { "index.html": "two" } }));
    const keysBefore = (await store.list(`artifacts/${id}/v/`)).keys;

    assert.deepEqual(unwrap(await service.rollback(id, 1)), { id, version: 1 });
    assert.deepEqual((await store.list(`artifacts/${id}/v/`)).keys, keysBefore);
    assert.equal(unwrap(await service.read(id)).currentVersion, 1);
    assert.equal(text(unwrap(await service.readFile(id)).body), "one");
    assert.deepEqual(notifier.events.at(-1), { type: "published", id, version: 1 });

    assert.equal(
      unwrap(await service.publish({ id, files: { "index.html": "three" } })).version,
      3,
    );
    assert.deepEqual(
      unwrap(await service.read(id)).versions.map((v) => v.version),
      [1, 2, 3],
    );
  });

  it("rolling back to an unknown version or artifact is not_found", async () => {
    const { service } = harness();
    const { id } = unwrap(await service.publish({ files: { "index.html": "one" } }));
    for (const result of [
      await service.rollback(id, 2),
      await service.rollback("0000000000000000000000000z", 1),
    ]) {
      assert.equal(!result.ok && result.error.code, "not_found");
    }
  });
});

describe("ArtifactService.delete and list", () => {
  it("delete removes the pointer and every version", async () => {
    const { service, store } = harness();
    const { id } = unwrap(await service.publish({ files: { "index.html": "one" } }));
    unwrap(await service.publish({ id, files: { "index.html": "two", "a.css": "" } }));
    const other = unwrap(await service.publish({ files: { "index.html": "other" } }));

    assert.deepEqual(await service.delete(id), { ok: true, value: undefined });
    assert.deepEqual((await store.list(`artifacts/${id}/`)).keys, []);
    assert.equal((await service.read(id)).ok, false);
    assert.deepEqual(
      unwrap(await service.list()).map((a) => a.id),
      [other.id],
    );
    const again = await service.delete(id);
    assert.equal(!again.ok && again.error.code, "not_found");
    const update = await service.publish({ id, files: { "index.html": "x" } });
    assert.equal(!update.ok && update.error.code, "not_found");
  });

  it("lists most recently updated first, with a limit", async () => {
    const { service, clock } = harness();
    const a = unwrap(await service.publish({ title: "a", files: { "index.html": "a" } }));
    clock.advance(1000);
    const b = unwrap(await service.publish({ title: "b", files: { "index.html": "b" } }));
    clock.advance(1000);
    unwrap(await service.publish({ id: a.id, files: { "index.html": "a2" } }));

    const all = unwrap(await service.list());
    assert.deepEqual(
      all.map((s) => [s.title, s.currentVersion]),
      [
        ["a", 2],
        ["b", 1],
      ],
    );
    assert.deepEqual(
      unwrap(await service.list({ limit: 1 })).map((s) => s.id),
      [a.id],
    );
    assert.equal(unwrap(await service.list({ limit: 500 })).length, 2);
    assert.notEqual(a.id, b.id);
  });

  it("rejects a limit outside 1..500 as invalid_input", async () => {
    const { service } = harness();
    for (const limit of [0, -1, 501, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(
        await service.list({ limit }),
        {
          ok: false,
          error: {
            code: "invalid_input",
            message: "limit must be an integer from 1 to 500",
            field: "limit",
            limit: 500,
          },
        },
        String(limit),
      );
    }
  });
});
