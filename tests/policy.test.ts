import { describe, expect, it } from "vitest";
import { rankCandidates } from "../src/policy.js";
import { buildQuestionPlan } from "../src/questions.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

describe("rankCandidates", () => {
  it("keeps only the best eligible candidate within budget", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan, [
      { goal: 2, feasibility: 2, validation: 2, constraint: 0.8, value: 0.7 },
      { goal: 3, feasibility: 3, validation: 3, constraint: 0.9, value: 0.9 },
    ]);

    const result = rankCandidates(minimalRequest, response);

    expect(result.selected).toEqual(["byte-fast-path"]);
    expect(result.decisions.find((item) => item.candidate_id === "allocation-cut")?.reasons)
      .toContainEqual({ code: "BUDGET_CUTOFF" });
  });

  it("hard-rejects constraint risk even when every other signal is strong", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan, [
      { goal: 3, feasibility: 3, validation: 3, constraint: 0.1, value: 0.95 },
      { goal: 2, feasibility: 2, validation: 2, constraint: 0.9, value: 0.8 },
    ]);

    const result = rankCandidates(minimalRequest, response);
    const rejected = result.decisions.find((item) => item.candidate_id === "allocation-cut");

    expect(rejected?.status).toBe("reject");
    expect(rejected?.reasons).toContainEqual({ code: "CONSTRAINT_RISK" });
  });

  it("routes low-confidence semantic scores to review", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    const plan = buildQuestionPlan(request);
    const response = makeResponse(plan, [
      { goal: 2, goalConfidence: 0.1, constraint: 0.9, value: 0.9 },
      { goal: 2.5, constraint: 0.9, value: 0.9 },
    ]);

    const result = rankCandidates(request, response);
    const uncertain = result.decisions.find((item) => item.candidate_id === "allocation-cut");

    expect(uncertain?.status).toBe("review");
    expect(uncertain?.reasons).toEqual([{ code: "LOW_CONFIDENCE" }]);
    expect(result.selected).toEqual(["byte-fast-path"]);
    expect(result.shortlist).toEqual(["allocation-cut", "byte-fast-path"]);
  });

  it("rejects a low-confidence candidate when it also fails a policy gate", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    const plan = buildQuestionPlan(request);
    const response = makeResponse(plan, [
      {
        goal: 2,
        goalConfidence: 0.1,
        constraint: 0.1,
        value: 0.9,
      },
      { goal: 3, constraint: 0.9, value: 0.9 },
    ]);

    const result = rankCandidates(request, response);
    const rejected = result.decisions.find((item) => item.candidate_id === "allocation-cut");

    expect(rejected?.status).toBe("reject");
    expect(rejected?.reasons).toEqual(
      expect.arrayContaining([
        { code: "CONSTRAINT_RISK" },
        { code: "LOW_CONFIDENCE" },
      ]),
    );
  });

  it("keeps non-constraint failures in review while confidence is low", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    const plan = buildQuestionPlan(request);
    const response = makeResponse(plan, [
      {
        goal: 0,
        goalConfidence: 0.1,
        constraint: 0.9,
        value: 0.9,
      },
      { goal: 3, constraint: 0.9, value: 0.9 },
    ]);

    const result = rankCandidates(request, response);
    const uncertain = result.decisions.find((item) => item.candidate_id === "allocation-cut");

    expect(uncertain?.status).toBe("review");
    expect(uncertain?.reasons).toEqual([{ code: "LOW_CONFIDENCE" }]);
  });

  it("does not route an exact confidence-threshold Noul to review", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan, [
      { goal: 2.5, constraint: 0.6, feasibility: 2.5, validation: 2.5, value: 0.9 },
      { goal: 2, constraint: 0.9, feasibility: 2, validation: 2, value: 0.8 },
    ]);

    const result = rankCandidates(minimalRequest, response);
    const boundary = result.decisions.find((item) => item.candidate_id === "allocation-cut");

    expect(boundary?.confidence).toBe(0.2);
    expect(boundary?.status).not.toBe("review");
  });

  it("deduplicates a lower-scored version of a survivor", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    const plan = buildQuestionPlan(request);
    const response = makeResponse(
      plan,
      [
        { goal: 3, feasibility: 3, validation: 3, constraint: 0.9, value: 0.9 },
        { goal: 2.8, feasibility: 2.8, validation: 2.8, constraint: 0.9, value: 0.9 },
      ],
      { "0-1": 0.92 },
    );

    const result = rankCandidates(request, response);
    const duplicate = result.decisions.find((item) => item.candidate_id === "byte-fast-path");

    expect(result.selected).toEqual(["allocation-cut"]);
    expect(duplicate?.reasons).toContainEqual({
      code: "DUPLICATE_CANDIDATE",
      related_candidate_id: "allocation-cut",
    });
  });

  it("does not collapse candidates when duplicate probability is weak", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    const plan = buildQuestionPlan(request);
    const response = makeResponse(plan, [], { "0-1": 0.2 });

    const result = rankCandidates(request, response);

    expect(result.selected).toHaveLength(2);
    expect(result.decisions.flatMap((item) => item.reasons)).not.toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_CANDIDATE" }),
    );
  });

  it("uses effort only as a deterministic multiplier", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    request.candidates[0]!.effort = "large";
    request.candidates[1]!.effort = "small";
    const plan = buildQuestionPlan(request);
    const response = makeResponse(plan);

    const result = rankCandidates(request, response);

    expect(result.decisions[0]?.candidate_id).toBe("byte-fast-path");
    expect(result.decisions[0]!.score).toBeGreaterThan(result.decisions[1]!.score);
  });

  it("breaks equal scores by original candidate order", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    request.candidates[0]!.effort = "small";
    request.candidates[1]!.effort = "small";
    const plan = buildQuestionPlan(request);
    const response = makeResponse(plan);

    const result = rankCandidates(request, response);

    expect(result.decisions.map((item) => item.candidate_id)).toEqual([
      "allocation-cut",
      "byte-fast-path",
    ]);
  });

  it("maps a canonical provider order back to the original request", () => {
    const request = structuredClone(minimalRequest);
    request.candidates.reverse();
    const plan = buildQuestionPlan(request, { canonicalize: true });
    const response = makeResponse(plan, [
      { goal: 3, feasibility: 3, validation: 3, constraint: 0.9, value: 0.9 },
      { goal: 2, feasibility: 2, validation: 2, constraint: 0.9, value: 0.8 },
    ]);

    const result = rankCandidates(request, response, plan.candidateOrder);

    expect(result.selected).toEqual(["allocation-cut"]);
    expect(result.decisions[0]?.candidate_id).toBe("allocation-cut");
  });

  it("returns a valid empty selection when every candidate fails", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan, [
      { goal: 0, constraint: 0.1, feasibility: 0, value: 0.1 },
      { goal: 0, constraint: 0.1, feasibility: 0, value: 0.1 },
    ]);

    const result = rankCandidates(minimalRequest, response);

    expect(result.selected).toEqual([]);
    expect(result.summary.rejected).toBe(2);
    expect(result.next_action).toBe("relax_constraints");
    expect(result.empty_reason).toBe("all_rejected");
  });

  it("rejects a duplicated or out-of-range provider order", () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);
    expect(() => rankCandidates(minimalRequest, response, [0, 0])).toThrow("permutation");
    expect(() => rankCandidates(minimalRequest, response, [0, 2])).toThrow("permutation");
  });

  it("marks an empty all-review result for human review", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    const plan = buildQuestionPlan(request);
    const response = makeResponse(plan, [
      { goal: 2.5, goalConfidence: 0.1, constraint: 0.9, value: 0.9 },
      { goal: 2.5, goalConfidence: 0.1, constraint: 0.9, value: 0.9 },
    ]);

    const result = rankCandidates(request, response);

    expect(result.selected).toEqual([]);
    expect(result.summary.review).toBe(2);
    expect(result.next_action).toBe("ask_human");
    expect(result.empty_reason).toBe("all_review");
  });
});
