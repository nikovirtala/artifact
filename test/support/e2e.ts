// Helpers for e2e tests: spawn `artifact serve` on a free port and a temp root, and run client
// commands. The CLI under test is `ARTIFACT_CLI` when set (an installed bin, see
// docs/decisions/0048), else `node src/cli/main.ts`.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

/** Where the test opener appends each URL it would open (one per line), per test process. */
export const openerLog = join(tmpdir(), `artifact-e2e-opener-${process.pid}.log`);

export const env: NodeJS.ProcessEnv = {
  ...process.env,
  ARTIFACT_TOKEN: "",
  ARTIFACT_PORT: "",
  ARTIFACT_CSP: "",
  ARTIFACT_SERVER: "",
  SSH_CONNECTION: "",
  // Never launch a real browser from tests.
  ARTIFACT_OPEN: "0",
  ARTIFACT_OPENER_LOG: openerLog,
};
const children: ChildProcess[] = [];
const roots: string[] = [];

/** Kill every spawned process and remove every temp root; register with `after()`. */
export function cleanup(): void {
  for (const child of children) child.kill("SIGKILL");
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(openerLog, { force: true });
}

/** Command and arguments that run the CLI under test with `args`. */
export function cliCommand(...args: string[]): [string, string[]] {
  const cli = process.env.ARTIFACT_CLI;
  return cli ? [cli, args] : [process.execPath, [main, ...args]];
}

export type CliRun = { status: number | null; stdout: Buffer; stderr: string };

/**
 * Run the CLI to completion with the cleared `env` (plus `options.env`). stdin is a pipe that
 * gets `input` and is then closed, so the command never sees a TTY. Killed after `timeout` ms.
 */
export function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string; timeout?: number } = {},
): Promise<CliRun> {
  const [command, argv] = cliCommand(...args);
  const child = spawn(command, argv, { env: { ...env, ...options.env }, cwd: options.cwd });
  children.push(child);
  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => stdout.push(d));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderr += d;
  });
  // A command that exits without reading stdin would otherwise raise EPIPE here.
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.input ?? "");
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 10_000);
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

export function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "artifact-e2e-"));
  roots.push(root);
  return root;
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

export type Served = { child: ChildProcess; stderr: () => string; exited: Promise<number | null> };

/** Start `serve` and wait for its "serving" line; `extraEnv` overrides the cleared env. */
export async function serve(
  port: number,
  root: string,
  extraEnv: Record<string, string> = {},
): Promise<Served> {
  const [command, argv] = cliCommand("serve", "--port", String(port), "--root", root);
  const child = spawn(command, argv, { env: { ...env, ...extraEnv } });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${stderr}`)), 10_000);
    child.stdout?.on("data", (d) => {
      stdout += d;
      if (stdout.includes("serving")) {
        clearTimeout(timer);
        resolve();
      }
    });
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`serve exited early: ${stderr}`));
    });
  });
  return { child, stderr: () => stderr, exited };
}
