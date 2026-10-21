// The prebuilt Lambda bundles and the edge function (docs/decisions/0068, 0079, 0080, 0082).
// From dist/cdk/ this is the package's dist/assets/<name>; from src/cdk/ (tests, the source
// condition) the repo's dist/assets/<name>.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type AssetName = "control" | "sweep" | "viewing" | "session-keys" | "edge";

/** The directory of asset `name`, after checking that `file` is in it. */
export function assetDir(name: AssetName, file = "index.mjs"): string {
  const dir = fileURLToPath(new URL(`../../dist/assets/${name}/`, import.meta.url));
  if (!existsSync(join(dir, file))) {
    throw new Error(
      `artifact: Lambda asset dist/assets/${name}/${file} is missing; run pnpm bundle`,
    );
  }
  return dir;
}
