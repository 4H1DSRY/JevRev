import { describe, expect, it } from "vitest";
import { rankResultSchema } from "../src/domain/schemas.js";
import { rankCandidates } from "../src/policy.js";
import { buildQuestionPlan } from "../src/questions.js";
import { renderHuman, renderJson } from "../src/report.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

describe("reporting", () => {
  it("emits protocol-valid JSON", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const result = rankCandidates(minimalRequest, makeResponse(plan));

    expect(rankResultSchema.parse(JSON.parse(renderJson(result)))).toEqual(result);
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
