import { noul, score, type Question } from "@typesafe-ai/sdk";
import { z } from "zod";
import { ProtocolError } from "./domain/errors.js";
import type { Judge } from "./judge.js";
import type { JudgeResponse } from "./domain/schemas.js";
import { buildWorkOrder, candidateDigest, campaignId } from "./workflow/campaign.js";
import { campaignSchema, type Campaign } from "./workflow/schemas.js";
import { workflowDigest } from "./workflow/evidence.js";
import type { QuestionPlan } from "./questions.js";

const REVIEW_SIGNALS = ["goal_fit", "constraint_fit", "feasibility", "validation_quality", "execution_value"] as const;
type ReviewSignal = (typeof REVIEW_SIGNALS)[number];

const reviewReasonSchema = z.enum([
  "CONSTRAINT_RISK",
  "GOAL_MISMATCH",
  "LOW_FEASIBILITY",
  "WEAK_VALIDATION",
  "LOW_EXECUTION_VALUE",
  "LOW_CONFIDENCE",
  "BUDGET_CUTOFF",
]);

export const reconsiderResultSchema = z.object({
  kind: z.literal("jevrev.reconsider-result"),
  schema_version: z.literal("1"),
  campaign_id: z.string().regex(/^jvc_[a-f0-9]{12}$/),
  candidate_id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["promote_to_probe", "keep_review", "reject"]),
  reasons: z.array(reviewReasonSchema).max(8),
  suggested_probe: z.string().trim().min(1).max(2_000),
  signals: z.object({
    goal_fit: z.number().min(0).max(1),
    constraint_fit: z.number().min(0).max(1),
    feasibility: z.number().min(0).max(1),
    validation_quality: z.number().min(0).max(1),
    execution_value: z.number().min(0).max(1),
  }).strict(),
  confidence: z.number().min(0).max(1),
  work_order: z.object({
    candidate_id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    hypothesis: z.string().trim().min(1).max(2_000),
    probe_instruction: z.string().trim().min(1).max(2_000),
    required_evidence: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), description: z.string().trim().min(1).max(2_000) }).strict()).min(1).max(12),
    budget: z.object({ max_wall_ms: z.number().int().positive(), max_changed_files: z.number().int().positive() }).strict(),
    stop_conditions: z.array(z.string().trim().min(1).max(2_000)).min(1).max(12),
  }).strict().nullable(),
  promoted_campaign: z.lazy(() => campaignSchema).nullable(),
  audit: z.object({
    policy: z.literal("reconsider-v1"),
    provider_profile: z.string().min(1),
    campaign_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(),
  }).strict(),
}).strict();

export type ReconsiderResult = z.infer<typeof reconsiderResultSchema>;

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
const VALUE_RUBRIC = [
  "The candidate is not worth an implementation slot.",
  "The candidate might be worth a slot, but the information gain is unclear.",
  "The candidate is worth one bounded probe before integration.",
  "The candidate is an unusually strong use of a probe slot.",
] as const;

function questionKey(signal: ReviewSignal): string {
  return `reconsider_candidate_${signal}`;
}

function buildPlan(campaign: Campaign, candidateId: string): QuestionPlan {
  const candidate = campaign.request.candidates.find((item) => item.id === candidateId);
  if (candidate === undefined) throw new ProtocolError(`Unknown candidate: ${candidateId}`);
  const questions: Record<string, Question> = {};
  const expectedTypes: Record<string, Question["type"]> = {};
  const add = (signal: ReviewSignal, question: Question): void => {
    questions[questionKey(signal)] = question;
    expectedTypes[questionKey(signal)] = question.type;
  };
  add("goal_fit", score(
    "Judge only this candidate's mechanism against the frozen task goal and success criteria. Do not penalize or favor a familiar mechanism family.",
    GOAL_RUBRIC,
  ));
  add("constraint_fit", noul(
    "Is this candidate likely to satisfy every hard constraint? Answer yes only when all listed hard constraints are likely satisfied.",
    { true: "All hard constraints are likely satisfied.", false: "At least one hard constraint is likely violated." },
  ));
  add("feasibility", score(
    "How technically feasible is this specific mechanism in the supplied task context? Judge assumptions and risks, not the prose quality.",
    FEASIBILITY_RUBRIC,
  ));
  add("validation_quality", score(
    "How well can this candidate's validation plan cheaply falsify the mechanism and detect regressions?",
    VALIDATION_RUBRIC,
  ));
  add("execution_value", score(
    "Is this candidate worth one bounded implementation probe under the frozen budget, even if it is not yet ready to integrate?",
    VALUE_RUBRIC,
  ));

  const prior = campaign.sift.decisions.find((item) => item.candidate_id === candidateId);
  const state = JSON.parse(JSON.stringify({
      task: {
        goal: campaign.request.task.goal,
        constraints: campaign.request.task.constraints,
        success: campaign.request.task.success,
        ...(campaign.request.task.context === undefined ? {} : { context: campaign.request.task.context }),
      },
      candidate: {
        id: candidate.id,
        title: candidate.title,
        summary: candidate.summary,
        mechanism: candidate.mechanism,
        assumptions: candidate.assumptions,
        risks: candidate.risks,
        validation: candidate.validation,
        effort: candidate.effort,
      },
      ...(prior === undefined ? {} : { prior_sift: prior }),
  })) as QuestionPlan["state"];
  return {
    state,
    questions,
    expectedTypes,
    candidateOrder: [0],
    candidateIds: [candidate.id],
  };
}

function scoreSignal(response: JudgeResponse, signal: Exclude<ReviewSignal, "constraint_fit">): { value: number; confidence: number } {
  const answer = response.answers[questionKey(signal)];
  if (answer?.type !== "score" || answer.score > 3) throw new ProtocolError(`Missing or invalid reconsider answer: ${questionKey(signal)}`);
  return { value: answer.score / 3, confidence: answer.confidence };
}

function constraintSignal(response: JudgeResponse): { value: number; confidence: number } {
  const answer = response.answers[questionKey("constraint_fit")];
  if (answer?.type !== "noul") throw new ProtocolError(`Missing or invalid reconsider answer: ${questionKey("constraint_fit")}`);
  return { value: answer.noul, confidence: Math.abs(answer.noul - 0.5) * 2 };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export async function reconsiderCandidate(
  campaignInput: Campaign,
  candidateId: string,
  judge: Judge,
  options: { providerProfile?: string } = {},
): Promise<ReconsiderResult> {
  const campaign = campaignSchema.parse(campaignInput);
  if (campaignId(campaign) !== campaign.campaign_id) throw new ProtocolError("Campaign ID does not match its frozen request and sift result");
  const decision = campaign.sift.decisions.find((item) => item.candidate_id === candidateId);
  if (decision === undefined) throw new ProtocolError(`Unknown candidate: ${candidateId}`);
  if (decision.status !== "review") throw new ProtocolError(`Candidate ${candidateId} is not in review (status: ${decision.status})`);

  const plan = buildPlan(campaign, candidateId);
  const response = await judge.evaluate(plan);
  const goal = scoreSignal(response, "goal_fit");
  const constraint = constraintSignal(response);
  const feasibility = scoreSignal(response, "feasibility");
  const validation = scoreSignal(response, "validation_quality");
  const execution = scoreSignal(response, "execution_value");
  const signals = {
    goal_fit: round(goal.value),
    constraint_fit: round(constraint.value),
    feasibility: round(feasibility.value),
    validation_quality: round(validation.value),
    execution_value: round(execution.value),
  };
  const confidence = round(Math.min(goal.confidence, constraint.confidence, feasibility.confidence, validation.confidence, execution.confidence));
  const reasons: z.infer<typeof reviewReasonSchema>[] = [];
  if (constraint.value < 0.55) reasons.push("CONSTRAINT_RISK");
  if (goal.value < 0.34) reasons.push("GOAL_MISMATCH");
  if (feasibility.value < 0.34) reasons.push("LOW_FEASIBILITY");
  if (validation.value < 0.25) reasons.push("WEAK_VALIDATION");
  if (execution.value < 0.45) reasons.push("LOW_EXECUTION_VALUE");
  if (confidence < 0.2) reasons.push("LOW_CONFIDENCE");
  if (campaign.work_orders.length + campaign.review_work_orders.length >= 5) reasons.push("BUDGET_CUTOFF");
  const candidate = campaign.request.candidates.find((item) => item.id === candidateId)!;
  const decisionValue: ReconsiderResult["decision"] = reasons.includes("CONSTRAINT_RISK") || reasons.some((reason) => ["GOAL_MISMATCH", "LOW_FEASIBILITY", "WEAK_VALIDATION", "LOW_EXECUTION_VALUE", "BUDGET_CUTOFF"].includes(reason))
    ? "reject"
    : confidence < 0.2
      ? "keep_review"
      : "promote_to_probe";
  const promotedWorkOrder = buildWorkOrder(candidate);
  const promotedCampaign = decisionValue === "promote_to_probe"
    ? campaignSchema.parse({
        ...campaign,
        review_work_orders: [...campaign.review_work_orders, promotedWorkOrder],
        campaign_id: campaignId({ ...campaign, review_work_orders: [...campaign.review_work_orders, promotedWorkOrder] }),
      })
    : null;
  return reconsiderResultSchema.parse({
    kind: "jevrev.reconsider-result", schema_version: "1", campaign_id: campaign.campaign_id,
    candidate_id: candidate.id, candidate_sha256: candidateDigest(candidate), decision: decisionValue,
    reasons, suggested_probe: candidate.validation[0]!, signals, confidence,
    work_order: decisionValue === "promote_to_probe" ? promotedWorkOrder : null,
    promoted_campaign: promotedCampaign,
    audit: {
      policy: "reconsider-v1", provider_profile: options.providerProfile ?? response.model,
      campaign_sha256: workflowDigest(campaign), usage: response.usage,
    },
  });
}

export function renderReconsiderHuman(result: ReconsiderResult): string {
  const lines = [
    `JevRev reconsider ${result.campaign_id}`,
    `${result.candidate_id}: ${result.decision}`,
    `confidence: ${result.confidence.toFixed(3)}`,
    `goal ${result.signals.goal_fit.toFixed(2)} | constraints ${result.signals.constraint_fit.toFixed(2)} | feasibility ${result.signals.feasibility.toFixed(2)} | validation ${result.signals.validation_quality.toFixed(2)} | value ${result.signals.execution_value.toFixed(2)}`,
  ];
  if (result.reasons.length > 0) lines.push(`reasons: ${result.reasons.join(", ")}`);
  lines.push(`probe: ${result.suggested_probe}`);
  if (result.decision === "promote_to_probe") lines.push("This creates permission for one bounded probe; it does not authorize integration.");
  return `${lines.join("\n")}\n`;
}
