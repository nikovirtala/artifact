// The package version, read in one place: the Lambda bundles replace this module with the
// version inlined, because /var/task has no package.json (docs/decisions/0068).
import { createRequire } from "node:module";

export const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
