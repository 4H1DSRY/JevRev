import { describe, expect, it } from "vitest";
import { rankRequestSchema } from "../src/domain/schemas.js";
import { buildQuestionPlan } from "../src/questions.js";
import { renderCampaignHuman } from "../src/workflow/report.js";
import { buildCampaign } from "../src/workflow/campaign.js";
import { rankCandidates } from "../src/policy.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

describe("adversarial workflow boundaries", () => {
  it("plans all 66 pair questions for twelve candidates without duplicate keys", () => {
    const request = structuredClone(minimalRequest);
    request.candidates = Array.from({ length: 12 }, (_unused, index) => ({
      ...minimalRequest.candidates[0]!,
      id: `candidate-${index}`,
      title: `Candidate ${index}`,
    }));
    request.budget.max_survivors = 5;

    const plan = buildQuestionPlan(request);
    const keys = Object.keys(plan.questions);
    const pairKeys = keys.filter((key) => key.startsWith("pair_"));

    expect(keys).toHaveLength(12 * 5 + 66);
    expect(pairKeys).toHaveLength(66);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rejects an oversized request before a provider can see it", () => {
    const request = structuredClone(minimalRequest);
    request.task.context = "x".repeat(4_000);
    request.candidates = Array.from({ length: 12 }, (_unused, index) => ({
      ...minimalRequest.candidates[0]!,
      id: `oversized-${index}`,
      title: `Oversized candidate ${index}`,
      summary: "x".repeat(600),
      mechanism: "x".repeat(1_500),
      assumptions: Array.from({ length: 8 }, () => "x".repeat(300)),
      risks: Array.from({ length: 8 }, () => "x".repeat(300)),
      validation: Array.from({ length: 8 }, () => "x".repeat(300)),
    }));
    const parsed = rankRequestSchema.safeParse(request);

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.message.includes("32,000"))).toBe(true);
  });

  it("keeps human work orders actionable under structured evidence", () => {
    const request = structuredClone(minimalRequest);
    const plan = buildQuestionPlan(request);
    const sift = rankCandidates(request, makeResponse(plan));
    const output = renderCampaignHuman(buildCampaign(request, sift));

    expect(output).toContain("probe-1:");
    expect(output).toContain("stop conditions");
    expect(output).not.toContain("[object Object]");
  });
});
