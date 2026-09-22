import { score, type JsonValue, type Question } from "@typesafe-ai/sdk";
import { InputError, ProtocolError } from "../domain/errors.js";
import type { Judge } from "../judge.js";
import type { QuestionPlan } from "../questions.js";
import type { JudgeResponse } from "../domain/schemas.js";
import { loopHash, loopSpecSchema, roundAuditResultSchema, roundEvidenceSchema, roundWorkOrderSchema, type LoopCriterion, type LoopSpec, type RoundAuditResult, type RoundEvidence, type RoundWorkOrder } from "./schemas.js";

export interface LoopAuditOptions {
  judge?: Judge;
  providerProfile?: string;
  previousAudit?: RoundAuditResult | null;
  consecutiveStalled?: number;
  plateauReplans?: number;
  cumulativeWallMs?: number;
  cumulativeProviderTokens?: number;
}

interface CriterionAssessment {
  id: string;
  status: "pass" | "fail" | "unknown";
  score: number | null;
  confidence: number | null;
  source: "command" | "metric" | "jev" | "artifact";
  freshness: "fresh" | "carried_forward";
  current: boolean;
}

interface JudgedQuestion {
  criterion: Extract<LoopCriterion, { type: "judged" }>;
  key: string;
}

function currentClaim(
  claims: RoundEvidence["criterion_results"] | RoundEvidence["protected_surface_results"],
  id: string,
  evidence: RoundEvidence,
) {
  const claim = claims.find((item) => item.id === id);
  if (claim === undefined || claim.freshness !== "fresh" || claim.source_round !== evidence.round_number || claim.head_revision !== evidence.head_revision) return undefined;
  return claim;
}

function metricAggregate(samples: readonly number[], aggregation: "mean" | "p75"): number {
  if (aggregation === "mean") return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(0.75 * ordered.length) - 1]!;
}

function metricScore(value: number, target: number, direction: "higher" | "lower"): number {
  if (direction === "higher") {
    if (value >= target) return 1;
    if (target <= 0) return 0;
    return Math.max(0, Math.min(1, value / target));
  }
  if (value <= target) return 1;
  if (value <= 0 || target <= 0) return 0;
  return Math.max(0, Math.min(1, target / value));
}

function metricTarget(criterion: Extract<LoopCriterion, { type: "metric" }>): number {
  return criterion.baseline === undefined ? criterion.target : criterion.baseline * criterion.target;
}

function carried(previous: RoundAuditResult | null | undefined, id: string, source: CriterionAssessment["source"]): CriterionAssessment | undefined {
  const prior = previous?.criteria.find((criterion) => criterion.id === id);
  if (prior === undefined || prior.freshness !== "fresh") return undefined;
  return { ...prior, source, freshness: "carried_forward", current: false };
}

function assessHard(
  criterion: Extract<LoopCriterion, { type: "hard" }>,
  evidence: RoundEvidence,
  previous: RoundAuditResult | null | undefined,
): CriterionAssessment {
  const claim = currentClaim(evidence.criterion_results, criterion.id, evidence);
  const observations = new Map(evidence.observations.map((observation) => [observation.id, observation]));
  if (claim !== undefined) {
    if (claim.status === "fail") return { id: criterion.id, status: "fail", score: 0, confidence: 1, source: "command", freshness: "fresh", current: true };
    const required = criterion.required_commands.map((id) => observations.get(id));
    const failed = required.some((observation) => observation !== undefined && (observation.exit_code !== 0 || observation.termination !== "exited" || observation.source !== "recorded" || observation.head_revision !== evidence.head_revision));
    const complete = required.every((observation) => observation !== undefined && observation.exit_code === 0 && observation.termination === "exited" && observation.source === "recorded" && observation.head_revision === evidence.head_revision);
    if (failed) return { id: criterion.id, status: "fail", score: 0, confidence: 1, source: "command", freshness: "fresh", current: true };
    if (complete) return { id: criterion.id, status: "pass", score: 1, confidence: 1, source: "command", freshness: "fresh", current: true };
  }
  return carried(previous, criterion.id, "command") ?? { id: criterion.id, status: "unknown", score: null, confidence: null, source: "command", freshness: claim === undefined ? "fresh" : "carried_forward", current: claim !== undefined };
}

function assessMetric(
  criterion: Extract<LoopCriterion, { type: "metric" }>,
  evidence: RoundEvidence,
  previous: RoundAuditResult | null | undefined,
): CriterionAssessment {
  const claim = currentClaim(evidence.criterion_results, criterion.id, evidence);
  const allowed = new Set(claim?.metric_ids ?? []);
  if (claim?.status === "fail") return { id: criterion.id, status: "fail", score: 0, confidence: 1, source: "metric", freshness: "fresh", current: true };
  const metrics = evidence.metrics.filter((metric) => allowed.has(metric.id) && metric.criterion_id === criterion.id && metric.unit === criterion.unit && metric.head_revision === evidence.head_revision);
  const qualified = metrics.filter((metric) => metric.samples.length >= criterion.minimum_samples);
  if (qualified.length > 0) {
    const combinedSamples = qualified.flatMap((metric) => metric.samples);
    const scoreValue = metricScore(metricAggregate(combinedSamples, criterion.aggregation), metricTarget(criterion), criterion.direction);
    return { id: criterion.id, status: scoreValue >= 1 ? "pass" : "fail", score: scoreValue, confidence: 1, source: "metric", freshness: "fresh", current: true };
  }
  return carried(previous, criterion.id, "metric") ?? { id: criterion.id, status: "unknown", score: null, confidence: null, source: "metric", freshness: claim === undefined ? "fresh" : "carried_forward", current: claim !== undefined };
}

function assessProtected(
  id: string,
  evidence: RoundEvidence,
  previous: RoundAuditResult | null | undefined,
): CriterionAssessment {
  const claim = currentClaim(evidence.protected_surface_results, id, evidence);
  const observations = new Map(evidence.observations.map((observation) => [observation.id, observation]));
  const artifacts = new Map(evidence.artifact_evaluations.map((artifact) => [artifact.id, artifact]));
  if (claim !== undefined) {
    const commandPass = claim.observation_ids.length > 0 && claim.observation_ids.every((ref) => {
      const observation = observations.get(ref);
      return observation?.head_revision === evidence.head_revision && observation.exit_code === 0 && observation.termination === "exited" && observation.source === "recorded";
    });
    const artifactPass = claim.artifact_evaluation_ids.length > 0 && claim.artifact_evaluation_ids.every((ref) => {
      const artifact = artifacts.get(ref);
      return artifact?.head_revision === evidence.head_revision && artifact.status === "pass";
    });
    const commandRefsAreClean = claim.observation_ids.every((ref) => {
      const observation = observations.get(ref);
      return observation?.head_revision === evidence.head_revision && observation.exit_code === 0 && observation.termination === "exited" && observation.source === "recorded";
    });
    const artifactRefsAreClean = claim.artifact_evaluation_ids.every((ref) => {
      const artifact = artifacts.get(ref);
      return artifact?.head_revision === evidence.head_revision && artifact.status === "pass";
    });
    if (claim.status === "fail" || !commandRefsAreClean || !artifactRefsAreClean) return { id, status: "fail", score: 0, confidence: 1, source: claim.observation_ids.length > 0 ? "command" : "artifact", freshness: "fresh", current: true };
    if (commandPass || artifactPass) return { id, status: "pass", score: 1, confidence: 1, source: commandPass ? "command" : "artifact", freshness: "fresh", current: true };
    if (claim.observation_ids.length > 0 || claim.artifact_evaluation_ids.length > 0) return { id, status: "fail", score: 0, confidence: 1, source: claim.observation_ids.length > 0 ? "command" : "artifact", freshness: "fresh", current: true };
  }
  return carried(previous, id, "command") ?? { id, status: "unknown", score: null, confidence: null, source: "command", freshness: claim === undefined ? "fresh" : "carried_forward", current: claim !== undefined };
}

function buildJevPlan(spec: LoopSpec, order: RoundWorkOrder, evidence: RoundEvidence): { plan: QuestionPlan; questions: readonly JudgedQuestion[] } {
  const focus = new Set(order.mode === "completion" ? spec.criteria.map((criterion) => criterion.id) : order.focus_criteria);
  const questions: Record<string, Question> = {};
  const expectedTypes: Record<string, "score"> = {};
  const judged: JudgedQuestion[] = [];
  for (const criterion of spec.criteria) {
    if (criterion.type !== "judged" || !focus.has(criterion.id)) continue;
    const index = judged.length;
    const key = `finalist_${index}_criterion`;
    questions[key] = score(
      `How well does the current artifact satisfy the criterion "${criterion.description}" for the loop goal? Judge the evidence and the artifact outcome, not the prose.`,
      criterion.rubric as unknown as readonly [string, string, ...string[]],
    );
    expectedTypes[key] = "score";
    judged.push({ criterion, key });
  }
  const jsonEvidence = JSON.parse(JSON.stringify(evidence)) as JsonValue;
  const finalists = judged.map(({ criterion }) => ({
    id: criterion.id,
    criterion: criterion.description,
    target: criterion.target,
    required_confidence: criterion.required_confidence,
    rubric: criterion.rubric,
    required_artifacts: criterion.required_artifacts,
    evidence: jsonEvidence,
  }));
  return {
    plan: {
      state: { task: { goal: spec.goal, ...(spec.context === undefined ? {} : { context: spec.context }), round: order.round_number }, finalists },
      questions,
      expectedTypes,
      candidateOrder: judged.map((_item, index) => index),
      candidateIds: judged.map(({ criterion }) => criterion.id),
    },
    questions: judged,
  };
}

function judgeScores(response: JudgeResponse, questions: readonly JudgedQuestion[], plan: QuestionPlan): Map<string, { score: number; confidence: number }> {
  const result = new Map<string, { score: number; confidence: number }>();
  for (const { criterion, key } of questions) {
    const answer = response.answers[key];
    if (answer?.type !== "score") throw new ProtocolError(`Jev did not return a score for ${criterion.id}`);
    const rubricSize = plan.questions[key]?.type === "score" ? plan.questions[key].criteria.length : 1;
    result.set(criterion.id, {
      score: rubricSize <= 1 ? 1 : Math.max(0, Math.min(1, answer.score / (rubricSize - 1))),
      confidence: answer.confidence,
    });
  }
  return result;
}

async function assessJudged(
  criterion: Extract<LoopCriterion, { type: "judged" }>,
  evidence: RoundEvidence,
  previous: RoundAuditResult | null | undefined,
  judgedScores: Map<string, { score: number; confidence: number }>,
): Promise<CriterionAssessment> {
  const claim = currentClaim(evidence.criterion_results, criterion.id, evidence);
  const artifacts = new Map(evidence.artifact_evaluations.map((artifact) => [artifact.id, artifact]));
  const scoreValue = judgedScores.get(criterion.id);
  if (claim !== undefined && scoreValue !== undefined) {
    const required = criterion.required_artifacts.map((artifactId) =>
      [...artifacts.values()].find((artifact) => artifact.artifact_id === artifactId && claim.artifact_evaluation_ids.includes(artifact.id)),
    );
    if (claim.status === "fail") return { id: criterion.id, status: "fail", score: scoreValue.score, confidence: scoreValue.confidence, source: "jev", freshness: "fresh", current: true };
    // A missing artifact is an evidence gap, not a regression. Only an
    // explicitly failed or stale artifact can route the round to repair.
    const failed = required.some((artifact) => artifact !== undefined && (artifact.status === "fail" || artifact.head_revision !== evidence.head_revision));
    const incomplete = required.some((artifact) => artifact === undefined || artifact.status === "unknown");
    const status = failed ? "fail" : incomplete ? "unknown" : scoreValue.score >= criterion.target && scoreValue.confidence >= criterion.required_confidence ? "pass" : "unknown";
    return { id: criterion.id, status, score: scoreValue.score, confidence: scoreValue.confidence, source: "jev", freshness: "fresh", current: true };
  }
  return carried(previous, criterion.id, "jev") ?? { id: criterion.id, status: "unknown", score: scoreValue?.score ?? null, confidence: scoreValue?.confidence ?? null, source: "jev", freshness: claim === undefined ? "fresh" : "carried_forward", current: claim !== undefined };
}

function materialProgress(criteria: readonly CriterionAssessment[], previous: RoundAuditResult | null | undefined, delta: number): boolean {
  if (previous === null || previous === undefined || previous.spec_sha256 === "") return criteria.some((criterion) => criterion.current && criterion.status === "pass");
  return criteria.some((criterion) => {
    if (!criterion.current) return false;
    const prior = previous.criteria.find((item) => item.id === criterion.id);
    if (criterion.status === "pass" && prior?.status !== "pass") return true;
    return prior?.score !== null && prior?.score !== undefined && criterion.score !== null && criterion.score - prior.score >= delta;
  });
}

export async function auditRound(specInput: LoopSpec, orderInput: RoundWorkOrder, evidenceInput: RoundEvidence, options: LoopAuditOptions = {}): Promise<RoundAuditResult> {
  const spec = loopSpecSchema.parse(specInput);
  const order = roundWorkOrderSchema.parse(orderInput);
  const evidence = roundEvidenceSchema.parse(evidenceInput);
  if (order.loop_id !== evidence.loop_id || order.round_number !== evidence.round_number || order.spec_sha256 !== loopHash(spec) || evidence.spec_sha256 !== order.spec_sha256 || evidence.work_order_sha256 !== loopHash(order) || evidence.base_revision !== order.base_revision) {
    throw new InputError("Audit inputs are not bound to the same loop, spec, work order and base revision");
  }
  // A spec revision changes the contract. No assessment from the previous
  // contract may be carried into the new one, even when criterion IDs match.
  const previous = options.previousAudit?.spec_sha256 === loopHash(spec)
    ? options.previousAudit
    : null;
  const judgedPlan = buildJevPlan(spec, order, evidence);
  let response: JudgeResponse | undefined;
  if (judgedPlan.questions.length > 0 && options.judge !== undefined) response = await options.judge.evaluate(judgedPlan.plan);
  const judgedScores = response === undefined ? new Map<string, { score: number; confidence: number }>() : judgeScores(response, judgedPlan.questions, judgedPlan.plan);
  const assessments: CriterionAssessment[] = [];
  for (const criterion of spec.criteria) {
    assessments.push(criterion.type === "hard"
      ? assessHard(criterion, evidence, previous)
      : criterion.type === "metric"
        ? assessMetric(criterion, evidence, previous)
        : await assessJudged(criterion, evidence, previous, judgedScores));
  }
  for (const surface of spec.protected_surfaces) assessments.push(assessProtected(surface.id, evidence, previous));

  const freshFailures = assessments.filter((criterion) => criterion.current && criterion.status === "fail");
  const freshUnknown = assessments.filter((criterion) => criterion.current && criterion.status === "unknown");
  const lowConfidence = assessments.filter((criterion) => criterion.current && criterion.source === "jev" && criterion.status === "unknown" && criterion.confidence !== null && criterion.confidence < (spec.criteria.find((item) => item.id === criterion.id)?.type === "judged" ? (spec.criteria.find((item) => item.id === criterion.id) as Extract<LoopCriterion, { type: "judged" }>).required_confidence : 0));
  const allFreshPass = assessments.length > 0 && assessments.every((criterion) => criterion.current && criterion.status === "pass" && criterion.freshness === "fresh");
  const targetAssessments = assessments.filter((assessment) => spec.criteria.some((criterion) => criterion.id === assessment.id));
  const stalled = !materialProgress(targetAssessments, previous, spec.plateau.min_material_delta);
  const missingJevForCompletion = order.mode === "completion" && options.judge === undefined && spec.criteria.some((criterion) => criterion.type === "judged");
  let outcome: RoundAuditResult["outcome"];
  let focus: string[];
  let reason: string;
  if (order.mode === "completion") {
    if (evidence.known_failures.length > 0 || freshFailures.length > 0) { outcome = "fix_regression"; focus = freshFailures.length > 0 ? freshFailures.map((criterion) => criterion.id) : spec.criteria.map((criterion) => criterion.id); reason = evidence.known_failures.length > 0 ? "The builder reported a known failure" : "A completion check found a failed criterion or protected surface"; }
    else if (missingJevForCompletion || lowConfidence.length > 0) { outcome = "waiting_human"; focus = missingJevForCompletion ? spec.criteria.filter((criterion) => criterion.type === "judged").map((criterion) => criterion.id) : lowConfidence.map((criterion) => criterion.id); reason = missingJevForCompletion ? "A completion audit requires a Jev response for its judged criteria" : "A judged criterion did not reach the required confidence"; }
    else if (allFreshPass && evidence.known_failures.length === 0) { outcome = "completed"; focus = []; reason = "All criteria and protected surfaces pass with fresh evidence"; }
    else { outcome = "verify"; focus = freshUnknown.map((criterion) => criterion.id); reason = "Completion evidence is incomplete, stale or below target"; }
  } else if (evidence.known_failures.length > 0 || freshFailures.length > 0) {
    outcome = "fix_regression"; focus = freshFailures.length > 0 ? freshFailures.map((criterion) => criterion.id) : order.focus_criteria; reason = evidence.known_failures.length > 0 ? "The builder reported a known failure" : "A hard criterion or protected surface regressed";
  } else if (lowConfidence.length > 0) {
    outcome = "waiting_human"; focus = lowConfidence.map((criterion) => criterion.id); reason = "A judged criterion needs a human decision at the current confidence";
  } else if (allFreshPass) {
    outcome = "verify"; focus = spec.criteria.map((criterion) => criterion.id); reason = "The current round passes; request a full completion verification";
  } else if (stalled && (options.consecutiveStalled ?? 0) + 1 >= spec.plateau.window) {
    if ((options.plateauReplans ?? 0) === 0) { outcome = "replan"; focus = freshUnknown.map((criterion) => criterion.id); reason = "The loop has plateaued without material progress"; }
    else { outcome = "waiting_human"; focus = freshUnknown.map((criterion) => criterion.id); reason = "The loop plateaued after a replan and needs a human decision"; }
  } else {
    outcome = "continue"; focus = (freshUnknown.length > 0 ? freshUnknown : assessments.filter((criterion) => !criterion.current || criterion.status !== "pass")).map((criterion) => criterion.id); if (focus.length === 0) focus = order.focus_criteria; reason = "Continue the single artifact with the remaining evidence gaps";
  }
  const inputTokens = response?.usage.input_tokens ?? 0;
  const outputTokens = response?.usage.output_tokens ?? 0;
  const roundProviderTokens = evidence.provider_tokens + inputTokens + outputTokens;
  if (outcome !== "completed" && ((options.cumulativeWallMs ?? 0) + evidence.wall_ms >= spec.budget.pause_total_wall_ms || (options.cumulativeProviderTokens ?? 0) + roundProviderTokens >= spec.budget.pause_total_provider_tokens)) {
    outcome = "budget_paused"; focus = []; reason = "The frozen total budget has been reached";
  }
  const result = roundAuditResultSchema.parse({
    kind: "jevrev.round-audit-result", schema_version: "1", loop_id: order.loop_id, round_number: order.round_number,
    audit_mode: order.mode === "completion" ? "completion" : "progress", outcome,
    criteria: assessments.map(({ id, status, score, confidence, source, freshness }) => ({ id, status, score, confidence, source, freshness })),
    blocking_criteria: freshFailures.map((criterion) => criterion.id),
    next_action: { type: outcome === "waiting_human" ? "ask_human" : outcome === "budget_paused" ? "wait_budget" : outcome === "completed" ? "stop_success" : outcome, focus_criteria: focus, reason },
    material_progress: !stalled, evidence_sha256: loopHash(evidence), spec_sha256: loopHash(spec),
    provider_profile: options.providerProfile ?? (response?.model ?? "deterministic"), usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  return result;
}
