// `artifact read <id>` (docs/decisions/0043): one file's raw bytes, the meta, or every file of a
// version written to a directory.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ArtifactDetails, Manifest } from "../core/artifact-service.ts";
import { ENTRY_PAGE } from "../core/paths.ts";
import { parseCommand, positiveInteger } from "./args.ts";
import { artifactPath, type Client, connect } from "./client.ts";
import { type CliContext, CliError, EXIT, printJson, UsageError } from "./output.ts";

export const USAGE = `Usage: artifact read <id> [options]

Prints a file exactly as published (default index.html of the current version) to stdout.

Options:
  --version <n>         Read this committed version instead of the current one
  --path <path>         File to print (default index.html)
  --out <dir>           Write every file of the version under <dir> instead
  --json                Print the artifact's meta and versions
  --server <url>        Server URL (default ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help

--path, --out and --json cannot be combined.
`;

const fileUrl = (id: string, path: string, version?: number) =>
  `${artifactPath(id, "files", ...path.split("/"))}${version === undefined ? "" : `?version=${version}`}`;

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    options: {
      version: { type: "string" },
      path: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
      server: { type: "string" },
    },
    positionals: { min: 1, max: 1 },
  });
  ctx.json = values.json === true;
  const [id] = positionals;
  const modes = [values.path !== undefined, values.out !== undefined, values.json === true];
  if (modes.filter(Boolean).length > 1) {
    throw new UsageError("--path, --out and --json cannot be combined");
  }
  const version =
    values.version === undefined ? undefined : positiveInteger("--version", values.version);
  if (values.json && version !== undefined) {
    throw new UsageError("--json prints every version; drop --version");
  }
  const client = connect(ctx, values.server);

  if (values.json) {
    printJson(ctx, (await client.json("GET", artifactPath(id))).body);
    return EXIT.ok;
  }
  if (values.out !== undefined) return writeVersion(ctx, client, id, version, values.out);
  const { body } = await client.bytes(fileUrl(id, values.path ?? ENTRY_PAGE, version));
  ctx.stdout.write(body);
  return EXIT.ok;
}

async function writeVersion(
  ctx: CliContext,
  client: Client,
  rawId: string,
  flagVersion: number | undefined,
  out: string,
): Promise<number> {
  const version =
    flagVersion ??
    ((await client.json("GET", artifactPath(rawId))).body as ArtifactDetails).currentVersion;
  const manifest = (await client.json("GET", artifactPath(rawId, "versions", String(version))))
    .body as Manifest;
  const root = resolve(ctx.cwd, out);
  const targets = manifest.files.map((file) => {
    const target = resolve(root, ...file.path.split("/"));
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new CliError(
        "invalid_path",
        `refusing to write ${JSON.stringify(file.path)} outside ${out}`,
      );
    }
    return { path: file.path, target };
  });
  for (const { path, target } of targets) {
    const { body } = await client.bytes(fileUrl(manifest.id, path, version));
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      throw new CliError("io_error", `cannot write ${target}: ${code ?? message}`);
    }
  }
  ctx.stdout.write(
    `wrote ${targets.length} files of ${manifest.id} version ${version} to ${out}\n`,
  );
  return EXIT.ok;
}
