// Project derivation in the CLI (docs/decisions/0042), the same rule agents follow (0039):
//   1. `git remote get-url origin`; 2. `local:` + `git rev-parse --show-toplevel`; 3. `local:` + cwd.
// A step that fails or whose output does not normalise falls through to the next one.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeProject } from "../core/project.ts";
import { CliError, UsageError } from "./output.ts";

/** Run `file args` in `cwd` and resolve with its stdout; reject on any failure. */
export type Exec = (file: string, args: string[], options: { cwd: string }) => Promise<string>;

const execFileAsync = promisify(execFile);

export const gitExec: Exec = async (file, args, { cwd }) => {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    timeout: 5000,
    windowsHide: true,
    encoding: "utf8",
  });
  return stdout;
};

/** The normalised project of the codebase at `cwd`. */
export async function deriveProject(cwd: string, exec: Exec = gitExec): Promise<string> {
  const git = async (...args: string[]) => (await exec("git", args, { cwd })).trim();
  const candidates = [
    () => git("remote", "get-url", "origin"),
    async () => `local:${await git("rev-parse", "--show-toplevel")}`,
  ];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await candidate();
    } catch {
      continue;
    }
    const normalized = normalizeProject(raw);
    if (normalized.ok) return normalized.value;
  }
  const local = normalizeProject(`local:${cwd}`);
  if (!local.ok) throw new CliError(local.error.code, local.error.message);
  return local.value;
}

/**
 * The project a command uses: `--project` as given (the server normalises it), none with
 * `--no-project`, else derived from `cwd`.
 */
export async function resolveProject(
  values: { project?: string; "no-project"?: boolean },
  cwd: string,
  exec: Exec = gitExec,
): Promise<string | undefined> {
  if (values.project === "") {
    throw new UsageError("--project must not be empty; use --no-project to publish without one");
  }
  if (values.project !== undefined && values["no-project"]) {
    throw new UsageError("--project and --no-project cannot be combined");
  }
  if (values["no-project"]) return undefined;
  return values.project ?? deriveProject(cwd, exec);
}
