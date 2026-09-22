import { describe, expect, it } from "vitest";
import { normalizeExternalEvent } from "../src/long/normalize.js";
import { longHash, type LongSpec } from "../src/long/schemas.js";

const spec: LongSpec = {
  kind: "jevrev.long-spec", schema_version: "1", revision: 2, session_id: "jvlng_0123456789abcdef", title: "Session", goal: "Ship", workspace: ".",
  allowed_scope: ["src"], protected_surfaces: [], milestones: [],
  budget: { max_wall_ms: 10_000, max_provider_tokens: 100, max_tool_calls: 20 },
  thresholds: { stall_after_ms: 1000, heartbeat_after_ms: 100, repeated_failure_window: 1000, repeated_failure_count: 2, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 1000 },
  alert_policy: { cooldown_ms: 1000, max_open_alerts: 4, max_alert_history: 20, severity_escalation_window: 1000 },
  observer_budget: { provider: "none", max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 1000, min_interval_ms: 1000, max_context_bytes: 1000 },
};
const now = new Date("2026-09-22T12:00:00.000Z");

describe("JevLong external normalizer", () => {
  it("forces imported provenance, binds spec, stamps receive time, and computes digests", () => {
    const result = normalizeExternalEvent({ adapter_id: "Codex", adapter_event_id: "ABC-1", event_type: "heartbeat", source: "recorded", payload: { note: "alive" } }, { spec, receivedAt: now });
    expect(result).toMatchObject({ source: "imported", adapter_id: "codex", adapter_event_id: "abc-1", received_at: now.toISOString(), spec_revision: 2, spec_sha256: longHash(spec) });
    expect(result.payload_sha256).toBe(longHash(result.payload));
  });

  it("redacts nested secrets before hashing", () => {
    const result = normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "1", event_type: "assistant_turn", payload: { auth: { api_key: "sk-secret-value" }, nested: [{ token: "Bearer abc" }], note: "safe" } }, { spec, receivedAt: now });
    const payload = JSON.stringify(result.payload);
    expect(payload).not.toContain("sk-secret-value");
    expect(payload).not.toContain("Bearer abc");
    expect(payload).toContain("[REDACTED]");
    const headers = normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "headers", event_type: "assistant_turn", payload: { authorization: "Bearer abc123SECRET", fallback: "Basic dXNlcjpwYXNz" } }, { spec, receivedAt: now });
    expect(JSON.stringify(headers.payload)).not.toContain("abc123SECRET");
    expect(JSON.stringify(headers.payload)).not.toContain("dXNlcjpwYXNz");
  });

  it("maps an unknown adapter event to a protocol-visible unknown_event", () => {
    const result = normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "mystery", event_type: "agent_magic", payload: {} }, { spec, receivedAt: now });
    expect(result.event_type).toBe("unknown_event");
    expect(result.payload.data).toMatchObject({ original_event_type: "agent_magic" });
  });

  it("rejects future timestamps beyond the frozen skew", () => {
    expect(() => normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "1", event_type: "heartbeat", occurred_at: "2026-09-22T12:00:02.000Z", payload: {} }, { spec, receivedAt: now })).toThrow("future");
  });

  it("rejects deep, oversized, cyclic, and malformed input without side effects", () => {
    expect(() => normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "1", event_type: "heartbeat", payload: { text: "x".repeat(60_001) } }, { spec, receivedAt: now })).toThrow();
    expect(() => normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "emoji", event_type: "heartbeat", payload: { text: "😀".repeat(20_000) } }, { spec, receivedAt: now })).toThrow();
    let value: Record<string, unknown> = {};
    let cursor = value;
    for (let index = 0; index < 10; index += 1) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
    expect(() => normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "2", event_type: "heartbeat", payload: value }, { spec, receivedAt: now })).toThrow("depth");
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "3", event_type: "heartbeat", payload: cyclic }, { spec, receivedAt: now })).toThrow("cyclic");
    expect(() => normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: "4", event_type: "bad type", payload: {} }, { spec, receivedAt: now })).toThrow("Invalid external");
  });
});
