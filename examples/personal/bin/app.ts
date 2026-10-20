// The reference CDK app (docs/decisions/0075). Owners from ARTIFACT_OWNERS, the optional alarm
// address from ARTIFACT_ALARM_EMAIL; everything else from lib/stages.ts.
import { App } from "aws-cdk-lib";
import { buildApp } from "../lib/app.ts";
import { ownersFromEnv } from "../lib/config.ts";
import { stages } from "../lib/stages.ts";

buildApp(new App(), stages, ownersFromEnv(process.env), process.env.ARTIFACT_ALARM_EMAIL);
