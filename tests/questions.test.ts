import { describe, expect, it } from "vitest";
import {
  buildQuestionPlan,
  candidateQuestionKey,
  duplicateQuestionKey,
} from "../src/questions.js";
import { minimalRequest } from "./fixtures.js";

describe("buildQuestionPlan", () => {
  it("builds five atomic questions per candidate and every pair", () => {
    const plan = buildQuestionPlan(minimalRequest);

    expect(Object.keys(plan.questions)).toHaveLength(11);
    expect(plan.questions[candidateQuestionKey(0, "goal_fit")]?.type).toBe("score");
    expect(plan.questions[candidateQuestionKey(1, "constraint_fit")]?.type).toBe("noul");
    expect(plan.questions[duplicateQuestionKey(0, 1)]?.type).toBe("noul");
  });

  it("names the candidate state path inside every instruction", () => {
    const plan = buildQuestionPlan(minimalRequest);

    for (const [key, question] of Object.entries(plan.questions)) {
      const serialized = JSON.stringify(question.instructions);
      if (key.startsWith("candidate_0_")) expect(serialized).toContain("candidates[0]");
      if (key.startsWith("candidate_1_")) expect(serialized).toContain("candidates[1]");
    }
  });

  it("omits undefined values from provider state", () => {
    const plan = buildQuestionPlan(minimalRequest);
    expect(JSON.stringify(plan.state)).not.toContain("undefined");
  });

  it("includes the implementation budget in provider state", () => {
    const plan = buildQuestionPlan(minimalRequest);
    expect(plan.state).toMatchObject({
      budget: minimalRequest.budget,
    });
  });

  it("can canonicalize live candidate order without losing original IDs", () => {
    const request = structuredClone(minimalRequest);
    request.candidates.reverse();
    const plan = buildQuestionPlan(request, { canonicalize: true });

    expect(plan.candidateOrder).toEqual([1, 0]);
    expect((plan.state as { candidates: Array<{ id: string }> }).candidates.map(({ id }) => id))
      .toEqual(["allocation-cut", "byte-fast-path"]);
  });
});
