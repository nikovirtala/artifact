// The one core service behind HTTP, MCP and the CLI. It talks to storage and notifications only
// through ports. Publish protocol (see docs/decisions/0015):
//   1. read the pointer and pick n = (newest committed version) + 1;
//   2. claim n with a create-only put of src/index.html (losers move on to n + 1);
//   3. write the remaining src/ files, then www/ (html injected), then manifest.json create-only;
//   4. compare-and-swap the pointer on its etag (the commit), then notify.
// A crash before step 4 leaves an orphaned version that is never current or listed.

import {
  type ArtifactError,
  fail,
  invalidInput,
  invalidPath,
  notFound,
  ok,
  type Result,
  tooLarge,
  versionConflict,
} from "./errors.ts";
import { injectReloadScriptBytes } from "./inject.ts";
import {
  ARTIFACTS_PREFIX,
  artifactPrefix,
  contentTypeFor,
  ENTRY_PAGE,
  isArtifactId,
  isHtml,
  MAX_FILES_PER_PUBLISH,
  manifestKey,
  metaKey,
  normalizeId,
  normalizePath,
  srcKey,
  validateFilePath,
  wwwKey,
} from "./paths.ts";
import type {
  ArtifactEvent,
  BlobStore,
  Clock,
  IdGen,
  Notifier,
  PointerObject,
  PointerStore,
} from "./ports.ts";

export const LIMITS = {
  maxFiles: MAX_FILES_PER_PUBLISH,
  maxFileBytes: 16 * 1024 * 1024,
  maxPublishBytes: 64 * 1024 * 1024,
  maxLabelChars: 60,
  maxListLimit: 500,
} as const;

const DEFAULT_MAX_ATTEMPTS = 20;
const WRITE_CONCURRENCY = 16;

/** File contents: bytes as-is, or a string stored as UTF-8. */
export type FileBody = Uint8Array | string;

export type PublishInput = {
  /** Omit to create a new artifact; pass to add a version to an existing one. */
  id?: string;
  title?: string;
  label?: string;
  /** Update only if this is still the current version, else `version_conflict`. Ignored on create. */
  ifVersion?: number;
  /** Relative path → contents. `index.html` at the root is required. */
  files: Readonly<Record<string, FileBody>>;
};

export type Published = { id: string; version: number };

export type VersionInfo = { version: number; createdAt: string; label?: string };

/** `meta.json`: the pointer. `versions` lists committed versions, oldest first. */
export type ArtifactMeta = {
  id: string;
  title?: string;
  currentVersion: number;
  versions: VersionInfo[];
  createdAt: string;
  updatedAt: string;
};

export type ManifestFile = { path: string; size: number; sha256: string; contentType: string };

export type Manifest = {
  id: string;
  version: number;
  label?: string;
  createdAt: string;
  files: ManifestFile[];
};

export type ArtifactSummary = {
  id: string;
  title?: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactDetails = ArtifactSummary & { versions: VersionInfo[] };

export type FileContent = {
  id: string;
  version: number;
  path: string;
  contentType: string;
  body: Uint8Array;
};

export type ArtifactServiceDeps = {
  blobs: BlobStore;
  pointers: PointerStore;
  notifier: Notifier;
  clock: Clock;
  ids: IdGen;
  /** Storage round trips (version claims + pointer writes) before giving up with a conflict. */
  maxAttempts?: number;
};

type PreparedFile = ManifestFile & { body: Uint8Array };
type Prepared = { files: PreparedFile[]; label?: string };
type Pointer = { meta: ArtifactMeta; etag: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toJson(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function forEachLimited<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < items.length; i += WRITE_CONCURRENCY) {
    await Promise.all(items.slice(i, i + WRITE_CONCURRENCY).map(fn));
  }
}

function latestVersion(meta: ArtifactMeta): number {
  return meta.versions.at(-1)?.version ?? 0;
}

function summary(meta: ArtifactMeta): ArtifactSummary {
  const s: ArtifactSummary = {
    id: meta.id,
    currentVersion: meta.currentVersion,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
  if (meta.title !== undefined) s.title = meta.title;
  return s;
}

function artifactNotFound(id: string) {
  return fail(notFound(`artifact ${JSON.stringify(id)} not found`));
}

export class ArtifactService {
  readonly #blobs: BlobStore;
  readonly #pointers: PointerStore;
  readonly #notifier: Notifier;
  readonly #clock: Clock;
  readonly #ids: IdGen;
  readonly #maxAttempts: number;

  constructor(deps: ArtifactServiceDeps) {
    this.#blobs = deps.blobs;
    this.#pointers = deps.pointers;
    this.#notifier = deps.notifier;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async publish(input: PublishInput): Promise<Result<Published>> {
    const prepared = await prepare(input);
    if (!prepared.ok) return prepared;
    const now = this.#clock.now().toISOString();
    if (input.id === undefined) return this.#create(input.title, prepared.value, now);
    const id = normalizeId(input.id);
    if (!id.ok) return id;
    return this.#update(id.value, input.title, input.ifVersion, prepared.value, now);
  }

  /** Artifacts, most recently updated first; `limit` is an integer 1..500 (default: all). */
  async list(options: { limit?: number } = {}): Promise<Result<ArtifactSummary[]>> {
    const { limit } = options;
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxListLimit)
    ) {
      return fail(
        invalidInput(
          "limit",
          `limit must be an integer from 1 to ${LIMITS.maxListLimit}`,
          LIMITS.maxListLimit,
        ),
      );
    }
    const { commonPrefixes } = await this.#blobs.list(ARTIFACTS_PREFIX, { delimiter: "/" });
    const ids = commonPrefixes
      .map((p) => p.slice(ARTIFACTS_PREFIX.length, -1))
      .filter((id) => isArtifactId(id));
    const pointers = await Promise.all(ids.map((id) => this.#readPointer(id)));
    const metas = pointers.flatMap((p) => (p ? [p.meta] : []));
    const key = (m: ArtifactMeta) => `${m.updatedAt} ${m.id}`;
    metas.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
    return ok(metas.slice(0, limit ?? metas.length).map(summary));
  }

  /** Meta plus the committed versions, oldest first. */
  async read(rawId: string): Promise<Result<ArtifactDetails>> {
    const normalized = normalizeId(rawId);
    if (!normalized.ok) return normalized;
    const id = normalized.value;
    const pointer = await this.#readPointer(id);
    if (!pointer) return artifactNotFound(id);
    return ok({ ...summary(pointer.meta), versions: pointer.meta.versions });
  }

  /** One file exactly as published (from `src/`); defaults to `index.html` of the current version. */
  async readFile(
    rawId: string,
    options: { path?: string; version?: number } = {},
  ): Promise<Result<FileContent>> {
    const normalized = normalizeId(rawId);
    if (!normalized.ok) return normalized;
    const id = normalized.value;
    const pointer = await this.#readPointer(id);
    if (!pointer) return artifactNotFound(id);
    const version = options.version ?? pointer.meta.currentVersion;
    if (!pointer.meta.versions.some((v) => v.version === version)) {
      return fail(notFound(`version ${version} of artifact ${id} not found`));
    }
    const path = normalizePath(options.path ?? ENTRY_PAGE);
    if (!path.ok) return path;
    const manifest = await this.#blobs.get(manifestKey(id, version));
    const file =
      manifest &&
      (JSON.parse(decoder.decode(manifest)) as Manifest).files.find((f) => f.path === path.value);
    const body = file && (await this.#blobs.get(srcKey(id, version, path.value)));
    if (!file || !body) return fail(notFound(`file ${JSON.stringify(path.value)} not found`));
    return ok({ id, version, path: file.path, contentType: file.contentType, body });
  }

  /**
   * One file of the served tree (`www/`, html injected) for the viewing routes; defaults to the
   * current version. A static read: pointer, then the blob. No manifest lookup.
   */
  async readServed(
    rawId: string,
    options: { path: string; version?: number },
  ): Promise<Result<FileContent>> {
    const normalized = normalizeId(rawId);
    if (!normalized.ok) return normalized;
    const id = normalized.value;
    const pointer = await this.#readPointer(id);
    if (!pointer) return artifactNotFound(id);
    const version = options.version ?? pointer.meta.currentVersion;
    if (!pointer.meta.versions.some((v) => v.version === version)) {
      return fail(notFound(`version ${version} of artifact ${id} not found`));
    }
    const path = normalizePath(options.path);
    if (!path.ok) return path;
    const contentType = contentTypeFor(path.value);
    const body = contentType && (await this.#blobs.get(wwwKey(id, version, path.value)));
    if (!contentType || !body)
      return fail(notFound(`file ${JSON.stringify(path.value)} not found`));
    return ok({ id, version, path: path.value, contentType, body });
  }

  /** Move the pointer to an earlier (or any committed) version; emits a `published` event. */
  async rollback(rawId: string, version: number): Promise<Result<Published>> {
    const normalized = normalizeId(rawId);
    if (!normalized.ok) return normalized;
    const id = normalized.value;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const pointer = await this.#readPointer(id);
      if (!pointer) return artifactNotFound(id);
      if (!pointer.meta.versions.some((v) => v.version === version)) {
        return fail(notFound(`version ${version} of artifact ${id} not found`));
      }
      const meta = {
        ...pointer.meta,
        currentVersion: version,
        updatedAt: this.#clock.now().toISOString(),
      };
      if (await this.#swap(id, pointer, meta)) return this.#published(id, version);
    }
    return this.#conflict(id);
  }

  /** Remove the pointer (then emit `deleted`), then every object of every version. */
  async delete(rawId: string): Promise<Result<void>> {
    const normalized = normalizeId(rawId);
    if (!normalized.ok) return normalized;
    const id = normalized.value;
    if (!(await this.#readPointer(id))) return artifactNotFound(id);
    await this.#pointers.delete(metaKey(id));
    // Gone for viewers once the pointer is; open tabs learn it before the blob cleanup.
    await this.#notify({ type: "deleted", id });
    const { keys } = await this.#blobs.list(artifactPrefix(id));
    await forEachLimited(keys, (key) => this.#blobs.delete(key));
    return ok(undefined);
  }

  async #create(
    title: string | undefined,
    prepared: Prepared,
    now: string,
  ): Promise<Result<Published>> {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const id = this.#ids.next();
      if (!isArtifactId(id)) throw new Error(`IdGen returned an invalid id ${JSON.stringify(id)}`);
      if (!(await this.#writeVersion(id, 1, prepared, now))) continue;
      const meta: ArtifactMeta = {
        id,
        ...(title === undefined ? {} : { title }),
        currentVersion: 1,
        versions: [versionInfo(1, prepared, now)],
        createdAt: now,
        updatedAt: now,
      };
      const created = await this.#pointers.write(metaKey(id), toJson(meta), { ifNoneMatch: "*" });
      if (created.ok) return this.#published(id, 1);
    }
    throw new Error("could not allocate an unused artifact id");
  }

  async #update(
    id: string,
    title: string | undefined,
    ifVersion: number | undefined,
    prepared: Prepared,
    now: string,
  ): Promise<Result<Published>> {
    let pointer = await this.#readPointer(id);
    let claimed: number | undefined; // version whose files this call has written
    let floor = 1; // lowest number not known to be claimed by someone else
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      if (!pointer) return artifactNotFound(id);
      if (ifVersion !== undefined && pointer.meta.currentVersion !== ifVersion) {
        return fail(versionConflict(pointer.meta.currentVersion));
      }
      const latest = latestVersion(pointer.meta);
      // A newer version was committed past our claim: claim again above it.
      if (claimed !== undefined && claimed <= latest) claimed = undefined;
      if (claimed === undefined) {
        const version = Math.max(latest + 1, floor);
        if (!(await this.#writeVersion(id, version, prepared, now))) {
          // Claimed by a concurrent (or crashed) publish: the next number is ours to try.
          floor = version + 1;
          pointer = await this.#readPointer(id);
          continue;
        }
        claimed = version;
      }
      const meta: ArtifactMeta = {
        ...pointer.meta,
        ...(title === undefined ? {} : { title }),
        currentVersion: claimed,
        versions: [...pointer.meta.versions, versionInfo(claimed, prepared, now)],
        updatedAt: now,
      };
      if (await this.#swap(id, pointer, meta)) return this.#published(id, claimed);
      // The pointer moved (another publish, a rollback or a delete): re-read and retry.
      pointer = await this.#readPointer(id);
    }
    return this.#conflict(id);
  }

  /** Claim `version` and write its files; `false` if another publish already claimed it. */
  async #writeVersion(
    id: string,
    version: number,
    prepared: Prepared,
    now: string,
  ): Promise<boolean> {
    const [entry, ...rest] = prepared.files;
    const claim = await this.#blobs.put(srcKey(id, version, entry.path), entry.body, {
      ifNoneMatch: "*",
    });
    if (!claim.ok) return false;
    await forEachLimited(rest, (f) => this.#blobs.put(srcKey(id, version, f.path), f.body));
    await forEachLimited(prepared.files, (f) =>
      this.#blobs.put(
        wwwKey(id, version, f.path),
        isHtml(f.path) ? injectReloadScriptBytes(f.body, version) : f.body,
      ),
    );
    const manifest: Manifest = {
      id,
      version,
      ...(prepared.label === undefined ? {} : { label: prepared.label }),
      createdAt: now,
      files: prepared.files
        .map(({ path, size, sha256, contentType }) => ({ path, size, sha256, contentType }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    const written = await this.#blobs.put(manifestKey(id, version), toJson(manifest), {
      ifNoneMatch: "*",
    });
    return written.ok;
  }

  async #readPointer(id: string): Promise<Pointer | undefined> {
    if (!isArtifactId(id)) return undefined;
    const object: PointerObject | undefined = await this.#pointers.read(metaKey(id));
    if (!object) return undefined;
    return { meta: JSON.parse(decoder.decode(object.body)) as ArtifactMeta, etag: object.etag };
  }

  async #swap(id: string, pointer: Pointer, meta: ArtifactMeta): Promise<boolean> {
    const result = await this.#pointers.write(metaKey(id), toJson(meta), { ifMatch: pointer.etag });
    return result.ok;
  }

  async #published(id: string, version: number): Promise<Result<Published>> {
    await this.#notify({ type: "published", id, version });
    return ok({ id, version });
  }

  async #notify(event: ArtifactEvent): Promise<void> {
    try {
      await this.#notifier.notify(event);
    } catch {
      // The pointer already moved (or is gone), so the change stands; a missed event is
      // recoverable (clients reconnect and are sent the current state).
    }
  }

  async #conflict(id: string): Promise<Result<never, ArtifactError>> {
    const pointer = await this.#readPointer(id);
    if (!pointer) return artifactNotFound(id);
    const current = pointer.meta.currentVersion;
    return fail(
      versionConflict(
        current,
        `version conflict: gave up after ${this.#maxAttempts} attempts due to concurrent publishes (current version is ${current}); retry the same request without if_version`,
      ),
    );
  }
}

function versionInfo(version: number, prepared: Prepared, createdAt: string): VersionInfo {
  return prepared.label === undefined
    ? { version, createdAt }
    : { version, createdAt, label: prepared.label };
}

/** Validate limits and paths before anything is written. `index.html` comes first. */
async function prepare(input: PublishInput): Promise<Result<Prepared>> {
  const entries = Object.entries(input.files);
  if (entries.length > LIMITS.maxFiles) {
    return fail(
      invalidInput(
        "files",
        `too many files: at most ${LIMITS.maxFiles} per publish`,
        LIMITS.maxFiles,
      ),
    );
  }
  if (input.label !== undefined && [...input.label].length > LIMITS.maxLabelChars) {
    return fail(
      invalidInput(
        "label",
        `label exceeds ${LIMITS.maxLabelChars} characters`,
        LIMITS.maxLabelChars,
      ),
    );
  }
  const files: Omit<PreparedFile, "sha256">[] = [];
  // Case-insensitive, because the default disk (macOS APFS) would merge such paths.
  const seen = new Set<string>();
  let total = 0;
  for (const [rawPath, raw] of entries) {
    const valid = validateFilePath(rawPath);
    if (!valid.ok) return valid;
    const { path, contentType } = valid.value;
    if (seen.has(path.toLowerCase())) return fail(invalidPath(rawPath, "duplicate path"));
    seen.add(path.toLowerCase());
    const body = typeof raw === "string" ? encoder.encode(raw) : raw;
    if (body.length > LIMITS.maxFileBytes) return fail(tooLarge("file", LIMITS.maxFileBytes, path));
    total += body.length;
    if (total > LIMITS.maxPublishBytes) return fail(tooLarge("publish", LIMITS.maxPublishBytes));
    files.push({ path, contentType, size: body.length, body });
  }
  const entry = files.findIndex((f) => f.path === ENTRY_PAGE);
  if (entry < 0) return fail(invalidPath(ENTRY_PAGE, "index.html is required at the version root"));
  files.unshift(...files.splice(entry, 1));
  const hashed = await Promise.all(
    files.map(async (f) => ({ ...f, sha256: await sha256Hex(f.body) })),
  );
  const prepared: Prepared = { files: hashed };
  if (input.label !== undefined) prepared.label = input.label;
  return ok(prepared);
}
