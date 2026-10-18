// `artifact serve`: config → lock the root → wire the service → sweep orphans → listen until
// SIGINT/SIGTERM.
import { mkdir } from "node:fs/promises";
import { getRequestListener } from "@hono/node-server";
import { createFsStore } from "../adapters/fs-store.ts";
import { acquireLock } from "../adapters/lockfile.ts";
import { createMemoryNotifier } from "../adapters/memory-notifier.ts";
import { systemClock } from "../adapters/system-clock.ts";
import { createUlidIdGen } from "../adapters/ulid.ts";
import { type Env, resolveServeConfig, SERVE_USAGE } from "../config.ts";
import { ArtifactService } from "../core/artifact-service.ts";
import { createApp } from "../http/app.ts";
import { type Listening, listen, PortInUseError } from "../http/server.ts";
import { createCliOpener } from "./opener.ts";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

/** Resolves with the exit code once the server has stopped (or failed to start). */
export async function runServe(args: readonly string[], env: Env): Promise<number> {
  const resolved = resolveServeConfig(args, env);
  if (!resolved.ok) {
    if (resolved.usage) {
      process.stderr.write(`${resolved.message}\n\n${SERVE_USAGE}`);
      return 2;
    }
    err(`${resolved.message}\nRun 'artifact serve --help' for usage.`);
    return 1;
  }
  if (resolved.help) {
    process.stdout.write(SERVE_USAGE);
    return 0;
  }
  const { config, warnings } = resolved;
  for (const warning of warnings) err(warning);

  await mkdir(config.root, { recursive: true });
  const acquired = acquireLock(config.root, { port: config.port });
  if (!acquired.ok) {
    err(acquired.message);
    return 1;
  }
  const { lock } = acquired;
  process.on("exit", lock.release);
  if (lock.tookOver) err(`artifact: took over stale lock from PID ${lock.tookOver.pid}`);

  // Handle signals before listening, so one sent during startup still releases the lock.
  let stopRequested = false;
  let onSignal = () => {};
  const signalled = new Promise<void>((resolve) => {
    onSignal = () => {
      stopRequested = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const store = createFsStore({ root: config.root });
  const notifier = createMemoryNotifier();
  const service = new ArtifactService({
    blobs: store,
    pointers: store,
    notifier,
    clock: systemClock,
    ids: createUlidIdGen(),
  });
  // Under the lock, before listening: nothing else can be publishing to this root (0047).
  try {
    const swept = await service.sweepOrphans();
    if (swept.versions || swept.folders) {
      out(
        `artifact: orphan sweep removed ${swept.versions} uncommitted version(s) and ${swept.folders} folder(s) without meta.json`,
      );
    }
  } catch (error) {
    err(`artifact: warning: orphan sweep failed: ${(error as Error).message}`);
  }
  const opener = config.open ? createCliOpener({ env, warn: err }) : undefined;
  const app = createApp({ service, events: notifier, config, opener });

  let listening: Listening;
  try {
    listening = await listen(getRequestListener(app.fetch), {
      port: config.port,
      host: config.host,
      warn: err,
    });
  } catch (error) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    lock.release();
    err(
      error instanceof PortInUseError
        ? error.message
        : `artifact: cannot listen on port ${config.port}: ${(error as Error).message}`,
    );
    return 1;
  }
  if (!stopRequested) {
    out(
      `artifact: serving ${config.root} at http://localhost:${config.port}/ (isolation: ${config.isolation})`,
    );
  }

  await signalled;
  await listening.close();
  lock.release();
  return 0;
}
