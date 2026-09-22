import { createHash } from "node:crypto";
import { ProtocolError } from "./domain/errors.js";
import {
  rankResultSchema,
  type DecisionReason,
  type JudgeAnswer,
  type JudgeResponse,
  type EmptyReason,
  type NextAction,
  type RankRequest,
  type RankResult,
} from "./domain/schemas.js";
import {
  candidateQuestionKey,
  duplicateQuestionKey,
  type SignalName,
} from "./questions.js";

export const DEFAULT_POLICY = {
  name: "default-v1" as const,
  thresholds: {
    goal_fit: 0.34,
    constraint_fit: 0.55,
    feasibility: 0.34,
    validation_quality: 0.25,
    execution_value: 0.45,
    confidence: 0.2,
    duplicate: 0.75,
    duplicate_confidence: 0.3,
  },
  weights: {
    goal_fit: 0.3,
    constraint_fit: 0.2,
    feasibility: 0.2,
    validation_quality: 0.1,
    execution_value: 0.2,
  },
  effort_multipliers: {
    small: 1,
    medium: 0.94,
    large: 0.86,
  },
} as const;

interface NormalizedSignal {
  value: number;
  confidence: number;
}

interface WorkingDecision {
  candidate_id: string;
  title: string;
  inputIndex: number;
  status: "eligible" | "keep" | "review" | "reject";
  rank: number;
  score: number;
  confidence: number;
  signals: Record<SignalName, number>;
  reasons: DecisionReason[];
}

export interface RankOptions {
  /** Provider/model calibration profile recorded in the handoff. */
  providerProfile?: string;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

function requireAnswer(
  response: JudgeResponse,
  key: string,
  expectedType: JudgeAnswer["type"],
): JudgeAnswer {
  const answer = response.answers[key];
  if (answer === undefined) {
    throw new ProtocolError(`Missing judge answer: ${key}`);
  }
  if (answer.type !== expectedType) {
    throw new ProtocolError(
      `Judge answer ${key} has type ${answer.type}; expected ${expectedType}`,
    );
  }
  return answer;
}

function normalizeNoul(answer: JudgeAnswer): NormalizedSignal {
  if (answer.type !== "noul") {
    throw new ProtocolError("Expected a Noul answer");
  }
  return {
    value: answer.noul,
    confidence: Math.round(Math.abs(answer.noul - 0.5) * 2 * 1e12) / 1e12,
  };
}

function normalizeScore(answer: JudgeAnswer): NormalizedSignal {
  if (answer.type !== "score") {
    throw new ProtocolError("Expected a Score answer");
  }
  if (answer.score > 3) {
    throw new ProtocolError(`Expected a four-level score, received ${answer.score}`);
  }
  return {
    value: answer.score / 3,
    confidence: answer.confidence,
  };
}

function getSignal(
  response: JudgeResponse,
  index: number,
  signal: SignalName,
): NormalizedSignal {
  const key = candidateQuestionKey(index, signal);
  const isNoul = signal === "constraint_fit" || signal === "execution_value";
  return isNoul
    ? normalizeNoul(requireAnswer(response, key, "noul"))
    : normalizeScore(requireAnswer(response, key, "score"));
}

function initialDecision(
  request: RankRequest,
  response: JudgeResponse,
  canonicalIndex: number,
  originalIndex: number,
): WorkingDecision {
  const candidate = request.candidates[originalIndex];
  if (candidate === undefined) {
    throw new ProtocolError(`Missing candidate at index ${originalIndex}`);
  }

  const normalized = {
    goal_fit: getSignal(response, canonicalIndex, "goal_fit"),
    constraint_fit: getSignal(response, canonicalIndex, "constraint_fit"),
    feasibility: getSignal(response, canonicalIndex, "feasibility"),
    validation_quality: getSignal(response, canonicalIndex, "validation_quality"),
    execution_value: getSignal(response, canonicalIndex, "execution_value"),
  };

  const signals = {
    goal_fit: normalized.goal_fit.value,
    constraint_fit: normalized.constraint_fit.value,
    feasibility: normalized.feasibility.value,
    validation_quality: normalized.validation_quality.value,
    execution_value: normalized.execution_value.value,
  };
  const confidence = Math.min(
    ...Object.values(normalized).map((signal) => signal.confidence),
  );
  const weighted =
    signals.goal_fit * DEFAULT_POLICY.weights.goal_fit +
    signals.constraint_fit * DEFAULT_POLICY.weights.constraint_fit +
    signals.feasibility * DEFAULT_POLICY.weights.feasibility +
    signals.validation_quality * DEFAULT_POLICY.weights.validation_quality +
    signals.execution_value * DEFAULT_POLICY.weights.execution_value;
  const score = weighted * DEFAULT_POLICY.effort_multipliers[candidate.effort];

  const reasons: DecisionReason[] = [];
  let status: WorkingDecision["status"] = "eligible";

  // Hard constraints are checked before confidence. A low-confidence answer
  // can still expose a constraint violation; routing that card to review would
  // hide the actionable failure and make the review queue unsafe to treat as
  // unresolved-but-viable. The other semantic gates retain the original
  // confidence-first behavior: uncertainty routes to review rather than
  // becoming a rejection.
  if (signals.constraint_fit < DEFAULT_POLICY.thresholds.constraint_fit) {
    reasons.push({ code: "CONSTRAINT_RISK" });
    status = "reject";
    if (confidence < DEFAULT_POLICY.thresholds.confidence) {
      reasons.push({ code: "LOW_CONFIDENCE" });
    }
  } else if (confidence < DEFAULT_POLICY.thresholds.confidence) {
    status = "review";
    reasons.push({ code: "LOW_CONFIDENCE" });
  } else {
    if (signals.goal_fit < DEFAULT_POLICY.thresholds.goal_fit) {
      reasons.push({ code: "GOAL_MISMATCH" });
    }
    if (signals.feasibility < DEFAULT_POLICY.thresholds.feasibility) {
      reasons.push({ code: "LOW_FEASIBILITY" });
    }
    if (signals.validation_quality < DEFAULT_POLICY.thresholds.validation_quality) {
      reasons.push({ code: "WEAK_VALIDATION" });
    }
    if (signals.execution_value < DEFAULT_POLICY.thresholds.execution_value) {
      reasons.push({ code: "LOW_EXECUTION_VALUE" });
    }
    if (reasons.length > 0) {
      status = "reject";
    }
  }

  return {
    candidate_id: candidate.id,
    title: candidate.title,
    inputIndex: originalIndex,
    status,
    rank: 0,
    score,
    confidence,
    signals,
    reasons,
  };
}

interface OutcomeMetadata {
  next_action: NextAction;
  empty_reason: EmptyReason;
}

function outcomeMetadata(
  selected: readonly string[],
  decisions: readonly Pick<WorkingDecision, "status" | "reasons">[],
): OutcomeMetadata {
  if (selected.length > 0) {
    return { next_action: "implement", empty_reason: "none" };
  }

  const allReview = decisions.every((decision) => decision.status === "review");
  if (allReview) {
    return { next_action: "ask_human", empty_reason: "all_review" };
  }

  const allRejected = decisions.every((decision) => decision.status === "reject");
  if (allRejected) {
    const allHardConstraintRisk = decisions.every((decision) =>
      decision.reasons.some((reason) => reason.code === "CONSTRAINT_RISK"),
    );
    if (allHardConstraintRisk) {
      return {
        next_action: "relax_constraints",
        empty_reason: "all_rejected",
      };
    }
    const allBudgetCutoff = decisions.every((decision) =>
      decision.reasons.some((reason) => reason.code === "BUDGET_CUTOFF"),
    );
    if (allBudgetCutoff) {
      return { next_action: "ask_human", empty_reason: "budget_exhausted" };
    }
    return { next_action: "revise_candidates", empty_reason: "all_rejected" };
  }

  return { next_action: "ask_human", empty_reason: "mixed_no_survivor" };
}

function duplicateProbability(
  response: JudgeResponse,
  leftIndex: number,
  rightIndex: number,
): NormalizedSignal {
  const left = Math.min(leftIndex, rightIndex);
  const right = Math.max(leftIndex, rightIndex);
  return normalizeNoul(
    requireAnswer(response, duplicateQuestionKey(left, right), "noul"),
  );
}

export function rankCandidates(
  request: RankRequest,
  response: JudgeResponse,
  candidateOrder: readonly number[] = request.candidates.map((_candidate, index) => index),
  options: RankOptions = {},
): RankResult {
  if (candidateOrder.length !== request.candidates.length) {
    throw new ProtocolError("Candidate order does not match request length");
  }
  const expectedIndexes = request.candidates.map((_candidate, index) => index);
  if ([...candidateOrder].sort((left, right) => left - right).some((value, index) => value !== expectedIndexes[index])) {
    throw new ProtocolError("Candidate order must be a permutation of request indexes");
  }
  const decisions = candidateOrder.map((originalIndex, canonicalIndex) =>
    initialDecision(request, response, canonicalIndex, originalIndex),
  );

  const ranked = [...decisions].sort(
    (left, right) => right.score - left.score || left.inputIndex - right.inputIndex,
  );
  ranked.forEach((decision, index) => {
    decision.rank = index + 1;
  });

  const kept: WorkingDecision[] = [];
  for (const decision of ranked) {
    if (decision.status !== "eligible") {
      continue;
    }

    const duplicate = kept.find((survivor) => {
      const leftCanonicalIndex = candidateOrder.indexOf(decision.inputIndex);
      const survivorCanonicalIndex = candidateOrder.indexOf(survivor.inputIndex);
      const signal = duplicateProbability(
        response,
        leftCanonicalIndex,
        survivorCanonicalIndex,
      );
      return (
        signal.value >= DEFAULT_POLICY.thresholds.duplicate &&
        signal.confidence >= DEFAULT_POLICY.thresholds.duplicate_confidence
      );
    });

    if (duplicate !== undefined) {
      decision.status = "reject";
      decision.reasons.push({
        code: "DUPLICATE_CANDIDATE",
        related_candidate_id: duplicate.candidate_id,
      });
      continue;
    }

    if (kept.length >= request.budget.max_survivors) {
      decision.status = "reject";
      decision.reasons.push({ code: "BUDGET_CUTOFF" });
      continue;
    }

    decision.status = "keep";
    kept.push(decision);
  }

  const publicDecisions = ranked.map(({ inputIndex: _inputIndex, status, ...decision }) => ({
    ...decision,
    status: status === "eligible" ? ("reject" as const) : status,
    score: round(decision.score),
    confidence: round(decision.confidence),
    signals: Object.fromEntries(
      Object.entries(decision.signals).map(([key, value]) => [key, round(value)]),
    ) as WorkingDecision["signals"],
  }));

  // A review item is not silently approved, but it is useful to return the
  // best unresolved option when the strict keep set has spare budget. This is
  // the handoff queue for a host agent or human; `selected` remains the safe
  // implementation set.
  const shortlist = ranked
    .filter((decision) => decision.status === "keep" || decision.status === "review")
    .slice(0, request.budget.max_survivors)
    .map((decision) => decision.candidate_id);

  const selected = kept.map((decision) => decision.candidate_id);
  const outcome = outcomeMetadata(selected, publicDecisions);

  const result = {
    version: "1" as const,
    run_id: `jvr_${createHash("sha256")
      .update(JSON.stringify({ request, model: response.model, answers: response.answers }))
      .digest("hex")
      .slice(0, 12)}`,
    model: response.model,
    policy: {
      name: DEFAULT_POLICY.name,
      provider_profile: options.providerProfile ?? "library",
      max_survivors: request.budget.max_survivors,
      thresholds: { ...DEFAULT_POLICY.thresholds },
      weights: { ...DEFAULT_POLICY.weights },
      effort_multipliers: { ...DEFAULT_POLICY.effort_multipliers },
    },
    summary: {
      evaluated: publicDecisions.length,
      kept: publicDecisions.filter((decision) => decision.status === "keep").length,
      shortlisted: shortlist.length,
      review: publicDecisions.filter((decision) => decision.status === "review").length,
      rejected: publicDecisions.filter((decision) => decision.status === "reject").length,
    },
    next_action: outcome.next_action,
    empty_reason: outcome.empty_reason,
    selected,
    shortlist,
    decisions: publicDecisions,
    usage: response.usage,
  };

  return rankResultSchema.parse(result);
}
