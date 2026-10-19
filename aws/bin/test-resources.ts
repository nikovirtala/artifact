#!/usr/bin/env node
// CDK app for the stage-independent test resources (docs/decisions/0063). Synth locally with
// `pnpm --filter aws synth`; only the owner deploys it. Context: githubRepository (default
// nikovirtala/artifact), githubEnvironment (default s3-contract), githubOidcProviderArn (to
// reuse the account's existing GitHub OIDC provider).
import { App, BootstraplessSynthesizer } from "aws-cdk-lib";
import { TestResourcesStack } from "../lib/test-resources-stack.ts";

const app = new App();
const context = (key: string): string | undefined => app.node.tryGetContext(key) || undefined;

new TestResourcesStack(app, "ArtifactTestResources", {
  // No assets, so no bootstrap stack is needed to deploy.
  synthesizer: new BootstraplessSynthesizer(),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-north-1",
  },
  githubRepository: context("githubRepository") ?? "nikovirtala/artifact",
  githubEnvironment: context("githubEnvironment"),
  githubOidcProviderArn: context("githubOidcProviderArn"),
});
