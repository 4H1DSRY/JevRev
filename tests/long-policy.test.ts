import { describe, expect, it } from "vitest";
import { normalizeExternalEvent } from "../src/long/normalize.js";
import { evaluateLongPolicy } from "../src/long/policy.js";
import type { LongSpec } from "../src/long/schemas.js";
import type { SignalResult } from "../src/long/signals.js";

const spec: LongSpec = {
  kind: "jevrev.long-spec", schema_version: "1", revision: 1, session_id: "jvlng_4444444444444444", title: "Policy", goal: "Ship", workspace: ".", allowed_scope: ["src"], protected_surfaces: [{ id: "api", description: "API", paths: ["src/api"] }], milestones: [], budget: { max_wall_ms: 1000, max_provider_tokens: 100, max_tool_calls: 10 }, thresholds: { stall_after_ms: 1000, heartbeat_after_ms: 100, repeated_failure_window: 1000, repeated_failure_count: 2, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 1000 }, alert_policy: { cooldown_ms: 100, max_open_alerts: 4, max_alert_history: 20, severity_escalation_window: 1000 }, observer_budget: { provider: "none", max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 1000, min_interval_ms: 100, max_context_bytes: 1000 },
};
const evaluatedAt = new Date("2026-09-22T12:00:10.000Z");
function signal(overrides: Partial<SignalResult> = {}): SignalResult { return { activity: "active", stall_score: 0, failure_score: 0, drift_score: 0, budget_risk: 0, progress_index: "unknown", open_tool_calls: 0, evidence_event_ids: {}, cost: { wall_ms: 0, provider_tokens: 0, tool_calls: 0 }, ...overrides }; }
function event(id: string) { return normalizeExternalEvent({ adapter_id: "test", adapter_event_id: id, event_type: "heartbeat", payload: {} }, { spec, receivedAt: evaluatedAt }); }

describe("JevLong alert policy", () => {
  it("raises one alert and coalesces repeated evaluations", () => {
    const first = evaluateLongPolicy(spec, signal({ failure_score: 1, evidence_event_ids: { failure: ["a"] } }), [event("a")], { alerts: [] }, evaluatedAt);
    expect(first.raised).toHaveLength(1);
    const second = evaluateLongPolicy(spec, signal({ failure_score: 1, evidence_event_ids: { failure: ["b"] } }), [event("b")], { alerts: first.alerts }, new Date(evaluatedAt.getTime() + 100));
    expect(second.raised).toHaveLength(0);
    expect(second.alerts[0]).toMatchObject({ occurrence_count: 2, status: "open" });
  });
  it("recovers only the matching condition", () => {
    const raised = evaluateLongPolicy(spec, signal({ failure_score: 1 }), [event("a")], { alerts: [] }, evaluatedAt);
    const recovered = evaluateLongPolicy(spec, signal(), [event("b")], { alerts: raised.alerts }, new Date(evaluatedAt.getTime() + 100));
    expect(recovered.recovered).toHaveLength(1);
    expect(recovered.alerts[0]?.status).toBe("recovered");
  });
  it("does not close a stall merely because a heartbeat arrived", () => {
    const raised = evaluateLongPolicy(spec, signal({ stall_score: 1 }), [event("a")], { alerts: [] }, evaluatedAt);
    const heartbeat = evaluateLongPolicy(spec, signal({ activity: "active", stall_score: 1 }), [event("b")], { alerts: raised.alerts }, new Date(evaluatedAt.getTime() + 100));
    expect(heartbeat.alerts.find((alert) => alert.kind === "stall")?.status).toBe("open");
  });
  it("does not increment an alert when the same journal is merely re-read", () => {
    const raised = evaluateLongPolicy(spec, signal({ failure_score: 1, evidence_event_ids: { failure: ["a"] } }), [event("a")], { alerts: [] }, evaluatedAt);
    const reread = evaluateLongPolicy(spec, signal({ failure_score: 1, evidence_event_ids: { failure: ["a"] } }), [event("a")], { alerts: raised.alerts }, new Date(evaluatedAt.getTime() + 100));
    expect(reread.alerts[0]?.occurrence_count).toBe(1);
  });
  it("raises a protocol alert for an unknown event", () => {
    const result = evaluateLongPolicy(spec, signal({ evidence_event_ids: { protocol: ["unknown"] } }), [event("unknown")], { alerts: [] }, evaluatedAt);
    expect(result.raised.some((alert) => alert.kind === "protocol")).toBe(true);
  });
  it("limits retained alert history", () => {
    const limited = { ...spec, alert_policy: { ...spec.alert_policy, max_alert_history: 1 } };
    const result = evaluateLongPolicy(limited, signal({ drift_score: 1, evidence_event_ids: { drift: ["x"] } }), [event("x")], { alerts: [] }, evaluatedAt);
    expect(result.alerts.length).toBeLessThanOrEqual(1);
  });
});
