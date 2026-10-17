// tsc only emits .ts sources; copy the plain-JS assets it skips into dist/.
// A missing asset fails the build: the package would otherwise ship without it (docs/decisions/0005).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const assets = ["http/reload-client.js"];

const missing = assets.filter(
  (asset) => !existsSync(fileURLToPath(new URL(`../src/${asset}`, import.meta.url))),
);
if (missing.length > 0) {
  for (const asset of missing) console.error(`copy-assets: missing src/${asset}`);
  process.exit(1);
}

for (const asset of assets) {
  const from = fileURLToPath(new URL(`../src/${asset}`, import.meta.url));
  const to = fileURLToPath(new URL(`../dist/${asset}`, import.meta.url));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copy-assets: src/${asset} -> dist/${asset}`);
}
