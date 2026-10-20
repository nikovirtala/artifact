// Builds one `ArtifactStage` per entry of the stage config.
import type { App } from "aws-cdk-lib";
import type { StageConfig } from "./config.ts";
import { ArtifactStage } from "./stage.ts";

export function buildApp(
  app: App,
  stages: Record<string, StageConfig>,
  owners: string[],
  alarmEmail?: string,
): Record<string, ArtifactStage> {
  return Object.fromEntries(
    Object.entries(stages).map(([key, config]) => [
      key,
      new ArtifactStage(app, { config, owners, alarmEmail }),
    ]),
  );
}
