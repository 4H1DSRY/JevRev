import {
  noul,
  score,
  type EntryType,
  type Question,
  type Questions,
} from "@typesafe-ai/sdk";
import type { RankRequest } from "./domain/schemas.js";

export const SIGNALS = [
  "goal_fit",
  "constraint_fit",
  "feasibility",
  "validation_quality",
  "execution_value",
] as const;

export type SignalName = (typeof SIGNALS)[number];

export interface QuestionPlan {
  state: EntryType;
  questions: Questions;
  expectedTypes: Readonly<Record<string, Question["type"]>>;
  /** Canonical candidate index -> original request index. */
  candidateOrder: readonly number[];
}

const GOAL_RUBRIC = [
  "The mechanism does not materially address the goal or success criteria.",
  "The mechanism addresses only a small part of the goal and is unlikely to reach the success criteria.",
  "The mechanism could make a material contribution, but reaching the success criteria remains uncertain.",
  "The mechanism is directly connected to the goal and is plausibly capable of reaching the success criteria.",
] as const;

const FEASIBILITY_RUBRIC = [
  "The mechanism is internally flawed or incompatible with the supplied context.",
  "The mechanism depends on major unresolved technical assumptions.",
  "The mechanism is plausible, with manageable unknowns.",
  "The mechanism is technically credible, bounded, and ready to prototype.",
] as const;

const VALIDATION_RUBRIC = [
  "The validation plan cannot show whether the mechanism caused the desired result.",
  "The validation plan provides weak or indirect evidence.",
  "The validation plan can test the main claim with some ambiguity.",
  "The validation plan can cheaply falsify the main claim and detect regressions.",
] as const;

export function candidateQuestionKey(index: number, signal: SignalName): string {
  return `candidate_${index}_${signal}`;
}

export function duplicateQuestionKey(leftIndex: number, rightIndex: number): string {
  return `pair_${leftIndex}_${rightIndex}_duplicate`;
}

export function buildQuestionPlan(
  request: RankRequest,
  options: { canonicalize?: boolean } = {},
): QuestionPlan {
  const questions: Record<string, Question> = {};
  const expectedTypes: Record<string, Question["type"]> = {};
  const candidateOrder = (options.canonicalize ?? false)
    ? request.candidates
        .map((candidate, index) => ({ id: candidate.id, index }))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ index }) => index)
    : request.candidates.map((_candidate, index) => index);
  const candidates = candidateOrder.map((index) => request.candidates[index]!);

  const add = (key: string, question: Question): void => {
    questions[key] = question;
    expectedTypes[key] = question.type;
  };

  candidates.forEach((_candidate, index) => {
    const path = `candidates[${index}]`;

    add(
      candidateQuestionKey(index, "goal_fit"),
      score(
        `How strongly is ${path}'s stated mechanism expected to achieve task.goal and task.success? Judge the mechanism, not the quality of its prose.`,
        GOAL_RUBRIC,
      ),
    );

    add(
      candidateQuestionKey(index, "constraint_fit"),
      noul(
        request.task.constraints.some((constraint) => constraint.kind === "hard")
          ? `Is ${path} likely to satisfy every constraint in task.constraints whose kind is \"hard\"? Answer yes only when all hard constraints are likely satisfied.`
          : `There are no hard constraints in task.constraints. Is ${path} therefore free of a hard-constraint violation?`,
        {
          true: "All hard constraints are likely satisfied, or none exist.",
          false: "At least one hard constraint is likely violated.",
        },
      ),
    );

    add(
      candidateQuestionKey(index, "feasibility"),
      score(
        `How technically feasible is the specific mechanism in ${path}, given task.context, its assumptions, and its risks?`,
        FEASIBILITY_RUBRIC,
      ),
    );

    add(
      candidateQuestionKey(index, "validation_quality"),
      score(
        `How well could ${path}.validation establish whether ${path}.mechanism achieved task.success without unacceptable regressions?`,
        VALIDATION_RUBRIC,
      ),
    );

    add(
      candidateQuestionKey(index, "execution_value"),
      noul(
        `Considering task.goal, task.success, all candidates, and the limited budget, is ${path} worth spending one implementation slot on?`,
        {
          true: "The expected information or outcome is worth an implementation slot.",
          false: "The candidate should be pruned before implementation.",
        },
      ),
    );
  });

  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const key = duplicateQuestionKey(left, right);
      add(
        key,
        noul(
          `Are candidates[${left}] and candidates[${right}] materially the same implementation mechanism, such that implementing both would provide little additional evidence or solution diversity?`,
          {
            true: "They are materially duplicative despite possible wording differences.",
            false: "They test meaningfully different mechanisms or tradeoffs.",
          },
        ),
      );
    }
  }

  const taskState = {
    goal: request.task.goal,
    ...(request.task.context === undefined ? {} : { context: request.task.context }),
    constraints: request.task.constraints,
    success: request.task.success,
  };

  return {
    state: {
      task: taskState,
      budget: request.budget,
      candidates,
    },
    questions,
    expectedTypes,
    candidateOrder,
  };
}
