#!/usr/bin/env node

/*
 * Create a deliberately incomplete evidence bundle from a Sift campaign.
 * This is a handoff aid, not a fake result: every probe and requirement starts
 * as `unknown`, and Decide will refuse to treat the template as a winner.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { campaignSchema } from "../dist/workflow/schemas.js";

function usage() {
  return [
    "Usage: node scripts/create-evidence-template.mjs --campaign campaign.json [--output evidence.json] [--base-commit SHA]",
    "",
    "The generated bundle is intentionally incomplete. Fill observations, metrics,",
    "requirement_results, and probe_results before calling `jevrev decide`.",
  ].join("\n");
}

function parseArgs(argv) {
  const values = { campaign: undefined, output: undefined, baseCommit: "REPLACE_WITH_BASE_COMMIT" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--campaign") values.campaign = argv[++index];
    else if (argument === "--output") values.output = argv[++index];
    else if (argument === "--base-commit") values.baseCommit = argv[++index];
    else throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
  }
  if (typeof values.campaign !== "string" || values.campaign.length === 0) {
    throw new Error(`--campaign is required\n\n${usage()}`);
  }
  return values;
}

const options = parseArgs(process.argv.slice(2));
const campaign = campaignSchema.parse(JSON.parse(await readFile(resolve(options.campaign), "utf8")));
const successRequirements = campaign.request.task.success.map((criterion) => ({
  criterion_id: criterion.id,
  kind: "success",
  status: "unknown",
  observation_ids: [],
  metric_ids: [],
}));
const hardRequirements = campaign.request.task.constraints
  .filter((constraint) => constraint.kind === "hard")
  .map((constraint) => ({
    criterion_id: constraint.id,
    kind: "constraint",
    status: "unknown",
    observation_ids: [],
    metric_ids: [],
  }));

const bundle = {
  kind: "jevrev.evidence-bundle",
  schema_version: "1",
  campaign_id: campaign.campaign_id,
  packets: campaign.work_orders.map((workOrder) => ({
    kind: "jevrev.evidence-packet",
    schema_version: "1",
    campaign_id: campaign.campaign_id,
    candidate_id: workOrder.candidate_id,
    candidate_sha256: workOrder.candidate_sha256,
    revision: { base_commit: options.baseCommit },
    development: { status: "not_started", wall_ms: 0 },
    observations: [],
    metrics: [],
    requirement_results: [...successRequirements, ...hardRequirements],
    probe_results: workOrder.required_evidence.map((evidence) => ({
      evidence_id: evidence.id,
      status: "unknown",
      observation_ids: [],
      metric_ids: [],
    })),
    artifacts: [],
    artifact_evaluations: [],
    changed_files: [],
    known_failures: ["TEMPLATE: replace this packet with recorded probe evidence before Decide."],
  })),
};

const rendered = `${JSON.stringify(bundle, null, 2)}\n`;
if (options.output === undefined) process.stdout.write(rendered);
else await writeFile(resolve(options.output), rendered, "utf8");
