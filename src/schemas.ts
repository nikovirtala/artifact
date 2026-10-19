// Request schemas shared by the JSON API (http/) and the MCP tools (mcp/); see
// docs/decisions/0021. Not part of core/: the core takes plain values and validates its own rules.
import { z } from "zod";
import { LIMITS, type Limits } from "./core/artifact-service.ts";

/** `limit` when a list request does not give one (API and MCP). */
export const DEFAULT_LIST_LIMIT = 50;

/** The list default under `limits`: `DEFAULT_LIST_LIMIT`, capped at `limits.maxListLimit`. */
export function defaultListLimit(limits: Limits): number {
  return Math.min(DEFAULT_LIST_LIMIT, limits.maxListLimit);
}

/**
 * Request body cap for `limits`: the publish limit as base64 (×4/3) plus JSON overhead, i.e.
 * 1.5 × `maxPublishBytes` (docs/decisions/0051). Larger bodies are cut off unread.
 */
export function bodyCapFor(limits: Limits): number {
  return Math.ceil((limits.maxPublishBytes * 3) / 2);
}

/** The body cap for the default `LIMITS`: 96 MiB. */
export const MAX_BODY_BYTES = bodyCapFor(LIMITS);

/** A file's contents: a string is UTF-8 text, `{ base64 }` is binary. */
export const FileValueSchema = z.union([z.string(), z.strictObject({ base64: z.base64() })]);

/** Relative path → contents. Path rules are checked by the core. */
export const FilesSchema = z.record(z.string(), FileValueSchema);

export const PublishBodySchema = z.strictObject({
  title: z.string().optional(),
  label: z.string().optional(),
  /** Codebase identifier, normalised by the core (docs/decisions/0039). Kept from the create. */
  project: z.string().optional(),
  files: FilesSchema,
  /** Update only if this is still the current version. Ignored on create. */
  if_version: z.number().int().positive().optional(),
  /** `false`: do not open this new artifact in the browser (docs/decisions/0040). API only. */
  open: z.boolean().optional(),
});

export const RollbackBodySchema = z.strictObject({
  version: z.number().int().positive(),
});

// MCP tool inputs: the API bodies plus what the URL carries in the API (`id`). Field descriptions
// are part of the agent contract (docs/decisions/0036). The core normalises and validates `id`.
const IdSchema = z
  .string()
  .describe("Artifact id: the 26-character ULID returned by artifact_publish or artifact_list.");
const VersionSchema = z.number().int().positive();
// How the agent derives `project` (owner wording, docs/decisions/0039).
const PROJECT_DESCRIPTION =
  "Identifies the codebase you are working in, so artifact_list returns only its artifacts. " +
  "Derive it exactly; do not invent or shorten it. " +
  "1. Run `git remote get-url origin`; if it succeeds, pass that URL as-is (the server normalises it). " +
  "2. Otherwise, if `git rev-parse --show-toplevel` succeeds, pass `local:` + that path. " +
  "3. Otherwise pass `local:` + the absolute current working directory. " +
  "If your instructions (e.g. CLAUDE.md) state a project value, use that instead. " +
  "Use the same value for every call in the session.";
const ProjectSchema = z.string().optional().describe(PROJECT_DESCRIPTION);

export const ReadToolInputSchema = z.strictObject({
  id: IdSchema,
  version: VersionSchema.optional().describe("Version to read; default the current version."),
  path: z.string().optional().describe('File to read; default "index.html".'),
});

export const RollbackToolInputSchema = RollbackBodySchema.extend({
  id: IdSchema,
  version: RollbackBodySchema.shape.version.describe("Committed version to make current."),
});

export const DeleteToolInputSchema = z.strictObject({
  id: IdSchema,
  confirm: z.literal(true).describe("Must be true: deletes the artifact and every version."),
});

/**
 * The MCP tool input schemas for `limits` (docs/decisions/0051): the label description and the
 * list `maximum` print the configured numbers.
 */
export function toolInputSchemas(limits: Limits) {
  const PublishToolInputSchema = PublishBodySchema.omit({ open: true })
    .extend({
      id: IdSchema.optional().describe(
        "Omit to create a new artifact. Pass an existing id to add a version to it; the URL stays the same.",
      ),
      title: PublishBodySchema.shape.title.describe(
        "Title shown in the gallery and artifact_list.",
      ),
      label: PublishBodySchema.shape.label.describe(
        `Short name for this version, at most ${limits.maxLabelChars} characters.`,
      ),
      project: ProjectSchema.describe(
        `${PROJECT_DESCRIPTION} It is stored when the artifact is created and never changes.`,
      ),
      file_path: z
        .string()
        .optional()
        .describe(
          "Absolute path of a local .html file, published as index.html. Supporting files are not read from disk: pass them in files. Local server only.",
        ),
      files: FilesSchema.optional().describe(
        'Relative path → contents. "index.html" is required unless file_path is given. A string is UTF-8 text; {"base64": "…"} is binary.',
      ),
      if_version: PublishBodySchema.shape.if_version.describe(
        "Update only if this is still the current version, else version_conflict. Ignored when creating.",
      ),
    })
    .refine((input) => input.files !== undefined || input.file_path !== undefined, {
      message: "pass files, file_path, or both",
      path: ["files"],
    });

  const ListToolInputSchema = z.strictObject({
    limit: z
      .number()
      .int()
      .min(1)
      .max(limits.maxListLimit)
      .optional()
      .describe(
        `Most artifacts to return, most recently updated first (default ${defaultListLimit(limits)}).`,
      ),
    project: ProjectSchema,
    all: z
      .boolean()
      .optional()
      .describe(
        "List the artifacts of every project (project is then ignored). Only when the user asks about artifacts from other projects.",
      ),
  });

  return {
    PublishToolInputSchema,
    ListToolInputSchema,
    ReadToolInputSchema,
    RollbackToolInputSchema,
    DeleteToolInputSchema,
  };
}

const defaultToolInputSchemas = toolInputSchemas(LIMITS);
export const PublishToolInputSchema = defaultToolInputSchemas.PublishToolInputSchema;
export const ListToolInputSchema = defaultToolInputSchemas.ListToolInputSchema;

export type FileValue = z.infer<typeof FileValueSchema>;
export type Files = z.infer<typeof FilesSchema>;
export type PublishBody = z.infer<typeof PublishBodySchema>;
export type RollbackBody = z.infer<typeof RollbackBodySchema>;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const TEXT_TYPES = /^(text\/|application\/json|image\/svg\+xml)/;

/**
 * Text files as a string, everything else (or invalid UTF-8) as `{base64}`: the encoding of
 * `artifact_read` results and of `artifact publish` bodies (docs/decisions/0043).
 */
export function encodeFileValue(contentType: string, body: Uint8Array): FileValue {
  if (TEXT_TYPES.test(contentType)) {
    try {
      return utf8.decode(body);
    } catch {
      // Not UTF-8 after all: fall through to base64.
    }
  }
  return { base64: Buffer.from(body).toString("base64") };
}

/** Validated `files` → the core's `path → string | bytes` map. */
export function decodeFiles(files: Files): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = {};
  for (const [path, value] of Object.entries(files)) {
    out[path] =
      typeof value === "string" ? value : new Uint8Array(Buffer.from(value.base64, "base64"));
  }
  return out;
}
