#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { App, Tags } from "aws-cdk-lib";
import { PlatformStack } from "../lib/platform-stack";

const app = new App();

// floci-lab/aws/bin -> floci-lab/aws -> floci-lab -> the directory holding every
// checkout. Overridable so this can be pointed at a CI workspace.
const repoRoot = path.resolve(
  process.env.AADYON_REPO_ROOT ?? path.join(__dirname, "..", "..", ".."),
);

// fromAsset builds from these paths at synth time, and its failure mode is a stack
// trace about a missing Dockerfile that says nothing about sibling checkouts. Fail
// here instead, where the message can explain itself.
for (const required of ["hybrid-rag", path.join("aadyon-assist", "code")]) {
  const full = path.join(repoRoot, required);
  if (!fs.existsSync(full)) {
    throw new Error(
      `Cannot find ${full}.\n` +
        `This app builds container images from the product checkouts, which it expects\n` +
        `beside floci-lab. Clone them there, or set AADYON_REPO_ROOT to the directory\n` +
        `that holds them.`,
    );
  }
}

new PlatformStack(app, "AadyonPlatform", {
  repoRoot,
  // Account and region come from the ambient credentials. Left unset so `cdk synth`
  // works with no AWS session at all, which is what makes this reviewable offline.
  env: process.env.CDK_DEFAULT_ACCOUNT
    ? {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
      }
    : undefined,
  description: "Aadyon on AWS: hybrid-rag and aadyon-assist on Fargate, sharing one RDS instance",
});

Tags.of(app).add("project", "aadyon");
Tags.of(app).add("managed-by", "cdk");
