import { describe, expect, it } from "vitest";
import { rankResultSchema } from "../src/domain/schemas.js";
import { rankCandidates } from "../src/policy.js";
import { buildQuestionPlan } from "../src/questions.js";
import { renderHuman, renderJson } from "../src/report.js";
import { renderCampaignHuman } from "../src/workflow/report.js";
import { buildCampaign } from "../src/workflow/campaign.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

describe("reporting", () => {
  it("emits protocol-valid JSON", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const result = rankCandidates(minimalRequest, makeResponse(plan));

    expect(rankResultSchema.parse(JSON.parse(renderJson(result)))).toEqual(result);
    expect(result.policy.provider_profile).toBe("library");
  });

  it("records an explicit provider profile when supplied by a host", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const result = rankCandidates(minimalRequest, makeResponse(plan), undefined, {
      providerProfile: "semif/Qwen3.5-4B-Q4_K_M",
    });

    expect(result.policy.provider_profile).toBe("semif/Qwen3.5-4B-Q4_K_M");
  });

  it("renders structured work-order evidence as useful human text", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 1;
    const plan = buildQuestionPlan(request);
    const sift = rankCandidates(request, makeResponse(plan));
    const output = renderCampaignHuman(buildCampaign(request, sift));

    expect(output).toContain("probe-1:");
    expect(output).toContain("Run tests and allocation benchmark");
    expect(output).not.toContain("[object Object]");
  });

  it("labels rules without claiming model-generated reasoning", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const result = rankCandidates(
      minimalRequest,
      makeResponse(plan, [
        { goal: 0, constraint: 0.1, feasibility: 0, value: 0.1 },
        { goal: 3, constraint: 0.9, feasibility: 3, value: 0.9 },
      ]),
    );

    const output = renderHuman(result);
    expect(output).toContain("hard-constraint risk");
    expect(output).toContain("Implement next: byte-fast-path");
    expect(output).not.toContain("Jev says");
  });
});
