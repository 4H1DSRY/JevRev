import { createHash } from "node:crypto";
import { z } from "zod";

export const loopIdSchema = z.string().regex(/^jvl_[a-f0-9]{16}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(2_000);
const workspacePath = z.string().trim().min(1).max(1_000).refine(
  (value) => !/^(?:[a-zA-Z]:|[\\/])/.test(value) &&
    !value.split(/[\\/]+/).includes(".."),
  "must stay within the workspace",
);

export const hardCriterionSchema = z.object({
  id,
  type: z.literal("hard"),
  description: label,
  required_commands: z.array(id).min(1).max(24),
}).strict().superRefine((criterion, context) => {
  if (new Set(criterion.required_commands).size !== criterion.required_commands.length) {
    context.addIssue({ code: "custom", path: ["required_commands"], message: "required commands must be unique" });
  }
});

export const metricCriterionSchema = z.object({
  id,
  type: z.literal("metric"),
  description: label,
  unit: z.string().trim().min(1).max(64),
  direction: z.enum(["higher", "lower"]),
  aggregation: z.enum(["mean", "p75"]),
  target: z.number().finite(),
  // When present, target is a multiplier of this frozen baseline. Without it,
  // target remains an absolute value for backwards-compatible specs.
  baseline: z.number().finite().optional(),
  minimum_samples: z.number().int().min(2).max(1_000),
}).strict();

export const judgedCriterionSchema = z.object({
  id,
  type: z.literal("judged"),
  description: label,
  target: z.number().min(0).max(1),
  required_confidence: z.number().min(0).max(1),
  rubric: z.array(label).min(2).max(8),
  required_artifacts: z.array(id).min(1).max(16),
}).strict().superRefine((criterion, context) => {
  if (new Set(criterion.required_artifacts).size !== criterion.required_artifacts.length) {
    context.addIssue({ code: "custom", path: ["required_artifacts"], message: "required artifacts must be unique" });
  }
});

export const loopCriterionSchema = z.discriminatedUnion("type", [
  hardCriterionSchema,
  metricCriterionSchema,
  judgedCriterionSchema,
]);

export const loopSpecSchema = z.object({
  kind: z.literal("jevrev.loop-spec"),
  schema_version: z.literal("1"),
  revision: z.number().int().positive(),
  title: label,
  goal: label,
  context: z.string().max(4_000).optional(),
  workspace: workspacePath,
  criteria: z.array(loopCriterionSchema).min(1).max(24),
  protected_surfaces: z.array(z.object({ id, description: label }).strict()).max(16),
  budget: z.object({
    per_round_wall_ms: z.number().int().positive().max(86_400_000),
    per_round_changed_files: z.number().int().positive().max(1_000),
    pause_total_wall_ms: z.number().int().positive().max(2_592_000_000),
    pause_total_provider_tokens: z.number().int().positive().max(100_000_000),
  }).strict(),
  plateau: z.object({ window: z.number().int().min(2).max(12), min_material_delta: z.number().min(0).max(1) }).strict(),
}).strict().superRefine((spec, context) => {
  const criterionIds = spec.criteria.map((criterion) => criterion.id);
  const surfaceIds = spec.protected_surfaces.map((surface) => surface.id);
  if (new Set([...criterionIds, ...surfaceIds]).size !== criterionIds.length + surfaceIds.length) {
    context.addIssue({ code: "custom", path: ["criteria"], message: "criterion and protected surface IDs must be unique" });
  }
  if (spec.budget.pause_total_wall_ms < spec.budget.per_round_wall_ms) {
    context.addIssue({ code: "custom", path: ["budget"], message: "total wall budget cannot be smaller than one round" });
  }
  const commandSlots = spec.criteria.reduce(
    (total, criterion) => total + (criterion.type === "hard" ? criterion.required_commands.length : 0),
    spec.protected_surfaces.length,
  );
  const artifactSlots = spec.criteria.reduce(
    (total, criterion) => total + (criterion.type === "judged" ? criterion.required_artifacts.length : 0),
    0,
  );
  if (commandSlots > 128) {
    context.addIssue({ code: "custom", path: ["criteria"], message: "completion requires at most 128 command evidence slots including protected surfaces" });
  }
  if (artifactSlots > 64) {
    context.addIssue({ code: "custom", path: ["criteria"], message: "completion requires at most 64 artifact evidence slots" });
  }
});

export type LoopSpec = z.infer<typeof loopSpecSchema>;
export type LoopCriterion = LoopSpec["criteria"][number];

export function loopHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const roundPlanSchema = z.object({
  kind: z.literal("jevrev.round-plan"),
  schema_version: z.literal("1"),
  round_goal: label,
  focus_criteria: z.array(id).min(1).max(24),
  hypothesis: label,
  allowed_scope: z.array(workspacePath).max(64),
  do_not_change: z.array(id).max(24),
  required_evidence: z.array(z.object({ id, description: label, kind: z.enum(["command", "metric", "artifact"]) }).strict()).min(1).max(256),
  stop_conditions: z.array(label).min(1).max(12),
  budget: z.object({ max_wall_ms: z.number().int().positive().optional(), max_changed_files: z.number().int().positive().optional() }).strict().optional(),
}).strict().superRefine((plan, context) => {
  if (new Set(plan.focus_criteria).size !== plan.focus_criteria.length ||
      new Set(plan.do_not_change).size !== plan.do_not_change.length ||
      new Set(plan.required_evidence.map((item) => item.id)).size !== plan.required_evidence.length) {
    context.addIssue({ code: "custom", path: [], message: "round plan references must be unique" });
  }
});
export type RoundPlan = z.infer<typeof roundPlanSchema>;

export const roundWorkOrderSchema = z.object({
  kind: z.literal("jevrev.round-work-order"),
  schema_version: z.literal("1"),
  loop_id: loopIdSchema,
  round_number: z.number().int().positive(),
  spec_revision: z.number().int().positive(),
  spec_sha256: digest,
  base_revision: label,
  mode: z.enum(["progress", "fix_regression", "verify", "replan", "completion"]),
  round_goal: label,
  focus_criteria: z.array(id).min(1).max(24),
  hypothesis: label,
  allowed_scope: z.array(workspacePath).max(64),
  do_not_change: z.array(id).max(24),
  required_evidence: z.array(z.object({ id, description: label, kind: z.enum(["command", "metric", "artifact"]) }).strict()).min(1).max(256),
  budget: z.object({ max_wall_ms: z.number().int().positive(), max_changed_files: z.number().int().positive() }).strict(),
  stop_conditions: z.array(label).min(1).max(12),
}).strict().superRefine((order, context) => {
  if (new Set(order.focus_criteria).size !== order.focus_criteria.length ||
      new Set(order.required_evidence.map((item) => item.id)).size !== order.required_evidence.length) {
    context.addIssue({ code: "custom", path: ["required_evidence"], message: "work-order references must be unique" });
  }
});
export type RoundWorkOrder = z.infer<typeof roundWorkOrderSchema>;

const citedEvidenceSchema = z.object({
  id,
  status: z.enum(["pass", "fail", "unknown"]),
  freshness: z.enum(["fresh", "carried_forward"]),
  source_round: z.number().int().positive(),
  head_revision: label,
  observation_ids: z.array(id).max(64),
  metric_ids: z.array(id).max(64),
  artifact_evaluation_ids: z.array(id).max(64),
}).strict();

export const roundEvidenceSchema = z.object({
  kind: z.literal("jevrev.round-evidence"),
  schema_version: z.literal("1"),
  loop_id: loopIdSchema,
  round_number: z.number().int().positive(),
  spec_sha256: digest,
  work_order_sha256: digest,
  base_revision: label,
  head_revision: label,
  wall_ms: z.number().int().nonnegative(),
  provider_tokens: z.number().int().nonnegative(),
  changed_files: z.array(workspacePath).max(1_000),
  observations: z.array(z.object({ id, exit_code: z.number().int(), duration_ms: z.number().int().nonnegative(), head_revision: label, termination: z.enum(["exited", "timed_out", "spawn_error", "buffer_exceeded"]), source: z.enum(["recorded", "imported"]), stdout_sha256: digest.optional(), stderr_sha256: digest.optional() }).strict()).max(128),
  metrics: z.array(z.object({ id, criterion_id: id, unit: z.string().min(1).max(64), samples: z.array(z.number().finite()).min(2).max(1_000), head_revision: label }).strict()).max(64),
  artifact_evaluations: z.array(z.object({
    id, artifact_id: id, sha256: digest, status: z.enum(["pass", "fail", "unknown"]), head_revision: label,
    source: z.literal("imported"), path: workspacePath.optional(), summary: z.string().trim().min(1).max(4_000),
    content: z.string().max(20_000).optional(),
  }).strict()).max(64),
  criterion_results: z.array(citedEvidenceSchema).max(40),
  protected_surface_results: z.array(citedEvidenceSchema).max(16),
  known_failures: z.array(label).max(64),
  builder_notes: z.string().max(8_000).optional(),
}).strict().superRefine((evidence, context) => {
  for (const key of ["observations", "metrics", "artifact_evaluations", "criterion_results", "protected_surface_results"] as const) {
    const values = evidence[key];
    if (new Set(values.map((item) => item.id)).size !== values.length) {
      context.addIssue({ code: "custom", path: [key], message: `${key} IDs must be unique` });
    }
  }
  const criterionIds = new Set(evidence.criterion_results.map((item) => item.id));
  const protectedIds = new Set(evidence.protected_surface_results.map((item) => item.id));
  if ([...criterionIds].some((id) => protectedIds.has(id))) {
    context.addIssue({ code: "custom", path: ["protected_surface_results"], message: "criterion and protected-surface evidence IDs must be disjoint" });
  }
});
export type RoundEvidence = z.infer<typeof roundEvidenceSchema>;

export const roundAuditResultSchema = z.object({
  kind: z.literal("jevrev.round-audit-result"),
  schema_version: z.literal("1"),
  loop_id: loopIdSchema,
  round_number: z.number().int().positive(),
  audit_mode: z.enum(["progress", "completion"]),
  outcome: z.enum(["continue", "fix_regression", "verify", "replan", "waiting_human", "budget_paused", "completed"]),
  criteria: z.array(z.object({ id, status: z.enum(["pass", "fail", "unknown"]), score: z.number().min(0).max(1).nullable(), confidence: z.number().min(0).max(1).nullable(), source: z.enum(["command", "metric", "jev", "artifact"]), freshness: z.enum(["fresh", "carried_forward"]) }).strict()).min(1).max(40),
  blocking_criteria: z.array(id),
  next_action: z.object({ type: z.enum(["continue", "fix_regression", "verify", "replan", "ask_human", "wait_budget", "stop_success"]), focus_criteria: z.array(id), reason: label }).strict(),
  material_progress: z.boolean(),
  evidence_sha256: digest,
  spec_sha256: digest,
  provider_profile: label,
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(),
}).strict().superRefine((audit, context) => {
  if (new Set(audit.criteria.map((criterion) => criterion.id)).size !== audit.criteria.length || new Set(audit.blocking_criteria).size !== audit.blocking_criteria.length) {
    context.addIssue({ code: "custom", path: ["criteria"], message: "audit criterion and blocking IDs must be unique" });
  }
  const actionForOutcome = {
    continue: "continue", fix_regression: "fix_regression", verify: "verify", replan: "replan",
    waiting_human: "ask_human", budget_paused: "wait_budget", completed: "stop_success",
  } as const;
  if (audit.next_action.type !== actionForOutcome[audit.outcome]) {
    context.addIssue({ code: "custom", path: ["next_action", "type"], message: "next action must match audit outcome" });
  }
  if (audit.outcome === "completed" && (audit.audit_mode !== "completion" || audit.blocking_criteria.length > 0 || audit.next_action.type !== "stop_success" || audit.criteria.some((criterion) => criterion.status !== "pass" || criterion.freshness !== "fresh"))) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "only an unblocked completion audit may complete" });
  }
  if (audit.outcome !== "completed" && audit.next_action.type === "stop_success") {
    context.addIssue({ code: "custom", path: ["next_action"], message: "stop_success requires completed" });
  }
});
export type RoundAuditResult = z.infer<typeof roundAuditResultSchema>;
