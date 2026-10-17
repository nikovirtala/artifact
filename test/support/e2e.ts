// Helpers for e2e tests: spawn `artifact serve` on a free port and a temp root.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
export const env = { ...process.env, ARTIFACT_TOKEN: "", ARTIFACT_PORT: "", ARTIFACT_CSP: "" };
const children: ChildProcess[] = [];
const roots: string[] = [];

/** Kill every spawned server and remove every temp root; register with `after()`. */
export function cleanup(): void {
  for (const child of children) child.kill("SIGKILL");
  for (const root of roots) rmSync(root, { recursive: true, force: true });
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

/** Start `serve` and wait for its "serving" line. */
export async function serve(port: number, root: string): Promise<Served> {
  const child = spawn(process.execPath, [main, "serve", "--port", String(port), "--root", root], {
    env,
  });
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
