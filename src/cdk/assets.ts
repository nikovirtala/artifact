// The prebuilt Lambda bundles (docs/decisions/0068). From dist/cdk/ this is the package's
// dist/assets/<name>; from src/cdk/ (tests, the source condition) the repo's dist/assets/<name>.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function assetDir(name: "control" | "sweep"): string {
  const dir = fileURLToPath(new URL(`../../dist/assets/${name}/`, import.meta.url));
  if (!existsSync(join(dir, "index.mjs"))) {
    throw new Error(
      `artifact: Lambda asset dist/assets/${name}/index.mjs is missing; run pnpm bundle`,
    );
  }
  return dir;
}
