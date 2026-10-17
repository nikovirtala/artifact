// Request body schemas shared by the JSON API (http/) and the MCP tools (mcp/, M4); see
// docs/decisions/0021. Not part of core/: the core takes plain values and validates its own rules.
import { z } from "zod";

/** A file's contents: a string is UTF-8 text, `{ base64 }` is binary. */
export const FileValueSchema = z.union([z.string(), z.strictObject({ base64: z.base64() })]);

/** Relative path → contents. Path rules are checked by the core. */
export const FilesSchema = z.record(z.string(), FileValueSchema);

export const PublishBodySchema = z.strictObject({
  title: z.string().optional(),
  label: z.string().optional(),
  files: FilesSchema,
  /** Update only if this is still the current version. Ignored on create. */
  if_version: z.number().int().positive().optional(),
});

export const RollbackBodySchema = z.strictObject({
  version: z.number().int().positive(),
});

export type FileValue = z.infer<typeof FileValueSchema>;
export type Files = z.infer<typeof FilesSchema>;
export type PublishBody = z.infer<typeof PublishBodySchema>;
export type RollbackBody = z.infer<typeof RollbackBodySchema>;

/** Validated `files` → the core's `path → string | bytes` map. */
export function decodeFiles(files: Files): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = {};
  for (const [path, value] of Object.entries(files)) {
    out[path] =
      typeof value === "string" ? value : new Uint8Array(Buffer.from(value.base64, "base64"));
  }
  return out;
}
