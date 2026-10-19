// `artifact_publish` `file_path`: one local HTML file read from disk as the entry page
// (docs/decisions/0035). Lives in the MCP adapter layer; the core never touches the filesystem.
import { open } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { LIMITS } from "../core/artifact-service.ts";
import { fail, invalidInput, ok, type Result, tooLarge } from "../core/errors.ts";
import { ENTRY_PAGE } from "../core/paths.ts";

const HTML_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm"]);

const invalid = (message: string) => fail(invalidInput("file_path", message));

/**
 * The bytes of `path`, to be published as `index.html`; checked before anything is read, against
 * `maxFileBytes` (the service's `limits.maxFileBytes`, docs/decisions/0051).
 */
export async function readEntryFile(
  path: string,
  maxFileBytes: number = LIMITS.maxFileBytes,
): Promise<Result<Uint8Array>> {
  if (!isAbsolute(path)) {
    return invalid(
      `file_path must be an absolute path (the server does not share your working directory), got ${JSON.stringify(path)}`,
    );
  }
  if (!HTML_EXTENSIONS.has(extname(path).toLowerCase())) {
    return invalid(`file_path must name an .html or .htm file, got ${JSON.stringify(path)}`);
  }
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    return invalid(`cannot read file_path ${JSON.stringify(path)}: ${code}`);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return invalid(`file_path ${JSON.stringify(path)} is not a regular file`);
    if (stat.size > maxFileBytes) return fail(tooLarge("file", maxFileBytes, ENTRY_PAGE));
    // The core checks the size again on the bytes actually read (the file may have grown).
    return ok(new Uint8Array(await file.readFile()));
  } finally {
    await file.close();
  }
}
