import { describe, expect, it } from "vitest";
import {
  longAlertSchema,
  longEventSchema,
  longExternalEventSchema,
  longHash,
  longSnapshotSchema,
  longSpecSchema,
  type LongSpec,
} from "../src/long/schemas.js";

const spec: LongSpec = {
  kind: "jevrev.long-spec", schema_version: "1", revision: 1,
  session_id: "jvlng_0123456789abcdef", title: "Parser session", goal: "Make parser faster", workspace: ".",
  allowed_scope: ["src", "tests"], protected_surfaces: [{ id: "public-api", description: "Public API", paths: ["src/public"] }],
  milestones: [{ id: "baseline", description: "Baseline captured", evidence_tags: ["benchmark"] }],
  budget: { max_wall_ms: 86_400_000, max_provider_tokens: 10_000, max_tool_calls: 1_000 },
  thresholds: { stall_after_ms: 60_000, heartbeat_after_ms: 10_000, repeated_failure_window: 300_000, repeated_failure_count: 3, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 30_000 },
  alert_policy: { cooldown_ms: 30_000, max_open_alerts: 64, max_alert_history: 10_000, severity_escalation_window: 300_000 },
  observer_budget: { provider: "none", max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 10_000, min_interval_ms: 30_000, max_context_bytes: 32_000 },
};

const event = {
  kind: "jevrev.long-event", schema_version: "1", session_id: spec.session_id,
  sequence: 1, event_id: "evt-1", adapter_id: "jsonl", adapter_event_id: "adapter-1",
  occurred_at: "2026-09-22T12:00:00.000Z", received_at: "2026-09-22T12:00:00.100Z",
  spec_revision: 1, spec_sha256: longHash(spec), source: "imported" as const,
  event_type: "heartbeat", payload_sha256: "".padStart(64, "0"), payload: { data: { adapter_seq: 1 } },
};
event.payload_sha256 = longHash(event.payload);

describe("JevLong contracts", () => {
  it("accepts a bounded deterministic spec and event", () => {
    expect(longSpecSchema.parse(spec)).toEqual(spec);
    expect(longEventSchema.parse(event)).toEqual(event);
    expect(longHash(spec)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses canonical key ordering for hashes and rejects forged external provenance", () => {
    expect(longHash({ a: 1, b: 2 })).toBe(longHash({ b: 2, a: 1 }));
    expect(longExternalEventSchema.safeParse({ ...event, source: "recorded" }).success).toBe(false);
  });

  it.each(["C:relative.txt", "C:\\secret.txt", "\\\\server\\share", "../outside", "src/../../outside", "src/\u0000bad"]) (
    "rejects unsafe workspace path %s", (path) => {
      expect(longSpecSchema.safeParse({ ...spec, workspace: path }).success).toBe(false);
    },
  );

  it("rejects duplicate milestone/protected IDs and invalid threshold ordering", () => {
    expect(longSpecSchema.safeParse({ ...spec, protected_surfaces: [{ id: "baseline", description: "collision", paths: ["src/collision"] }] }).success).toBe(false);
    expect(longSpecSchema.safeParse({ ...spec, thresholds: { ...spec.thresholds, heartbeat_after_ms: 100_000, stall_after_ms: 10_000 } }).success).toBe(false);
    expect(longSpecSchema.safeParse({ ...spec, observer_budget: { ...spec.observer_budget, provider: "none", max_calls: 1 } }).success).toBe(false);
  });

  it("requires an explicit payload and bounds oversized payloads", () => {
    expect(longEventSchema.safeParse({ ...event, payload: {} }).success).toBe(false);
    expect(longEventSchema.safeParse({ ...event, payload: { data: { giant: "x".repeat(61_000) } } }).success).toBe(false);
    expect(longEventSchema.safeParse({ ...event, payload: { data: { ok: true }, opaque_digest: "a".repeat(64) } }).success).toBe(false);
    expect(longEventSchema.safeParse({ ...event, payload: { data: { unsupported: undefined } }, payload_sha256: longHash({ data: { unsupported: undefined } }) }).success).toBe(false);
  });

  it("accepts a bounded opaque unknown event without treating it as structured progress", () => {
    const unknownPayload = { opaque_digest: "b".repeat(64) };
    const unknown = { ...event, event_type: "unknown_event", payload: unknownPayload, payload_sha256: longHash(unknownPayload) };
    expect(longEventSchema.parse(unknown).payload).toEqual({ opaque_digest: "b".repeat(64) });
  });

  it("requires stable event identity and trusted receive time", () => {
    expect(longEventSchema.safeParse({ ...event, event_id: "bad id" }).success).toBe(false);
    expect(longEventSchema.safeParse({ ...event, adapter_event_id: "" }).success).toBe(false);
    expect(longEventSchema.safeParse({ ...event, received_at: "not-a-date" }).success).toBe(false);
  });

  it("binds the payload digest to the actual payload", () => {
    expect(longEventSchema.safeParse({ ...event, payload_sha256: "a".repeat(64) }).success).toBe(false);
  });

  it("keeps alert lifecycle and snapshot limits explicit", () => {
    const alert = {
      id: "alert-1", kind: "stall" as const, severity: "high" as const, status: "open" as const,
      identity_key: "stall:session", reason_code: "stall_threshold", message: "No progress", first_sequence: 1, last_sequence: 3,
      occurrence_count: 3, evidence_event_ids: ["evt-1"], raised_at: event.received_at, updated_at: event.received_at,
    };
    expect(longAlertSchema.parse({ ...alert, status: "acknowledged" as const })).toEqual({ ...alert, status: "acknowledged" as const });
    expect(longAlertSchema.safeParse({ ...alert, updated_at: "2026-09-21T12:00:00.000Z" }).success).toBe(false);
    const snapshot = {
      kind: "jevrev.long-snapshot", schema_version: "1", session_id: spec.session_id, sequence: 3,
      spec_revision: 1, spec_sha256: longHash(spec), lifecycle: "observing" as const, evaluated_at: event.received_at,
      last_event_at: event.occurred_at, open_tool_calls: 0,
      indicators: { activity: "quiet" as const, stall_score: 0.7, failure_score: 0, drift_score: 0, budget_risk: 0.1, progress_index: "unknown" as const },
      open_alerts: [alert], acknowledged_alerts: [], cost: { wall_ms: 1000, provider_tokens: 0, tool_calls: 1 },
    };
    expect(longSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(longSnapshotSchema.safeParse({ ...snapshot, open_alerts: [alert], acknowledged_alerts: [{ ...alert, status: "acknowledged" as const }] }).success).toBe(false);
    expect(longSnapshotSchema.safeParse({ ...snapshot, last_event_at: "2026-09-22T13:00:00.000Z" }).success).toBe(false);
    expect(longSnapshotSchema.safeParse({ ...snapshot, open_alerts: [{ ...alert, status: "acknowledged" as const }] }).success).toBe(false);
  });
});
