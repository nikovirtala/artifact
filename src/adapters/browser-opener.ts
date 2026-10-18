// Opens a URL in the default browser (docs/decisions/0040). The URL is always its own argument,
// never part of a shell string, and only plain http(s) URLs of safe characters are opened.
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

/** Start opening `url`; true if the launch was started. Never throws, never waits. */
export type Opener = (url: string) => boolean;

type Spawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { on(event: "error", listener: (error: Error) => void): unknown; unref(): void };

// No spaces, quotes, `&`, `^`, `%`, `|`, `<` or `>`: nothing cmd.exe or a browser would reinterpret.
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.:[\]/_~-]+$/;

/** The command that opens `url` on `platform`. */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}

export function createBrowserOpener(options: {
  warn: (message: string) => void;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
}): Opener {
  const { warn, platform = process.platform, spawn = nodeSpawn as Spawn } = options;
  let warned = false;
  const failed = (error: Error) => {
    if (warned) return;
    warned = true;
    warn(
      `artifact: cannot open the browser (${error.message}); start with --no-open to stop trying`,
    );
  };
  return (url) => {
    if (!SAFE_URL.test(url)) return false;
    const [command, args] = browserCommand(platform, url);
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // cmd.exe parses its own command line; the URL is checked above, so pass it unquoted.
        windowsVerbatimArguments: platform === "win32",
      });
      child.on("error", failed);
      child.unref();
      return true;
    } catch (error) {
      failed(error as Error);
      return false;
    }
  };
}
