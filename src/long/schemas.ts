import { createHash } from "node:crypto";
import { z } from "zod";

export const longSessionIdSchema = z.string().regex(/^jvlng_[a-f0-9]{16}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(2_000);
const shortLabel = z.string().trim().min(1).max(256);
const relativePath = z.string().trim().min(1).max(1_000).refine(
  (value) => !/^(?:[a-zA-Z]:|[\\/]{1,2})/.test(value) &&
    !value.split(/[\\/]+/).includes("..") &&
    !/[\u0000-\u001f\u007f]/.test(value),
  "must be a safe workspace-relative path",
);

export const longBudgetSchema = z.object({
  max_wall_ms: z.number().int().positive().max(2_592_000_000),
  max_provider_tokens: z.number().int().nonnegative().max(100_000_000),
  max_tool_calls: z.number().int().nonnegative().max(10_000_000),
}).strict();

export const longThresholdsSchema = z.object({
  stall_after_ms: z.number().int().positive().max(86_400_000),
  heartbeat_after_ms: z.number().int().positive().max(86_400_000),
  repeated_failure_window: z.number().int().positive().max(86_400_000),
  repeated_failure_count: z.number().int().min(2).max(1_000),
  drift_warning_score: z.number().min(0).max(1),
  budget_warning_fraction: z.number().gt(0).lte(1),
  max_clock_skew_ms: z.number().int().nonnegative().max(86_400_000),
}).strict();

export const longAlertPolicySchema = z.object({
  cooldown_ms: z.number().int().nonnegative().max(86_400_000),
  max_open_alerts: z.number().int().positive().max(1_000),
  max_alert_history: z.number().int().positive().max(100_000),
  severity_escalation_window: z.number().int().positive().max(86_400_000),
}).strict();

export const longObserverBudgetSchema = z.object({
  provider: z.enum(["none", "jev", "local"]),
  max_calls: z.number().int().nonnegative().max(10_000),
  max_tokens: z.number().int().nonnegative().max(10_000_000),
  max_wall_ms: z.number().int().nonnegative().max(86_400_000),
  timeout_ms: z.number().int().positive().max(300_000),
  min_interval_ms: z.number().int().nonnegative().max(86_400_000),
  max_context_bytes: z.number().int().positive().max(1_000_000),
}).strict().superRefine((budget, context) => {
  if (budget.provider === "none" && budget.max_calls !== 0) {
    context.addIssue({ code: "custom", path: ["max_calls"], message: "provider none requires max_calls 0" });
  }
});

export const longMilestoneSchema = z.object({
  id,
  description: label,
  evidence_tags: z.array(shortLabel).max(16),
}).strict();

export const longProtectedSurfaceSchema = z.object({ id, description: label, paths: z.array(relativePath).min(1).max(32) }).strict();

export const longSpecSchema = z.object({
  kind: z.literal("jevrev.long-spec"),
  schema_version: z.literal("1"),
  revision: z.number().int().positive(),
  session_id: longSessionIdSchema,
  title: label,
  goal: label,
  context: z.string().max(4_000).optional(),
  workspace: relativePath,
  allowed_scope: z.array(relativePath).max(128),
  protected_surfaces: z.array(longProtectedSurfaceSchema).max(64),
  milestones: z.array(longMilestoneSchema).max(64),
  budget: longBudgetSchema,
  thresholds: longThresholdsSchema,
  alert_policy: longAlertPolicySchema,
  observer_budget: longObserverBudgetSchema,
}).strict().superRefine((spec, context) => {
  const allIds = [
    ...spec.milestones.map((milestone) => milestone.id),
    ...spec.protected_surfaces.map((surface) => surface.id),
  ];
  if (new Set(allIds).size !== allIds.length) {
    context.addIssue({ code: "custom", path: ["milestones"], message: "milestone and protected surface IDs must be unique" });
  }
  if (new Set(spec.allowed_scope).size !== spec.allowed_scope.length ||
      spec.protected_surfaces.some((surface) => new Set(surface.paths).size !== surface.paths.length)) {
    context.addIssue({ code: "custom", path: ["allowed_scope"], message: "scope and protected paths must be unique" });
  }
  if (spec.thresholds.heartbeat_after_ms > spec.thresholds.stall_after_ms) {
    context.addIssue({ code: "custom", path: ["thresholds"], message: "heartbeat threshold cannot exceed stall threshold" });
  }
  if (spec.thresholds.budget_warning_fraction <= 0 || spec.thresholds.budget_warning_fraction > 1) {
    context.addIssue({ code: "custom", path: ["thresholds", "budget_warning_fraction"], message: "budget warning fraction must be in (0, 1]" });
  }
});
export type LongSpec = z.infer<typeof longSpecSchema>;

export const longSourceSchema = z.enum(["recorded", "imported", "self_reported"]);
export type LongSource = z.infer<typeof longSourceSchema>;

export const LONG_KNOWN_EVENT_TYPES = [
  "session_started", "heartbeat", "assistant_turn", "tool_started", "tool_finished",
  "file_change", "test_result", "milestone", "provider_error", "human_input",
  "session_finished", "loop_audit", "metric", "unknown_event",
] as const;

export function isKnownLongEventType(value: string): boolean {
  return (LONG_KNOWN_EVENT_TYPES as readonly string[]).includes(value);
}

const eventBaseSchema = z.object({
  kind: z.literal("jevrev.long-event"),
  schema_version: z.literal("1"),
  session_id: longSessionIdSchema,
  sequence: z.number().int().positive(),
  event_id: id,
  adapter_id: id,
  adapter_event_id: id,
  occurred_at: z.string().datetime({ offset: true }),
  received_at: z.string().datetime({ offset: true }),
  spec_revision: z.number().int().positive(),
  spec_sha256: digest,
  source: longSourceSchema,
  event_type: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  payload_sha256: digest,
}).strict();

const eventPayloadSchema = z.object({
  data: z.record(z.string().max(64), z.json()).optional(),
  opaque_digest: digest.optional(),
}).strict().superRefine((payload, context) => {
  if (payload.data === undefined && payload.opaque_digest === undefined) {
    context.addIssue({ code: "custom", path: [], message: "event payload needs data or opaque_digest" });
  }
  if (payload.data !== undefined && payload.opaque_digest !== undefined) {
    context.addIssue({ code: "custom", path: [], message: "event payload cannot contain both data and opaque_digest" });
  }
  if (JSON.stringify(payload).length > 60_000) {
    context.addIssue({ code: "custom", path: [], message: "event payload exceeds 60 KiB" });
  }
});

export const longEventSchema = eventBaseSchema.extend({ payload: eventPayloadSchema }).strict().superRefine((event, context) => {
  if (event.payload_sha256 !== longHash(event.payload)) {
    context.addIssue({ code: "custom", path: ["payload_sha256"], message: "payload digest does not match canonical payload" });
  }
});
export type LongEvent = z.infer<typeof longEventSchema>;

export const longExternalEventSchema = longEventSchema.superRefine((event, context) => {
  if (event.source === "recorded") {
    context.addIssue({ code: "custom", path: ["source"], message: "external ingest cannot claim recorded provenance" });
  }
});

export const longAlertKindSchema = z.enum([
  "stall", "silent", "failure_loop", "drift", "protected_surface",
  "fatal_error", "budget_risk", "human_attention", "protocol",
]);
export const longSeveritySchema = z.enum(["info", "notice", "high", "critical"]);
export const longAlertStatusSchema = z.enum(["open", "acknowledged", "recovered", "closed"]);

export const longAlertSchema = z.object({
  id,
  kind: longAlertKindSchema,
  severity: longSeveritySchema,
  status: longAlertStatusSchema,
  identity_key: shortLabel,
  reason_code: id,
  message: shortLabel,
  first_sequence: z.number().int().positive(),
  last_sequence: z.number().int().positive(),
  occurrence_count: z.number().int().positive(),
  evidence_event_ids: z.array(id).max(64),
  raised_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict().superRefine((alert, context) => {
  if (alert.last_sequence < alert.first_sequence) {
    context.addIssue({ code: "custom", path: ["last_sequence"], message: "last sequence cannot precede first sequence" });
  }
  if (alert.status === "closed" && alert.occurrence_count < 1) {
    context.addIssue({ code: "custom", path: ["occurrence_count"], message: "closed alert must retain its occurrence count" });
  }
  if (Date.parse(alert.updated_at) < Date.parse(alert.raised_at)) {
    context.addIssue({ code: "custom", path: ["updated_at"], message: "updated time cannot precede raised time" });
  }
});
export type LongAlert = z.infer<typeof longAlertSchema>;

export const longLifecycleSchema = z.enum(["created", "observing", "ended", "aborted"]);
export const longProgressSchema = z.union([z.number().min(0).max(1), z.literal("unknown")]);

export const longSnapshotSchema = z.object({
  kind: z.literal("jevrev.long-snapshot"),
  schema_version: z.literal("1"),
  session_id: longSessionIdSchema,
  sequence: z.number().int().nonnegative(),
  spec_revision: z.number().int().positive(),
  spec_sha256: digest,
  lifecycle: longLifecycleSchema,
  evaluated_at: z.string().datetime({ offset: true }),
  last_event_at: z.string().datetime({ offset: true }).nullable(),
  open_tool_calls: z.number().int().nonnegative().max(512),
  indicators: z.object({
    activity: z.enum(["active", "quiet", "silent"]),
    stall_score: z.number().min(0).max(1),
    failure_score: z.number().min(0).max(1),
    drift_score: z.number().min(0).max(1),
    budget_risk: z.number().min(0).max(1),
    progress_index: longProgressSchema,
  }).strict(),
  open_alerts: z.array(longAlertSchema).max(64),
  acknowledged_alerts: z.array(longAlertSchema).max(10_000),
  cost: z.object({
    wall_ms: z.number().int().nonnegative(),
    provider_tokens: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((snapshot, context) => {
  const alertIds = [...snapshot.open_alerts, ...snapshot.acknowledged_alerts].map((alert) => alert.id);
  if (new Set(alertIds).size !== alertIds.length) {
    context.addIssue({ code: "custom", path: ["open_alerts"], message: "an alert cannot appear more than once in a snapshot" });
  }
  if (snapshot.open_alerts.some((alert) => alert.status !== "open")) {
    context.addIssue({ code: "custom", path: ["open_alerts"], message: "open_alerts must contain only open alerts" });
  }
  if (snapshot.acknowledged_alerts.some((alert) => alert.status !== "acknowledged")) {
    context.addIssue({ code: "custom", path: ["acknowledged_alerts"], message: "acknowledged_alerts must contain only acknowledged alerts" });
  }
  if (snapshot.last_event_at !== null && Date.parse(snapshot.evaluated_at) < Date.parse(snapshot.last_event_at)) {
    context.addIssue({ code: "custom", path: ["evaluated_at"], message: "evaluation time cannot precede last event time" });
  }
});
export type LongSnapshot = z.infer<typeof longSnapshotSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function longHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
