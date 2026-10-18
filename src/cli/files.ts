// Local files → the publish body's `files` (docs/decisions/0043). A file is the entry page; a
// directory sends every regular file below it. Dot-names and symlinks are skipped, so nothing
// outside the directory is read, and so are files whose type the server would reject (the
// allowlist of `src/core/paths.ts`). Path rules and limits are left to the server.
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { contentTypeFor, ENTRY_PAGE } from "../core/paths.ts";
import { encodeFileValue, type FileValue } from "../schemas.ts";
import { CliError } from "./output.ts";

const HTML_FILE = /\.html?$/i;

export type Collected = {
  files: Record<string, FileValue>;
  /** Relative paths left out because their extension is not on the allowlist. */
  skipped: string[];
};

function ioError(path: string, error: unknown): CliError {
  const { code, message } = error as NodeJS.ErrnoException;
  return new CliError("io_error", `cannot read ${path}: ${code ?? message}`);
}

export async function collectFiles(
  path: string,
  warn: (message: string) => void,
): Promise<Collected> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    throw ioError(path, error);
  }
  if (info.isFile()) {
    if (!HTML_FILE.test(basename(path))) {
      throw new CliError(
        "invalid_input",
        `${path} is not an .html or .htm file; publish a directory to include other files`,
      );
    }
    const type = contentTypeFor(ENTRY_PAGE) as string;
    return { files: { [ENTRY_PAGE]: encodeFileValue(type, await read(path)) }, skipped: [] };
  }
  if (!info.isDirectory()) {
    throw new CliError("invalid_input", `${path} is neither a file nor a directory`);
  }
  const collected: Collected = { files: {}, skipped: [] };
  await walk(path, "", collected, warn);
  const { files, skipped } = collected;
  if (skipped.length > 0) {
    warn(`skipped ${skipped.length} file(s) with unsupported types: ${skipped.join(", ")}`);
  }
  if (Object.keys(files).length === 0) {
    throw new CliError("invalid_input", `${path} has no files to publish`);
  }
  if (!Object.hasOwn(files, ENTRY_PAGE)) {
    throw new CliError("invalid_input", `${path} has no ${ENTRY_PAGE} at its top level`);
  }
  return collected;
}

async function read(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw ioError(path, error);
  }
}

async function walk(
  dir: string,
  prefix: string,
  collected: Collected,
  warn: (message: string) => void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw ioError(dir, error);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = `${prefix}${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      warn(`artifact: skipping symlink ${relative}`);
    } else if (entry.isDirectory()) {
      await walk(full, `${relative}/`, collected, warn);
    } else if (entry.isFile()) {
      const type = contentTypeFor(relative);
      if (type === undefined) collected.skipped.push(relative);
      else collected.files[relative] = encodeFileValue(type, await read(full));
    }
  }
}
