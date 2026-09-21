import type { QuestionPlan } from "../src/questions.js";
import type { JudgeResponse, RankRequest } from "../src/domain/schemas.js";

export const minimalRequest: RankRequest = {
  version: "1",
  task: {
    goal: "Make a parser faster",
    constraints: [{ id: "api", text: "Keep the public API", kind: "hard" }],
    success: [{ id: "speed", text: "Throughput improves by at least 2x" }],
  },
  budget: { max_survivors: 1 },
  candidates: [
    {
      id: "allocation-cut",
      title: "Reduce allocations",
      summary: "Reuse temporary buffers.",
      mechanism: "Pool bounded temporary arrays on the hot path.",
      assumptions: ["Allocation is a measured hotspot"],
      risks: ["Pool state could leak across parses"],
      validation: ["Run tests and allocation benchmark"],
      effort: "small",
    },
    {
      id: "byte-fast-path",
      title: "Byte fast path",
      summary: "Bypass token objects for common input.",
      mechanism: "Parse ASCII tokens directly from the input buffer.",
      assumptions: ["ASCII input dominates"],
      risks: ["Fast and slow paths could diverge"],
      validation: ["Differential tests and throughput benchmark"],
      effort: "medium",
    },
  ],
};

export interface CandidateSignalFixture {
  goal?: number;
  goalConfidence?: number;
  constraint?: number;
  feasibility?: number;
  feasibilityConfidence?: number;
  validation?: number;
  validationConfidence?: number;
  value?: number;
}

function scoreAnswer(score: number, confidence = 0.9) {
  return {
    type: "score" as const,
    score,
    confidence,
    legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" },
    probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 },
  };
}

export function makeResponse(
  plan: QuestionPlan,
  signals: CandidateSignalFixture[] = [],
  duplicateProbabilities: Record<string, number> = {},
): JudgeResponse {
  const answers: JudgeResponse["answers"] = {};

  for (const [key, type] of Object.entries(plan.expectedTypes)) {
    const candidateMatch = /^candidate_(\d+)_(.+)$/.exec(key);
    if (candidateMatch !== null) {
      const index = Number(candidateMatch[1]);
      const signal = candidateMatch[2];
      const fixture = signals[index] ?? {};
      if (type === "noul") {
        const noul = signal === "constraint_fit" ? fixture.constraint ?? 0.9 : fixture.value ?? 0.8;
        answers[key] = { type: "noul", noul };
      } else if (signal === "goal_fit") {
        answers[key] = scoreAnswer(fixture.goal ?? 2.5, fixture.goalConfidence);
      } else if (signal === "feasibility") {
        answers[key] = scoreAnswer(
          fixture.feasibility ?? 2.5,
          fixture.feasibilityConfidence,
        );
      } else {
        answers[key] = scoreAnswer(
          fixture.validation ?? 2.5,
          fixture.validationConfidence,
        );
      }
      continue;
    }

    const pairMatch = /^pair_(\d+)_(\d+)_duplicate$/.exec(key);
    if (pairMatch !== null) {
      answers[key] = {
        type: "noul",
        noul: duplicateProbabilities[`${pairMatch[1]}-${pairMatch[2]}`] ?? 0.05,
      };
      continue;
    }

    throw new Error(`Unhandled question key ${key}`);
  }

  return {
    model: "jev-test",
    answers,
    usage: { input_tokens: 100, output_tokens: Object.keys(answers).length * 4 },
  };
}
