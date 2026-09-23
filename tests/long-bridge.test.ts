import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordLoopAuditEvent } from "../src/long/bridge.js";
import { createLongStore, loadLongStore } from "../src/long/store.js";
import { auditLoopCommand, nextLoopCommand } from "../src/loop/commands.js";
import { createLoop } from "../src/loop/store.js";
import { loopHash, type LoopSpec } from "../src/loop/schemas.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const spec = {
  kind: "jevrev.long-spec" as const, schema_version: "1" as const, revision: 1, session_id: "jvlng_8888888888888888", title: "Bridge", goal: "Observe", workspace: ".", allowed_scope: [], protected_surfaces: [], milestones: [],
  budget: { max_wall_ms: 10_000, max_provider_tokens: 100, max_tool_calls: 10 }, thresholds: { stall_after_ms: 1_000, heartbeat_after_ms: 100, repeated_failure_window: 1_000, repeated_failure_count: 2, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 1_000 }, alert_policy: { cooldown_ms: 100, max_open_alerts: 4, max_alert_history: 20, severity_escalation_window: 1_000 }, observer_budget: { provider: "none" as const, max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 1_000, min_interval_ms: 100, max_context_bytes: 1_000 },
};

const loopSpec: LoopSpec = {
  kind: "jevrev.loop-spec", schema_version: "1", revision: 1, title: "Bridge loop", goal: "Verify bridge", workspace: ".",
  criteria: [{ id: "tests", type: "hard", description: "Tests pass", required_commands: ["test"] }],
  protected_surfaces: [],
  budget: { per_round_wall_ms: 10_000, per_round_changed_files: 2, pause_total_wall_ms: 100_000, pause_total_provider_tokens: 10_000 },
  plateau: { window: 3, min_material_delta: 0.01 },
};

describe("JevLong Loop bridge", () => {
  it("records a Loop audit as a deduplicated trusted event", async () => {
    const root = mkdtempSync(join(tmpdir(), "jevrev-long-bridge-")); roots.push(root);
    const directory = join(root, "long"); await createLongStore(directory, spec);
    const loopDirectory = join(root, "loop");
    const created = await createLoop(loopDirectory, loopSpec, "base");
    const issued = await nextLoopCommand(loopDirectory, {
      kind: "jevrev.round-plan", schema_version: "1", round_goal: "Run tests", focus_criteria: ["tests"],
      hypothesis: "The test suite is healthy", allowed_scope: [], do_not_change: [],
      required_evidence: [{ id: "test", description: "Test command", kind: "command" }], stop_conditions: ["Stop on failure"],
    });
    const evidence = {
      kind: "jevrev.round-evidence", schema_version: "1", loop_id: created.state.loop_id, round_number: issued.order.round_number,
      spec_sha256: issued.order.spec_sha256, work_order_sha256: loopHash(issued.order), base_revision: issued.order.base_revision,
      head_revision: "head", wall_ms: 20, provider_tokens: 0, changed_files: [],
      observations: [{ id: "test", exit_code: 0, duration_ms: 10, head_revision: "head", termination: "exited" as const, source: "recorded" as const }],
      metrics: [], artifact_evaluations: [],
      criterion_results: [{ id: "tests", status: "pass" as const, freshness: "fresh" as const, source_round: 1, head_revision: "head", observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] }],
      protected_surface_results: [], known_failures: [],
    };
    const audited = await auditLoopCommand(loopDirectory, evidence);
    const input = { loop_id: created.state.loop_id, round_number: 1, work_order_sha256: evidence.work_order_sha256, audit_outcome: audited.result.outcome, evidence_sha256: audited.result.evidence_sha256 };
    const first = await recordLoopAuditEvent(directory, loopDirectory, input, new Date("2026-09-23T00:00:00.000Z"));
    const second = await recordLoopAuditEvent(directory, loopDirectory, input, new Date("2026-09-23T00:00:01.000Z"));
    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(0);
    expect((await loadLongStore(directory)).events[0]?.payload).toMatchObject({ event_type: "loop_audit", source: "recorded", payload: { data: { loop_id: input.loop_id, audit_outcome: input.audit_outcome } } });
  });
});
