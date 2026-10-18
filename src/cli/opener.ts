// The browser opener used by `serve` and `artifact open` (docs/decisions/0040, 0044). With
// `ARTIFACT_OPENER_LOG=<file>` (documented in the README), URLs are appended to that file and
// nothing is spawned, so tests and CI never launch a real browser.
import { appendFileSync } from "node:fs";
import { createBrowserOpener, type Opener } from "../adapters/browser-opener.ts";
import { type Env, envValue } from "../config.ts";

export function createCliOpener(options: { env: Env; warn: (message: string) => void }): Opener {
  const { env, warn } = options;
  const log = envValue(env, "ARTIFACT_OPENER_LOG");
  if (log === undefined) return createBrowserOpener({ warn });
  return (url) => {
    try {
      appendFileSync(log, `${url}\n`);
      return true;
    } catch (error) {
      warn(`artifact: cannot write to ARTIFACT_OPENER_LOG: ${(error as Error).message}`);
      return false;
    }
  };
}
