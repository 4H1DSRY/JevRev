import { describe, expect, it } from "vitest";
import { buildCampaign } from "../src/workflow/campaign.js";
import { reconsiderCandidate } from "../src/reconsider.js";
import { rankCandidates } from "../src/policy.js";
import { buildQuestionPlan, type QuestionPlan } from "../src/questions.js";
import type { Judge } from "../src/judge.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

function reviewCampaign() {
  const plan = buildQuestionPlan(minimalRequest);
  const sift = rankCandidates(minimalRequest, makeResponse(plan, [
    { goal: 2.5, goalConfidence: 0.1, constraint: 0.9, value: 0.9 },
    { goal: 3, constraint: 0.9, value: 0.9 },
  ]));
  return buildCampaign(minimalRequest, sift);
}

function response(plan: QuestionPlan, options: { constraint?: number; confidence?: number; score?: number } = {}) {
  const answers: Record<string, unknown> = {};
  for (const key of Object.keys(plan.expectedTypes)) {
    if (key.endsWith("constraint_fit")) {
      answers[key] = { type: "noul", noul: options.constraint ?? 0.9 };
    } else {
      answers[key] = {
        type: "score", score: options.score ?? 3, confidence: options.confidence ?? 0.9,
        legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" },
        probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 },
      };
    }
  }
  return { model: "jev-reconsider-test", answers, usage: { input_tokens: 40, output_tokens: 20 } };
}

describe("JevSift reconsider", () => {
  it("promotes a review candidate only to one bounded probe", async () => {
    const campaign = reviewCampaign();
    const judge: Judge = { evaluate: async (plan) => response(plan) };
    const result = await reconsiderCandidate(campaign, "allocation-cut", judge);
    expect(result.decision).toBe("promote_to_probe");
    expect(result.suggested_probe).toBe("Run tests and allocation benchmark");
    expect(result.work_order).toMatchObject({ candidate_id: "allocation-cut" });
    expect(result.work_order?.candidate_sha256).toHaveLength(64);
    expect(result.promoted_campaign).toMatchObject({ review_work_orders: [{ candidate_id: "allocation-cut" }] });
    expect(result.audit.policy).toBe("reconsider-v1");
  });

  it("keeps a low-confidence review candidate in review", async () => {
    const campaign = reviewCampaign();
    const judge: Judge = { evaluate: async (plan) => response(plan, { confidence: 0.1 }) };
    const result = await reconsiderCandidate(campaign, "allocation-cut", judge);
    expect(result.decision).toBe("keep_review");
    expect(result.work_order).toBeNull();
    expect(result.reasons).toContain("LOW_CONFIDENCE");
  });

  it("never promotes a candidate that fails a hard constraint", async () => {
    const campaign = reviewCampaign();
    const judge: Judge = { evaluate: async (plan) => response(plan, { constraint: 0.1 }) };
    const result = await reconsiderCandidate(campaign, "allocation-cut", judge);
    expect(result.decision).toBe("reject");
    expect(result.work_order).toBeNull();
    expect(result.reasons).toContain("CONSTRAINT_RISK");
  });

  it("only accepts candidates that are actually in Sift review", async () => {
    const campaign = reviewCampaign();
    const judge: Judge = { evaluate: async (plan) => response(plan) };
    await expect(reconsiderCandidate(campaign, "byte-fast-path", judge)).rejects.toThrow("not in review");
  });

});
