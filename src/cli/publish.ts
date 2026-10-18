// `artifact publish <file or dir>` (docs/decisions/0043): POST to create, PUT with --id.
import { resolve } from "node:path";
import { parseCommand, positiveInteger } from "./args.ts";
import { artifactPath, connect } from "./client.ts";
import { collectFiles } from "./files.ts";
import { type CliContext, EXIT, printJson, UsageError } from "./output.ts";
import { resolveProject } from "./project.ts";

export const USAGE = `Usage: artifact publish <file or dir> [options]

Publishes an .html file (as index.html) or a directory (index.html required; names starting
with ".", symlinks and file types the server does not accept are skipped) and prints the URL.

Options:
  --id <id>             Add a version to this artifact instead of creating one
  --if-version <n>      With --id: update only if <n> is still the current version
  --title <title>       Title shown in the gallery and in list
  --label <label>       Short name for this version
  --project <project>   Project stored on create (default: derived from git in the
                        working directory, as agents do)
  --no-project          Create without a project
  --no-open             Do not open the new artifact in the browser
  --json                Print the API response, plus "skipped" paths if any
  --server <url>        Server URL (default ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help
`;

type Published = { id: string; version: number; url: string; opened?: boolean };

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    options: {
      id: { type: "string" },
      "if-version": { type: "string" },
      title: { type: "string" },
      label: { type: "string" },
      project: { type: "string" },
      "no-project": { type: "boolean" },
      "no-open": { type: "boolean" },
      json: { type: "boolean" },
      server: { type: "string" },
    },
    positionals: { min: 1, max: 1 },
  });
  ctx.json = values.json === true;
  const rawIfVersion = values["if-version"];
  const ifVersion =
    rawIfVersion === undefined ? undefined : positiveInteger("--if-version", rawIfVersion);
  if (ifVersion !== undefined && values.id === undefined) {
    throw new UsageError("--if-version requires --id");
  }
  const client = connect(ctx, values.server);
  // An update keeps the stored project (0039), so it is only resolved when creating.
  const project = values.id === undefined ? await resolveProject(values, ctx.cwd) : undefined;
  const warn = (message: string) => ctx.stderr.write(`${message}\n`);
  const { files, skipped } = await collectFiles(resolve(ctx.cwd, positionals[0]), warn);
  const body = {
    files,
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.label === undefined ? {} : { label: values.label }),
  };

  const response =
    values.id === undefined
      ? await client.json("POST", "/api/artifacts", {
          body: {
            ...body,
            ...(project === undefined ? {} : { project }),
            ...(values["no-open"] ? { open: false } : {}),
          },
        })
      : await client.json("PUT", artifactPath(values.id), {
          body,
          headers: ifVersion === undefined ? {} : { "if-match": String(ifVersion) },
        });
  const published = response.body as Published;
  if (values.json) {
    printJson(ctx, skipped.length > 0 ? { ...published, skipped } : published);
    return EXIT.ok;
  }
  ctx.stdout.write(`${published.url}\n`);
  warn(
    values.id === undefined
      ? `created ${published.id} (version ${published.version}${published.opened ? ", opened in the browser" : ""})`
      : `updated ${published.id} to version ${published.version}`,
  );
  return EXIT.ok;
}
