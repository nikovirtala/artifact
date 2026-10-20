// The stage config (owner decisions 1–3, docs/decisions/0075): the only file with the account,
// Region and domains. Imports types and enums only and builds nothing, so the scripts can read
// it without constructing the app or setting ARTIFACT_OWNERS.
import { RemovalPolicy } from "aws-cdk-lib";
import type { StageConfig } from "./config.ts";

export const stages: Record<string, StageConfig> = {
  prod: {
    name: "prod",
    account: "827333031966",
    region: "eu-north-1",
    certificateRegion: "us-east-1",
    viewDomain: "artifact.nikovirtala.dev",
    apiDomain: "api.artifact.nikovirtala.dev",
    removalPolicy: RemovalPolicy.RETAIN,
  },
};
