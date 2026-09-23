import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLoop, loadLoop, appendLoopEvent } from "../src/loop/store.js";
import { loopHash, type LoopSpec, type RoundWorkOrder, type RoundEvidence, type RoundAuditResult } from "../src/loop/schemas.js";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error("Unsafe test cleanup path");
    rmSync(path, { force: true, recursive: true });
  }
});
const spec: LoopSpec = {
  kind: "jevrev.loop-spec", schema_version: "1", revision: 1,
  title: "Parser", goal: "Improve parser", workspace: ".",
  criteria: [{ id: "tests", type: "hard", description: "Tests pass", required_commands: ["npm-test"] }],
  protected_surfaces: [],
  budget: { per_round_wall_ms: 10_000, per_round_changed_files: 5, pause_total_wall_ms: 120_000, pause_total_provider_tokens: 10_000 },
  plateau: { window: 3, min_material_delta: 0.02 },
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jevrev-loop-store-"));
  roots.push(root);
  const directory = join(root, "run");
  const created = await createLoop(directory, spec, "base");
  const order: RoundWorkOrder = {
    kind: "jevrev.round-work-order", schema_version: "1", loop_id: created.state.loop_id,
    round_number: 1, spec_revision: 1, spec_sha256: loopHash(spec),
    base_revision: "base", mode: "progress", round_goal: "Fix hot path",
    focus_criteria: ["tests"], hypothesis: "Less allocation", allowed_scope: ["src/parser.ts"],
    do_not_change: [], required_evidence: [{ id: "npm-test", description: "Tests", kind: "command" }],
    budget: { max_wall_ms: 10_000, max_changed_files: 5 }, stop_conditions: ["Stop on regression"],
  };
  const evidence: RoundEvidence = {
    kind: "jevrev.round-evidence", schema_version: "1", loop_id: created.state.loop_id,
    round_number: 1, spec_sha256: loopHash(spec), work_order_sha256: loopHash(order),
    base_revision: "base", head_revision: "head", wall_ms: 300, provider_tokens: 0,
    changed_files: ["src/parser.ts"],
    observations: [{ id: "npm-test", exit_code: 0, duration_ms: 300, head_revision: "head", termination: "exited", source: "recorded" }],
    metrics: [], artifact_evaluations: [],
    criterion_results: [{ id: "tests", status: "pass", freshness: "fresh", source_round: 1, head_revision: "head", observation_ids: ["npm-test"], metric_ids: [], artifact_evaluation_ids: [] }],
    protected_surface_results: [], known_failures: [],
  };
  const result: RoundAuditResult = {
    kind: "jevrev.round-audit-result", schema_version: "1", loop_id: created.state.loop_id,
    round_number: 1, audit_mode: "progress", outcome: "continue",
    criteria: [{ id: "tests", status: "pass", score: null, confidence: null, source: "command", freshness: "fresh" }],
    blocking_criteria: [], next_action: { type: "continue", focus_criteria: ["tests"], reason: "Continue" },
    material_progress: true, evidence_sha256: loopHash(evidence), spec_sha256: loopHash(spec),
    provider_profile: "deterministic", usage: { input_tokens: 0, output_tokens: 0 },
  };
  return { directory, created, order, evidence, result };
}

describe("JevLoop event store", () => {
  it("creates a loop, issues a round, audits it, and replays the same state", async () => {
    const { directory, created, order, evidence, result } = await fixture();
    expect(created.events).toHaveLength(1);
    const issued = await appendLoopEvent(directory, { type: "ROUND_ISSUED", order });
    expect(issued.state.status).toBe("issued");
    const audited = await appendLoopEvent(directory, { type: "ROUND_AUDITED", evidence, result });
    expect(audited.state).toMatchObject({ status: "ready", last_round: 1, head_revision: "head", cumulative_wall_ms: 300 });
    const replay = await loadLoop(directory);
    expect(replay.state).toEqual(audited.state);
    expect(replay.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(replay.events[2]?.previous_event_sha256).toBe(replay.events[1]?.event_sha256);
  });
  it("rebuilds a stale or missing snapshot from the event chain", async () => {
    const { directory, order } = await fixture();
    await appendLoopEvent(directory, { type: "ROUND_ISSUED", order });
    const path = join(directory, "snapshot.json");
    writeFileSync(path, "{\"status\":\"completed\"}", "utf8");
    expect((await loadLoop(directory)).state.status).toBe("issued");
    rmSync(path);
    expect((await loadLoop(directory)).state.status).toBe("issued");
    expect(readFileSync(join(directory, "events.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    // A read never writes a cache, and the next locked mutation recreates it.
    await expect(import("node:fs/promises").then(({ stat }) => stat(path))).rejects.toThrow();
  });
  it("serializes concurrent mutations and cannot issue duplicate rounds", async () => {
    const { directory, order } = await fixture();
    const attempts = await Promise.allSettled([
      appendLoopEvent(directory, { type: "ROUND_ISSUED", order }),
      appendLoopEvent(directory, { type: "ROUND_ISSUED", order }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect((await loadLoop(directory)).events).toHaveLength(2);
  });
  it("detects tampered and truncated events without approving false progress", async () => {
    const { directory, order } = await fixture();
    await appendLoopEvent(directory, { type: "ROUND_ISSUED", order });
    const path = join(directory, "events.jsonl");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("Fix hot path", "Fake completion"), "utf8");
    await expect(loadLoop(directory)).rejects.toThrow("event chain");
    writeFileSync(path, original.trimEnd(), "utf8");
    await expect(loadLoop(directory)).rejects.toThrow("incomplete trailing");
  });
  it("refuses duplicate round issuance and does not append on failure", async () => {
    const { directory, order } = await fixture();
    await appendLoopEvent(directory, { type: "ROUND_ISSUED", order });
    await expect(appendLoopEvent(directory, { type: "ROUND_ISSUED", order })).rejects.toThrow("Cannot issue");
    expect((await loadLoop(directory)).events).toHaveLength(2);
  });
  it("enforces exclusive mutation lock and leaves the log untouched", async () => {
    const { directory, order } = await fixture();
    writeFileSync(join(directory, ".mutation.lock"), "held", "utf8");
    await expect(appendLoopEvent(directory, { type: "ROUND_ISSUED", order })).rejects.toThrow("being updated");
    expect((await loadLoop(directory)).events).toHaveLength(1);
  });
  it("recovers a lock owned by a confirmed dead process", async () => {
    const { directory, order } = await fixture();
    writeFileSync(join(directory, ".mutation.lock"), JSON.stringify({
      pid: 2147483647, created_at: new Date().toISOString(),
    }), "utf8");
    expect((await appendLoopEvent(directory, { type: "ROUND_ISSUED", order })).state.status).toBe("issued");
  });
  it("reports a successful durable append even when snapshot refresh fails", async () => {
    const { directory, order } = await fixture();
    const snapshot = join(directory, "snapshot.json");
    rmSync(snapshot);
    mkdirSync(snapshot);
    const result = await appendLoopEvent(directory, { type: "ROUND_ISSUED", order });
    expect(result.state.status).toBe("issued");
    expect((await loadLoop(directory)).state.status).toBe("issued");
  });
  it("binds loop ID to the hashed creation event", async () => {
    const { directory } = await fixture();
    const identityPath = join(directory, "identity.json");
    const identity = JSON.parse(readFileSync(identityPath, "utf8"));
    identity.loop_id = "jvl_ffffffffffffffff";
    writeFileSync(identityPath, JSON.stringify(identity), "utf8");
    await expect(loadLoop(directory)).rejects.toThrow("identity and creation event");
  });
  it("records a human-approved spec revision and keeps the previous revision in the log", async () => {
    const { directory } = await fixture();
    const revised = structuredClone(spec);
    revised.revision = 2;
    revised.goal = "Improve parser with compatibility";
    const next = await appendLoopEvent(directory, {
      type: "SPEC_APPROVED", spec: revised, approved_by: "user", reason: "Human approved the revised measurable goal",
    });
    expect(next.state.spec_revision).toBe(2);
    expect((await loadLoop(directory)).spec.goal).toBe(revised.goal);
    expect(next.events[0]?.payload.type).toBe("LOOP_CREATED");
    expect(next.events[1]?.payload.type).toBe("SPEC_APPROVED");
  });
  it("rejects a second loop at the same directory without overwriting events", async () => {
    const { directory } = await fixture();
    await expect(createLoop(directory, spec, "base")).rejects.toThrow("must not already exist");
    expect((await loadLoop(directory)).events).toHaveLength(1);
  });
  it("creates missing parent directories but keeps the requested loop path exclusive", async () => {
    const root = mkdtempSync(join(tmpdir(), "jevrev-loop-nested-"));
    roots.push(root);
    const directory = join(root, "state", "loops", "run-1");
    await createLoop(directory, spec, "base");
    expect((await loadLoop(directory)).state.status).toBe("ready");
    await expect(createLoop(directory, spec, "base")).rejects.toThrow("must not already exist");
  });
  it("reports a parent path that is a file instead of claiming the target exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "jevrev-loop-parent-"));
    roots.push(root);
    const parentFile = join(root, "not-a-directory");
    writeFileSync(parentFile, "preserve", "utf8");
    await expect(createLoop(join(parentFile, "run"), spec, "base")).rejects.toThrow("Could not create parent directory");
    expect(readFileSync(parentFile, "utf8")).toBe("preserve");
  });
});
