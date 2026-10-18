// `artifact open <id>` (docs/decisions/0044): print the URL and open it, whatever serve's
// auto-open setting; only BROWSER=none skips the launch.
import type { ArtifactDetails } from "../core/artifact-service.ts";
import { parseCommand, positiveInteger } from "./args.ts";
import { artifactPath, connect } from "./client.ts";
import { createCliOpener } from "./opener.ts";
import { type CliContext, CliError, EXIT, printJson } from "./output.ts";

export const USAGE = `Usage: artifact open <id> [options]

Prints the artifact's URL and opens it in the browser (not with BROWSER=none).

Options:
  --version <n>         Open this committed version's pinned URL
  --json                Print {id, url, opened}
  --server <url>        Server URL (default ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help
`;

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    options: {
      version: { type: "string" },
      json: { type: "boolean" },
      server: { type: "string" },
    },
    positionals: { min: 1, max: 1 },
  });
  ctx.json = values.json === true;
  const version =
    values.version === undefined ? undefined : positiveInteger("--version", values.version);
  const client = connect(ctx, values.server);
  const meta = (await client.json("GET", artifactPath(positionals[0]))).body as ArtifactDetails & {
    url: string;
  };
  if (version !== undefined && !meta.versions.some((v) => v.version === version)) {
    throw new CliError("not_found", `version ${version} of artifact ${meta.id} not found`);
  }
  const url = version === undefined ? meta.url : `${meta.url}v/${version}/`;
  const warn = (message: string) => ctx.stderr.write(`${message}\n`);
  const opened = ctx.env.BROWSER === "none" ? false : createCliOpener({ env: ctx.env, warn })(url);
  if (values.json) {
    printJson(ctx, { id: meta.id, url, opened });
    return EXIT.ok;
  }
  ctx.stdout.write(`${url}\n`);
  return EXIT.ok;
}
