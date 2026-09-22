import { describe, expect, it } from "vitest";
import { buildCampaign, candidateDigest } from "../src/workflow/campaign.js";
import {
  decideResultSchema,
  evidenceBundleSchema,
  evidencePacketSchema,
} from "../src/workflow/schemas.js";
import { rankCandidates } from "../src/policy.js";
import { buildQuestionPlan } from "../src/questions.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

function campaignFixture() {
  const request = structuredClone(minimalRequest);
  request.budget.max_survivors = 2;
  const plan = buildQuestionPlan(request);
  return buildCampaign(request, rankCandidates(request, makeResponse(plan)));
}

function packetFixture() {
  const campaign = campaignFixture();
  const workOrder = campaign.work_orders[0]!;
  return {
    kind: "jevrev.evidence-packet" as const,
    schema_version: "1" as const,
    campaign_id: campaign.campaign_id,
    candidate_id: workOrder.candidate_id,
    candidate_sha256: workOrder.candidate_sha256,
    revision: { base_commit: "abc123", head_commit: "def456" },
    development: { status: "completed" as const, wall_ms: 5_000 },
    observations: [
      {
        id: "tests",
        kind: "command" as const,
        argv: ["npm", "test"],
        exit_code: 0,
        duration_ms: 1_000,
        required: true,
      },
    ],
    metrics: [
      {
        id: "throughput",
        kind: "metric" as const,
        criterion_id: "speed",
        unit: "ops/s",
        direction: "higher" as const,
        baseline_samples: [100, 101, 99],
        candidate_samples: [205, 210, 208],
      },
    ],
    requirement_results: [
      {
        criterion_id: "api",
        kind: "constraint" as const,
        status: "pass" as const,
        observation_ids: ["tests"],
        metric_ids: [],
      },
      {
        criterion_id: "speed",
        kind: "success" as const,
        status: "pass" as const,
        observation_ids: [],
        metric_ids: ["throughput"],
      },
    ],
    probe_results: workOrder.required_evidence.map((evidence) => ({
      evidence_id: evidence.id,
      status: "pass" as const,
      observation_ids: ["tests"],
      metric_ids: ["throughput"],
    })),
    changed_files: ["src/parser.ts"],
    known_failures: [],
  };
}

describe("workflow schemas", () => {
  it("builds deterministic work orders for strict sift survivors", () => {
    const first = campaignFixture();
    const second = campaignFixture();

    expect(first).toEqual(second);
    expect(first.work_orders.map((workOrder) => workOrder.candidate_id)).toEqual(
      first.sift.selected,
    );
    expect(first.work_orders[0]?.candidate_sha256).toBe(
      candidateDigest(first.request.candidates[0]!),
    );
  });

  it("requires passing requirements to cite recorded evidence", () => {
    const packet = packetFixture();
    packet.requirement_results[0]!.observation_ids = [];

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false);
  });

  it("rejects references to unknown evidence IDs", () => {
    const packet = packetFixture();
    packet.requirement_results[0]!.observation_ids = ["missing"];

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false);
  });

  it("requires every packet to belong to the bundle campaign", () => {
    const packet = packetFixture();
    const bundle = {
      kind: "jevrev.evidence-bundle",
      schema_version: "1",
      campaign_id: packet.campaign_id,
      packets: [{ ...packet, campaign_id: "jvc_000000000000" }],
    };

    expect(evidenceBundleSchema.safeParse(bundle).success).toBe(false);
  });

  it("rejects absolute and repository-escaping changed-file paths", () => {
    const packet = packetFixture();
    packet.changed_files = ["C:\\secrets.txt"];
    expect(evidencePacketSchema.safeParse(packet).success).toBe(false);

    packet.changed_files = ["src/../../secrets.txt"];
    expect(evidencePacketSchema.safeParse(packet).success).toBe(false);
  });

  it("rejects contradictory decide outcome fields", () => {
    const invalid = {
      kind: "jevrev.decide-result",
      schema_version: "1",
      campaign_id: "jvc_000000000000",
      decision: "winner",
      winner: null,
      merge_candidates: ["allocation-cut"],
      eligible: [],
      evaluations: [],
      next_action: { type: "revise_ideas", candidate_ids: [] },
      audit: {
        policy: "decide-v1",
        provider_profile: "test",
        campaign_sha256: "0".repeat(64),
        evidence_sha256: "0".repeat(64),
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };

    expect(decideResultSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates content-addressed artifact evaluation references", () => {
    const packet = packetFixture();
    packet.artifacts = [{
      id: "demo",
      path: "artifacts/demo.html",
      media_type: "text/html",
      sha256: "a".repeat(64),
      size_bytes: 128,
      content_excerpt: "<main>Probe</main>",
    }];
    packet.artifact_evaluations = [{
      id: "visual-check",
      source: "imported",
      evaluator: "playwright-snapshot-v1",
      artifact_ids: ["missing"],
      status: "pass",
      score: 0.9,
      summary: "The expected view rendered.",
    }];

    expect(evidencePacketSchema.safeParse(packet).success).toBe(false);
    packet.artifact_evaluations[0]!.artifact_ids = ["demo"];
    expect(evidencePacketSchema.safeParse(packet).success).toBe(true);
  });
});
