import { InputError } from "../domain/errors.js";
import { isKnownLongEventType, longEventSchema, longSpecSchema, type LongEvent, type LongSpec, type LongSnapshot } from "./schemas.js";
import type { LongEventDraft } from "./normalize.js";

export interface SignalOptions { evaluatedAt: Date; previous?: LongSnapshot | null }
export interface SignalResult {
  activity: "active" | "quiet" | "silent";
  stall_score: number;
  failure_score: number;
  drift_score: number;
  budget_risk: number;
  progress_index: number | "unknown";
  open_tool_calls: number;
  evidence_event_ids: Record<string, string[]>;
  cost: { wall_ms: number; provider_tokens: number; tool_calls: number };
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
const MAX_OPEN_TOOL_CALLS = 512;
function eventData(event: LongEvent): Record<string, unknown> { return event.payload.data ?? {}; }
function dataString(event: LongEvent, key: string): string | undefined {
  const value = eventData(event)[key]; return typeof value === "string" ? value : undefined;
}
function dataNumber(event: LongEvent, key: string): number | undefined {
  const value = eventData(event)[key]; return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function invalidMeasurement(event: LongEvent): boolean {
  return ["duration_ms", "provider_tokens"].some((key) => {
    const value = eventData(event)[key];
    return typeof value === "number" && (!Number.isFinite(value) || value < 0);
  });
}
function pathWithin(path: string, scope: string): boolean {
  const normalizedScope = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalizedScope === "." || path === normalizedScope || path.startsWith(`${normalizedScope}/`);
}

export function reduceLongSignals(specInput: LongSpec, eventsInput: readonly (LongEvent | LongEventDraft)[], options: SignalOptions): SignalResult {
  const spec = longSpecSchema.parse(specInput);
  const events = eventsInput.map((event, index) => longEventSchema.parse({ ...event, sequence: "sequence" in event ? event.sequence : index + 1 }));
  if (!Number.isFinite(options.evaluatedAt.getTime())) throw new InputError("Signal evaluation time is invalid");
  const evaluatedMs = options.evaluatedAt.getTime();
  const observedEvents = events.filter((event) => Date.parse(event.received_at) <= evaluatedMs);
  const last = observedEvents.at(-1);
  const lastMeaningful = [...observedEvents].reverse().find((event) => ["tool_finished", "test_result", "file_change", "milestone", "human_input", "loop_audit"].includes(event.event_type));
  const lastActivityMs = lastMeaningful === undefined ? undefined : Date.parse(lastMeaningful.received_at);
  const producerActivityMs = last === undefined ? undefined : Date.parse(last.received_at);
  const age = lastActivityMs === undefined
    ? last === undefined ? Number.POSITIVE_INFINITY : Math.max(0, evaluatedMs - Date.parse(last.received_at))
    : Math.max(0, evaluatedMs - lastActivityMs);
  const openCalls = new Set<string>();
  const changedPaths: string[] = [];
  const invalidMeasurementEventIds: string[] = [];
  const passedMilestones = new Set<string>();
  let toolCalls = 0;
  let providerTokens = 0;
  let wallMs = 0;
  for (const event of observedEvents) {
    const data = eventData(event);
    if (invalidMeasurement(event)) invalidMeasurementEventIds.push(event.event_id);
    if (event.event_type === "tool_started") { const callId = dataString(event, "call_id"); if (callId !== undefined) openCalls.add(callId); toolCalls += 1; }
    if (event.event_type === "tool_finished") { const callId = dataString(event, "call_id"); if (callId !== undefined) openCalls.delete(callId); }
    if (event.event_type === "file_change") { const path = dataString(event, "path"); if (path !== undefined) changedPaths.push(path); }
    if (event.event_type === "milestone" && event.source === "recorded" && dataString(event, "status") === "passed") {
      const milestoneId = dataString(event, "milestone_id"); if (milestoneId !== undefined) passedMilestones.add(milestoneId);
    }
    providerTokens += dataNumber(event, "provider_tokens") ?? 0;
    wallMs += dataNumber(event, "duration_ms") ?? 0;
  }
  if (openCalls.size > MAX_OPEN_TOOL_CALLS) throw new InputError(`Long session has more than ${MAX_OPEN_TOOL_CALLS} open tool calls`);
  const failureWindowStart = evaluatedMs - spec.thresholds.repeated_failure_window;
  const failureEvents = observedEvents.filter((event) => {
    const receivedAt = Date.parse(event.received_at);
    return receivedAt >= failureWindowStart && receivedAt <= evaluatedMs &&
      (event.event_type === "provider_error" || event.event_type === "test_result") &&
      ((dataString(event, "status") ?? dataString(event, "category") ?? "failure") === "fail" ||
        (dataString(event, "status") ?? dataString(event, "category") ?? "failure") === "failed" ||
        (dataString(event, "status") ?? dataString(event, "category") ?? "failure") === "error" || event.event_type === "provider_error");
  });
  const failureGroups = new Map<string, string[]>();
  for (const event of failureEvents) {
    const status = dataString(event, "status") ?? dataString(event, "category") ?? "failure";
    const fingerprint = `${event.event_type}:${dataString(event, "command_id") ?? dataString(event, "provider") ?? status}`;
    failureGroups.set(fingerprint, [...(failureGroups.get(fingerprint) ?? []), event.event_id]);
  }
  const failureCount = failureEvents.length;
  const repeated = [...failureGroups.values()].filter((ids) => ids.length >= spec.thresholds.repeated_failure_count).flat();
  const driftPaths = changedPaths.filter((path) => !spec.allowed_scope.some((scope) => pathWithin(path, scope)));
  const protectedPaths = spec.protected_surfaces.flatMap((surface) => surface.paths);
  const protectedChanges = changedPaths.filter((path) => protectedPaths.some((protectedPath) => pathWithin(path, protectedPath)));
  const driftScore = clamp((driftPaths.length + protectedChanges.length * 2) / Math.max(1, changedPaths.length + 2));
  const stallScore = openCalls.size > 0 && age < spec.thresholds.stall_after_ms ? 0 : clamp(age / spec.thresholds.stall_after_ms);
  const failureScore = clamp((failureCount + repeated.length) / Math.max(1, spec.thresholds.repeated_failure_count * 2));
  const budgetFraction = (used: number, limit: number): number => limit === 0 ? (used > 0 ? 1 : 0) : used / limit;
  const budgetRisk = clamp(Math.max(
    budgetFraction(wallMs, spec.budget.max_wall_ms),
    budgetFraction(providerTokens, spec.budget.max_provider_tokens),
    budgetFraction(toolCalls, spec.budget.max_tool_calls),
  ) / spec.thresholds.budget_warning_fraction);
  const producerAge = producerActivityMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, evaluatedMs - producerActivityMs);
  const activity = producerAge > spec.thresholds.heartbeat_after_ms ? "silent" : age >= spec.thresholds.stall_after_ms ? "quiet" : "active";
  const progress = spec.milestones.length === 0 ? "unknown" : passedMilestones.size / spec.milestones.length;
  return {
    activity, stall_score: stallScore, failure_score: failureScore, drift_score: driftScore, budget_risk: budgetRisk,
    progress_index: progress, open_tool_calls: openCalls.size,
    evidence_event_ids: {
      failure: repeated,
      drift: [...new Set([...driftPaths, ...protectedChanges])].flatMap((path) => observedEvents.filter((event) => dataString(event, "path") === path).map((event) => event.event_id)),
      protected: [...new Set(protectedChanges)].flatMap((path) => observedEvents.filter((event) => dataString(event, "path") === path).map((event) => event.event_id)),
      protocol: [...new Set([
        ...observedEvents.filter((event) => event.event_type === "unknown_event" || !isKnownLongEventType(event.event_type)).map((event) => event.event_id),
        ...invalidMeasurementEventIds,
      ])],
      progress: observedEvents.filter((event) => event.event_type === "milestone" && event.source === "recorded").map((event) => event.event_id),
    },
    cost: { wall_ms: wallMs, provider_tokens: providerTokens, tool_calls: toolCalls },
  };
}
