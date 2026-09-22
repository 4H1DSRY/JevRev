import type { JudgeAnswer, JudgeResponse } from "../domain/schemas.js";
import { ProtocolError } from "../domain/errors.js";
import {
  complementarityQuestionKey,
  finalistQuestionKey,
  type DecideSignal,
} from "./decide-questions.js";
import { workflowDigest, type PreparedDecision, type PreparedEvaluation } from "./evidence.js";
import { decideResultSchema, type DecideReasonCode, type DecideResult } from "./schemas.js";

const POLICY = {
  support: 0.5,
  reproducibility: 0.5,
  risk: 0.55,
  shipping: 0.55,
  confidence: 0.2,
  complementarity: 0.75,
  winner_margin: 0.08,
  merge_margin: 0.12,
  weights: { support: 0.35, reproducibility: 0.25, risk: 0.2, shipping: 0.2 },
} as const;

function answer(response: JudgeResponse, key: string, type: JudgeAnswer["type"]): JudgeAnswer {
  const value = response.answers[key];
  if (value === undefined || value.type !== type) {
    throw new ProtocolError(`Missing or invalid decide answer: ${key}`);
  }
  return value;
}

function signal(response: JudgeResponse, index: number, name: DecideSignal): { value: number; confidence: number } {
  const type = name === "evidence_support" || name === "reproducibility" ? "score" : "noul";
  const value = answer(response, finalistQuestionKey(index, name), type);
  return value.type === "score"
    ? { value: value.score / 3, confidence: value.confidence }
    : { value: value.noul, confidence: Math.abs(value.noul - 0.5) * 2 };
}

function complementarity(response: JudgeResponse, left: number, right: number): number {
  const value = answer(response, complementarityQuestionKey(left, right), "noul");
  if (value.type !== "noul") throw new ProtocolError("Expected complementarity Noul answer");
  return value.noul;
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

interface SemanticEvaluation {
  candidate_id: string;
  status: "eligible" | "rejected" | "review";
  score: number;
  confidence: number;
  reasons: DecideReasonCode[];
  semantic: {
    evidence_support: number;
    reproducibility: number;
    residual_risk_acceptance: number;
    shipping_value: number;
  };
}

function semanticEvaluation(
  response: JudgeResponse,
  canonicalIndex: number,
  candidateId: string,
): SemanticEvaluation {
  const support = signal(response, canonicalIndex, "evidence_support");
  const reproducibility = signal(response, canonicalIndex, "reproducibility");
  const risk = signal(response, canonicalIndex, "residual_risk_acceptance");
  const shipping = signal(response, canonicalIndex, "shipping_value");
  const confidence = Math.min(support.confidence, reproducibility.confidence, risk.confidence, shipping.confidence);
  const semantic = {
    evidence_support: support.value,
    reproducibility: reproducibility.value,
    residual_risk_acceptance: risk.value,
    shipping_value: shipping.value,
  };
  const score = support.value * POLICY.weights.support +
    reproducibility.value * POLICY.weights.reproducibility +
    risk.value * POLICY.weights.risk + shipping.value * POLICY.weights.shipping;
  const reasons: DecideReasonCode[] = [];
  let status: SemanticEvaluation["status"] = "eligible";
  if (confidence < POLICY.confidence) {
    status = "review";
    reasons.push("LOW_CONFIDENCE");
  } else {
    if (support.value < POLICY.support) reasons.push("LOW_EVIDENCE_SUPPORT");
    if (reproducibility.value < POLICY.reproducibility) reasons.push("LOW_REPRODUCIBILITY");
    if (risk.value < POLICY.risk) reasons.push("HIGH_RESIDUAL_RISK");
    if (shipping.value < POLICY.shipping) reasons.push("LOW_SHIPPING_VALUE");
    if (reasons.length > 0) status = "rejected";
  }
  return { candidate_id: candidateId, status, score, confidence, reasons, semantic };
}

export interface DecideOptions {
  providerProfile?: string;
}

function baseEvaluation(evaluation: PreparedEvaluation) {
  return {
    candidate_id: evaluation.candidate_id,
    status: evaluation.status === "viable" ? "eligible" as const : evaluation.status,
    score: null,
    confidence: null,
    reasons: evaluation.reasons,
    objective: evaluation.objective,
    semantic: null,
  };
}

function objectiveKey(metric: PreparedEvaluation["objective"]["metrics"][number]): string {
  return `${metric.criterion_id}\0${metric.unit}\0${metric.direction}`;
}

function objectivelyDominates(
  leftId: string,
  rightId: string,
  prepared: PreparedDecision,
): boolean {
  const left = prepared.evaluations.find((item) => item.candidate_id === leftId);
  const right = prepared.evaluations.find((item) => item.candidate_id === rightId);
  if (left?.packet === undefined || right?.packet === undefined) return false;
  const leftMetrics = new Map(left.objective.metrics.map((metric) => [objectiveKey(metric), metric]));
  const rightMetrics = new Map(right.objective.metrics.map((metric) => [objectiveKey(metric), metric]));
  const keys = [...leftMetrics.keys()].sort();
  if (
    keys.length === 0 ||
    keys.length !== rightMetrics.size ||
    keys.some((key) => !rightMetrics.has(key))
  ) return false;

  let strictlyBetter = false;
  for (const key of keys) {
    const leftValue = leftMetrics.get(key)?.relative_improvement;
    const rightValue = rightMetrics.get(key)?.relative_improvement;
    if (leftValue === null || leftValue === undefined || rightValue === null || rightValue === undefined) {
      return false;
    }
    if (leftValue < rightValue) return false;
    if (leftValue > rightValue) strictlyBetter = true;
  }

  const lowerIsBetter: Array<[number | undefined, number | undefined]> = [
    [left.packet.development.wall_ms, right.packet.development.wall_ms],
    [left.packet.changed_files.length, right.packet.changed_files.length],
    [left.packet.development.tokens, right.packet.development.tokens],
    [left.packet.development.cost_usd, right.packet.development.cost_usd],
  ];
  for (const [leftValue, rightValue] of lowerIsBetter) {
    if (leftValue === undefined || rightValue === undefined) continue;
    if (leftValue > rightValue) return false;
    if (leftValue < rightValue) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function decideCampaign(
  prepared: PreparedDecision,
  response: JudgeResponse | undefined,
  candidateOrder: readonly number[] = prepared.viable.map((_candidate, index) => index),
  options: DecideOptions = {},
): DecideResult {
  if (prepared.viable.length > 0 && response === undefined) {
    throw new ProtocolError("A judge response is required for viable finalists");
  }
  if (candidateOrder.length !== prepared.viable.length) {
    throw new ProtocolError("Decide candidate order does not match viable finalists");
  }
  const expectedIndexes = prepared.viable.map((_evaluation, index) => index);
  if ([...candidateOrder].sort((left, right) => left - right).some((value, index) => value !== expectedIndexes[index])) {
    throw new ProtocolError("Decide candidate order must be a permutation of viable finalist indexes");
  }

  const semantic = new Map<string, SemanticEvaluation>();
  if (response !== undefined) {
    candidateOrder.forEach((originalIndex, canonicalIndex) => {
      const evaluation = prepared.viable[originalIndex];
      if (evaluation === undefined) throw new ProtocolError("Decide candidate order is invalid");
      semantic.set(
        evaluation.candidate_id,
        semanticEvaluation(response, canonicalIndex, evaluation.candidate_id),
      );
    });
  }

  const evaluations = prepared.evaluations.map((evaluation) => {
    const judged = semantic.get(evaluation.candidate_id);
    return judged === undefined
      ? baseEvaluation(evaluation)
      : {
          candidate_id: evaluation.candidate_id,
          status: judged.status,
          score: round(judged.score),
          confidence: round(judged.confidence),
          reasons: judged.reasons,
          objective: evaluation.objective,
          semantic: Object.fromEntries(
            Object.entries(judged.semantic).map(([key, value]) => [key, round(value)]),
          ) as SemanticEvaluation["semantic"],
        };
  });

  const incomplete = evaluations.filter((evaluation) => evaluation.status === "incomplete");
  const initiallyAccepted = evaluations
    .filter((evaluation) => evaluation.status === "eligible")
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const reviews = evaluations.filter((evaluation) => evaluation.status === "review");
  const dominated = new Set<string>();
  for (const candidate of initiallyAccepted) {
    if (
      initiallyAccepted.some((other) =>
        other.candidate_id !== candidate.candidate_id &&
        objectivelyDominates(other.candidate_id, candidate.candidate_id, prepared)
      )
    ) {
      dominated.add(candidate.candidate_id);
      candidate.status = "rejected";
      candidate.reasons.push("OBJECTIVELY_DOMINATED");
    }
  }
  const accepted = initiallyAccepted.filter(
    (evaluation) => !dominated.has(evaluation.candidate_id),
  );

  let decision: DecideResult["decision"];
  let winner: string | null = null;
  let mergeCandidates: string[] = [];
  let nextAction: DecideResult["next_action"];

  if (incomplete.length > 0) {
    decision = "probe_more";
    nextAction = { type: "collect_evidence", candidate_ids: incomplete.map((item) => item.candidate_id) };
  } else if (reviews.length > 0) {
    decision = "human_review";
    nextAction = {
      type: "ask_human",
      candidate_ids: [
        ...accepted.slice(0, 1).map((item) => item.candidate_id),
        ...reviews.map((item) => item.candidate_id),
      ],
    };
  } else if (accepted.length === 0) {
    decision = "no_winner";
    nextAction = { type: "revise_ideas", candidate_ids: [] };
  } else if (accepted.length === 1) {
    decision = "winner";
    winner = accepted[0]!.candidate_id;
    nextAction = { type: "integrate_winner", candidate_ids: [winner] };
  } else {
    const first = accepted[0]!;
    const second = accepted[1]!;
    const firstOriginal = prepared.viable.findIndex((item) => item.candidate_id === first.candidate_id);
    const secondOriginal = prepared.viable.findIndex((item) => item.candidate_id === second.candidate_id);
    const firstCanonical = candidateOrder.indexOf(firstOriginal);
    const secondCanonical = candidateOrder.indexOf(secondOriginal);
    const pairValue = response === undefined
      ? 0
      : complementarity(response, Math.min(firstCanonical, secondCanonical), Math.max(firstCanonical, secondCanonical));
    const gap = (first.score ?? 0) - (second.score ?? 0);
    if (pairValue >= POLICY.complementarity && gap <= POLICY.merge_margin) {
      decision = "merge";
      mergeCandidates = [first.candidate_id, second.candidate_id];
      nextAction = { type: "probe_combination", candidate_ids: mergeCandidates };
    } else if (gap < POLICY.winner_margin) {
      decision = "probe_more";
      first.reasons.push("CLOSE_RESULT");
      second.reasons.push("CLOSE_RESULT");
      nextAction = { type: "collect_evidence", candidate_ids: [first.candidate_id, second.candidate_id] };
    } else {
      decision = "winner";
      winner = first.candidate_id;
      nextAction = { type: "integrate_winner", candidate_ids: [winner] };
    }
  }

  return decideResultSchema.parse({
    kind: "jevrev.decide-result",
    schema_version: "1",
    campaign_id: prepared.campaign.campaign_id,
    decision,
    winner,
    merge_candidates: mergeCandidates,
    eligible: accepted.map((evaluation) => evaluation.candidate_id),
    evaluations,
    next_action: nextAction,
    audit: {
      policy: "decide-v1",
      provider_profile: options.providerProfile ?? "library",
      campaign_sha256: workflowDigest(prepared.campaign),
      evidence_sha256: workflowDigest(prepared.bundle),
      usage: response?.usage ?? { input_tokens: 0, output_tokens: 0 },
    },
  });
}
