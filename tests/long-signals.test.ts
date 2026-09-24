import { describe, expect, it } from "vitest";
import { normalizeExternalEvent } from "../src/long/normalize.js";
import { reduceLongSignals } from "../src/long/signals.js";
import type { LongSpec } from "../src/long/schemas.js";

const spec: LongSpec = {
  kind: "jevrev.long-spec", schema_version: "1", revision: 1, session_id: "jvlng_3333333333333333", title: "Signals", goal: "Ship", workspace: ".", allowed_scope: ["src"], protected_surfaces: [{ id: "api", description: "API", paths: ["src/api"] }], milestones: [{ id: "tests", description: "Tests", evidence_tags: ["test"] }],
  budget: { max_wall_ms: 1000, max_provider_tokens: 100, max_tool_calls: 10 }, thresholds: { stall_after_ms: 1000, heartbeat_after_ms: 200, repeated_failure_window: 1000, repeated_failure_count: 3, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 1000 }, alert_policy: { cooldown_ms: 100, max_open_alerts: 4, max_alert_history: 20, severity_escalation_window: 1000 }, observer_budget: { provider: "none", max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 1000, min_interval_ms: 100, max_context_bytes: 1000 },
};
const at = new Date("2026-09-22T12:00:10.000Z");
function event(type: string, id: string, payload: Record<string, unknown>, source: "imported" | "self_reported" = "imported") {
  return normalizeExternalEvent({ adapter_id: "test", adapter_event_id: id, event_type: type, payload }, { spec, receivedAt: new Date(Date.parse("2026-09-22T12:00:09.000Z")), source });
}

describe("JevLong deterministic signals", () => {
  it("returns unknown progress without milestones and does not treat heartbeat as progress", () => {
    const result = reduceLongSignals({ ...spec, milestones: [] }, [event("heartbeat", "h", {})], { evaluatedAt: at });
    expect(result.progress_index).toBe("unknown");
    expect(result.activity).toBe("silent");
  });
  it("keeps an open tool active before stall threshold", () => {
    const result = reduceLongSignals(spec, [event("tool_started", "start", { call_id: "call-1" })], { evaluatedAt: new Date("2026-09-22T12:00:09.500Z") });
    expect(result.open_tool_calls).toBe(1);
    expect(result.stall_score).toBe(0);
  });
  it("detects repeated failures, protected drift, and budget risk", () => {
    const events = [
      event("test_result", "f1", { status: "failed", command_id: "npm-test" }),
      event("test_result", "f2", { status: "failed", command_id: "npm-test" }),
      event("test_result", "f3", { status: "failed", command_id: "npm-test" }),
      event("file_change", "drift", { path: "docs/readme.md" }),
      event("file_change", "protected", { path: "src/api/public.ts" }),
      event("tool_started", "tool", { call_id: "call-1", provider_tokens: 100, duration_ms: 1000 }),
    ];
    const result = reduceLongSignals(spec, events, { evaluatedAt: at });
    expect(result.failure_score).toBeGreaterThan(0.5);
    expect(result.drift_score).toBeGreaterThan(0.5);
    expect(result.budget_risk).toBe(1);
    expect(result.evidence_event_ids.failure).toHaveLength(3);
  });
  it("uses the failure window and treats recent producer events as activity", () => {
    const old = normalizeExternalEvent({ adapter_id: "test", adapter_event_id: "old", event_type: "test_result", payload: { status: "failed", command_id: "npm-test" } }, { spec, receivedAt: new Date("2026-09-22T11:59:00.000Z") });
    const recent = normalizeExternalEvent({ adapter_id: "test", adapter_event_id: "recent", event_type: "file_change", payload: { path: "src/parser.ts" } }, { spec, receivedAt: new Date("2026-09-22T12:00:09.950Z") });
    const result = reduceLongSignals(spec, [old, recent], { evaluatedAt: at });
    expect(result.failure_score).toBe(0);
    expect(result.activity).toBe("active");
  });
  it("raises zero-budget risk when usage is non-zero", () => {
    const zeroBudget = { ...spec, budget: { ...spec.budget, max_provider_tokens: 0, max_tool_calls: 0 } };
    const result = reduceLongSignals(zeroBudget, [event("assistant_turn", "tokens", { provider_tokens: 1 })], { evaluatedAt: at });
    expect(result.budget_risk).toBe(1);
  });
  it("raises a protocol signal for negative resource measurements", () => {
    const result = reduceLongSignals(spec, [event("tool_finished", "bad-metric", { call_id: "call-1", duration_ms: -1, provider_tokens: -2 })], { evaluatedAt: at });
    expect(result.cost.wall_ms).toBe(0);
    expect(result.cost.provider_tokens).toBe(0);
    expect(result.evidence_event_ids.protocol).toHaveLength(1);
    expect(result.evidence_event_ids.protocol[0]).toMatch(/^evt-/);
  });
  it("accepts metric telemetry without raising an unknown-event protocol signal", () => {
    const result = reduceLongSignals(spec, [event("metric", "throughput", { name: "events_per_second", value: 42, provider_tokens: 12 })], { evaluatedAt: at });
    expect(result.evidence_event_ids.protocol).toHaveLength(0);
    expect(result.cost.provider_tokens).toBe(12);
  });
  it("treats the workspace root scope as covering all relative paths", () => {
    const rootScoped = { ...spec, allowed_scope: ["."] };
    const result = reduceLongSignals(rootScoped, [event("file_change", "root-file", { path: "src/parser.ts" })], { evaluatedAt: at });
    expect(result.drift_score).toBe(0);
  });
  it("counts only recorded passed milestones as progress", () => {
    const imported = event("milestone", "m-imported", { milestone_id: "tests", status: "passed" }, "imported");
    const recorded = event("milestone", "m-recorded", { milestone_id: "tests", status: "passed" }, "self_reported");
    expect(reduceLongSignals(spec, [imported, recorded], { evaluatedAt: at }).progress_index).toBe(0);
    const trusted = { ...recorded, source: "recorded" as const };
    expect(reduceLongSignals(spec, [{ ...trusted }], { evaluatedAt: at }).progress_index).toBe(1);
  });
});
