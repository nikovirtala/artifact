// tsc only emits .ts sources; copy the plain-JS assets it skips into dist/.
// Missing assets are skipped so the build works before they exist (reload-client.js lands in M3).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const assets = ["http/reload-client.js"];

for (const asset of assets) {
  const from = fileURLToPath(new URL(`../src/${asset}`, import.meta.url));
  const to = fileURLToPath(new URL(`../dist/${asset}`, import.meta.url));
  if (!existsSync(from)) {
    console.log(`copy-assets: skipped src/${asset} (not present)`);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copy-assets: src/${asset} -> dist/${asset}`);
}
