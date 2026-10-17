// One server per root (docs/decisions/0026): `<root>/.lock` holds {pid, port, startedAt}.
// Created exclusively; a lock whose pid is dead is taken over. Sync, so it can run in an
// `exit` handler.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = ".lock";

export type Lock = {
  path: string;
  /** Set when a stale lock of a dead process was replaced. */
  tookOver?: { pid: number };
  /** Remove the lock if it is still ours. Idempotent. */
  release(): void;
};

export type LockResult = { ok: true; lock: Lock } | { ok: false; message: string };

type Holder = { pid: number; port: number };

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === "EPERM"; // exists, owned by another user
  }
}

/** The holder, `"missing"` if the file is gone, or `undefined` if it cannot be parsed. */
function readHolder(path: string): Holder | "missing" | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return "missing";
    throw error;
  }
  try {
    const { pid, port } = JSON.parse(text) as Partial<Holder>;
    if (Number.isSafeInteger(pid) && (pid as number) > 0) return { pid, port } as Holder;
  } catch {}
  return undefined;
}

export function acquireLock(
  root: string,
  options: { port: number; now?: Date; pid?: number },
): LockResult {
  const path = join(root, LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const content = `${JSON.stringify({ pid, port: options.port, startedAt: (options.now ?? new Date()).toISOString() })}\n`;

  const create = (): boolean => {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (error) {
      if (code(error) === "EEXIST") return false;
      throw error;
    }
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return true;
  };

  let released = false;
  const lock = (tookOver?: { pid: number }): LockResult => ({
    ok: true,
    lock: {
      path,
      ...(tookOver ? { tookOver } : {}),
      release() {
        if (released) return;
        released = true;
        const holder = readHolder(path);
        if (typeof holder === "object" && holder.pid === pid) {
          try {
            unlinkSync(path);
          } catch {}
        }
      },
    },
  });
  const served = (h: Holder): LockResult => ({
    ok: false,
    message: `artifact: ${root} is already served by PID ${h.pid} on port ${h.port}; delete ${path} if stale`,
  });

  if (create()) return lock();
  const holder = readHolder(path);
  if (holder === "missing")
    return create() ? lock() : { ok: false, message: `artifact: could not create ${path}` };
  if (holder === undefined) {
    return { ok: false, message: `artifact: lock file ${path} is unreadable; delete it if stale` };
  }
  if (isAlive(holder.pid)) return served(holder);
  try {
    unlinkSync(path);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  if (create()) return lock({ pid: holder.pid });
  const winner = readHolder(path);
  return served(typeof winner === "object" ? winner : holder);
}
