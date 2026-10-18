// `artifact list` (docs/decisions/0042): the current project's artifacts by default.
import { normalizeProject } from "../core/project.ts";
import { parseCommand, positiveInteger } from "./args.ts";
import { type Client, connect } from "./client.ts";
import { type CliContext, EXIT, printJson, table, UsageError } from "./output.ts";
import { deriveProject } from "./project.ts";

export const USAGE = `Usage: artifact list [options]

Lists artifacts, most recently updated first. By default only those of the project derived
from git in the working directory (as agents derive it); the first line names the filter, and
stderr says how many artifacts of other projects (or without one) it hid.

Options:
  --project <project>   List this project's artifacts instead
  --all                 List the artifacts of every project
  --limit <n>           Most artifacts to list (default 50, at most 500)
  --json                Print the API response
  --server <url>        Server URL (default ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help
`;

/** The API's largest `limit` (0023). */
const MAX_LIMIT = 500;

type Listed = {
  artifacts: {
    id: string;
    title?: string;
    project?: string;
    currentVersion: number;
    updatedAt: string;
  }[];
};

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand(args, {
    options: {
      project: { type: "string" },
      all: { type: "boolean" },
      limit: { type: "string" },
      json: { type: "boolean" },
      server: { type: "string" },
    },
  });
  ctx.json = values.json === true;
  if (values.all && values.project !== undefined) {
    throw new UsageError("--all and --project cannot be combined");
  }
  if (values.project === "") {
    throw new UsageError("--project must not be empty; use --all to list every project");
  }
  const limit = values.limit === undefined ? undefined : positiveInteger("--limit", values.limit);
  const client = connect(ctx, values.server);
  const project = values.all ? undefined : (values.project ?? (await deriveProject(ctx.cwd)));

  const query = new URLSearchParams();
  if (project !== undefined) query.set("project", project);
  if (limit !== undefined) query.set("limit", String(limit));
  const search = query.size ? `?${query}` : "";
  const { body } = await client.json("GET", `/api/artifacts${search}`);
  if (values.json) {
    printJson(ctx, body);
    return EXIT.ok;
  }

  const shown = project === undefined ? undefined : normalizeProject(project);
  ctx.stdout.write(
    project === undefined ? "all projects\n" : `project: ${shown?.ok ? shown.value : project}\n`,
  );
  const { artifacts } = body as Listed;
  const all = project === undefined;
  ctx.stdout.write(
    artifacts.length === 0
      ? "no artifacts\n"
      : table([
          ["ID", "VERSION", "UPDATED", ...(all ? ["PROJECT"] : []), "TITLE"],
          ...artifacts.map((a) => [
            a.id,
            String(a.currentVersion),
            a.updatedAt,
            ...(all ? [a.project ?? "-"] : []),
            a.title ?? "",
          ]),
        ]),
  );
  if (shown?.ok) {
    const hint = await hiddenHint(client, shown.value);
    if (hint !== undefined) ctx.stderr.write(`${hint}\n`);
  }
  return EXIT.ok;
}

/**
 * How many artifacts the project filter hid, from one unfiltered request at the API's maximum
 * limit. Counted by project rather than against the filtered page, so `--limit` does not make
 * the project's own artifacts look hidden. Any failure just drops the hint.
 */
async function hiddenHint(client: Client, project: string): Promise<string | undefined> {
  let artifacts: Listed["artifacts"];
  try {
    ({ artifacts } = (await client.json("GET", `/api/artifacts?limit=${MAX_LIMIT}`))
      .body as Listed);
    if (!Array.isArray(artifacts)) return undefined;
  } catch {
    return undefined;
  }
  const hidden = artifacts.filter((a) => a.project !== project).length;
  if (hidden === 0) return undefined;
  const count = artifacts.length >= MAX_LIMIT ? `at least ${hidden}` : String(hidden);
  return `${count} more in other projects (or without a project); use --all`;
}
