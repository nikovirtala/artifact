// The cold-start line (docs/decisions/0076): which Node and which runtime-provided AWS SDK
// clients the function runs with (the V2 residual), read the way AWS documents for an ES-module
// handler. Fixed fields only, so nothing secret can reach the log.
import { PACKAGE_VERSION } from "../../version.ts";

type PackageJson = { default: { version?: unknown } };

async function versionOf(load: () => Promise<PackageJson>): Promise<string> {
  try {
    const { version } = (await load()).default;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** `artifact runtime {"node","clientS3"[,"clientSecretsManager"],"package"}`. */
export async function runtimeInfoLine(options: { secretsManager: boolean }): Promise<string> {
  const clientS3 = await versionOf(
    () => import("@aws-sdk/client-s3/package.json", { with: { type: "json" } }),
  );
  const clientSecretsManager = options.secretsManager
    ? await versionOf(
        () => import("@aws-sdk/client-secrets-manager/package.json", { with: { type: "json" } }),
      )
    : undefined;
  return `artifact runtime ${JSON.stringify({
    node: process.version,
    clientS3,
    ...(clientSecretsManager === undefined ? {} : { clientSecretsManager }),
    package: PACKAGE_VERSION,
  })}`;
}
