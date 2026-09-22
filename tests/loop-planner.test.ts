import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRoundWorkOrder, issueNextRound } from "../src/loop/planner.js";
import { createLoop, loadLoop, type LoadedLoop } from "../src/loop/store.js";
import { loopHash, type LoopSpec, type RoundPlan } from "../src/loop/schemas.js";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error("Unsafe cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});
const spec: LoopSpec = {
  kind: "jevrev.loop-spec", schema_version: "1", revision: 1,
  title: "Site", goal: "Make the site publishable", workspace: ".",
  criteria: [
    { id: "tests", type: "hard", description: "Tests pass", required_commands: ["test-suite"] },
    { id: "lcp", type: "metric", description: "Fast LCP", unit: "ms", direction: "lower", aggregation: "p75", target: 2500, minimum_samples: 5 },
    { id: "visual", type: "judged", description: "Visual quality", target: 0.85, required_confidence: 0.7, rubric: ["Generic", "Distinctive"], required_artifacts: ["desktop", "mobile"] },
  ],
  protected_surfaces: [{ id: "routing", description: "Existing routes unchanged" }],
  budget: { per_round_wall_ms: 60_000, per_round_changed_files: 8, pause_total_wall_ms: 600_000, pause_total_provider_tokens: 50_000 },
  plateau: { window: 3, min_material_delta: 0.02 },
};
const plan: RoundPlan = {
  kind: "jevrev.round-plan", schema_version: "1",
  round_goal: "Improve mobile hero", focus_criteria: ["visual"],
  hypothesis: "A shorter hero exposes the primary action",
  allowed_scope: ["src/Hero.tsx"], do_not_change: ["routing"],
  required_evidence: [{ id: "mobile", description: "Mobile screenshot", kind: "artifact" }],
  stop_conditions: ["Routing changes", "Mobile interaction fails"],
};

async function loopFixture() {
  const root = mkdtempSync(join(tmpdir(), "jevrev-loop-planner-"));
  roots.push(root);
  const directory = join(root, "run");
  return { directory, loaded: await createLoop(directory, spec, "base") };
}

describe("JevLoop work-order planner", () => {
  it("binds a host plan to loop, spec, revision, and default budgets", async () => {
    const { loaded } = await loopFixture();
    const order = buildRoundWorkOrder(loaded, plan);
    expect(order).toMatchObject({
      loop_id: loaded.state.loop_id, round_number: 1, spec_revision: 1,
      spec_sha256: loopHash(spec), base_revision: "base", mode: "progress",
      budget: { max_wall_ms: 60_000, max_changed_files: 8 },
    });
  });
  it("requires a plan for progress but not for completion", async () => {
    const { loaded } = await loopFixture();
    expect(() => buildRoundWorkOrder(loaded)).toThrow("round plan is required");
    const pending: LoadedLoop = { ...loaded, state: { ...loaded.state, status: "completion_pending", last_round: 2, head_revision: "head" } };
    const order = buildRoundWorkOrder(pending);
    expect(order).toMatchObject({ mode: "completion", round_number: 3, base_revision: "head" });
    expect(order.focus_criteria).toEqual(["tests", "lcp", "visual"]);
    expect(order.required_evidence).toHaveLength(5);
    expect(order.required_evidence.map((item) => item.kind).sort()).toEqual([
      "artifact", "artifact", "command", "command", "metric",
    ]);
    expect(new Set(order.required_evidence.map((item) => item.id)).size).toBe(5);
  });
  it("rejects unknown focus/protected IDs and an oversized budget", async () => {
    const { loaded } = await loopFixture();
    expect(() => buildRoundWorkOrder(loaded, { ...plan, focus_criteria: ["missing"] })).toThrow("unknown focus");
    expect(() => buildRoundWorkOrder(loaded, { ...plan, do_not_change: ["missing"] })).toThrow("unknown protected");
    expect(() => buildRoundWorkOrder(loaded, { ...plan, budget: { max_wall_ms: 60_001 } })).toThrow("exceeds");
  });
  it("enforces focus requested by the previous audit", async () => {
    const { loaded } = await loopFixture();
    const withAudit: LoadedLoop = {
      ...loaded,
      state: {
        ...loaded.state,
        last_round: 1,
        head_revision: "head",
        last_audit: {
          kind: "jevrev.round-audit-result", schema_version: "1", loop_id: loaded.state.loop_id,
          round_number: 1, audit_mode: "progress", outcome: "fix_regression",
          criteria: [{ id: "tests", status: "fail", score: null, confidence: null, source: "command", freshness: "fresh" }],
          blocking_criteria: ["tests"], next_action: { type: "fix_regression", focus_criteria: ["tests"], reason: "Tests regressed" },
          material_progress: false, evidence_sha256: "a".repeat(64), spec_sha256: loopHash(spec),
          provider_profile: "deterministic", usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    };
    expect(() => buildRoundWorkOrder(withAudit, plan)).toThrow("previous audit focus");
    expect(buildRoundWorkOrder(withAudit, { ...plan, focus_criteria: ["visual", "tests"] }).mode)
      .toBe("fix_regression");
  });
  it("issues exactly one event and repeated next returns the same order", async () => {
    const { directory } = await loopFixture();
    const first = await issueNextRound(directory, plan);
    const second = await issueNextRound(directory, { ...plan, round_goal: "This must be ignored" });
    expect(first.issued).toBe(true);
    expect(second.issued).toBe(false);
    expect(second.order).toEqual(first.order);
    expect((await loadLoop(directory)).events).toHaveLength(2);
  });
  it("returns the same work order to concurrent next callers", async () => {
    const { directory } = await loopFixture();
    const [left, right] = await Promise.all([
      issueNextRound(directory, plan),
      issueNextRound(directory, plan),
    ]);
    expect([left.issued, right.issued].sort()).toEqual([false, true]);
    expect(left.order).toEqual(right.order);
    expect((await loadLoop(directory)).events).toHaveLength(2);
  });
  it("namespaces completion evidence slots instead of dropping collisions", async () => {
    const { loaded } = await loopFixture();
    const collisionSpec: LoopSpec = {
      ...spec,
      criteria: [
        { id: "tests", type: "hard", description: "Tests", required_commands: ["desktop"] },
        { id: "visual", type: "judged", description: "Visual", target: 0.8, required_confidence: 0.7, rubric: ["Bad", "Good"], required_artifacts: ["desktop"] },
      ],
    };
    const pending: LoadedLoop = {
      ...loaded,
      spec: collisionSpec,
      state: { ...loaded.state, status: "completion_pending", spec_sha256: loopHash(collisionSpec) },
    };
    const order = buildRoundWorkOrder(pending);
    expect(order.required_evidence).toHaveLength(3);
    expect(order.required_evidence.filter((item) => item.description.includes("desktop"))).toHaveLength(2);
  });
  it("accepts a protected-surface regression as the next focus", async () => {
    const { loaded } = await loopFixture();
    const withAudit: LoadedLoop = {
      ...loaded,
      state: {
        ...loaded.state,
        last_round: 1,
        head_revision: "head",
        last_audit: {
          kind: "jevrev.round-audit-result", schema_version: "1", loop_id: loaded.state.loop_id,
          round_number: 1, audit_mode: "progress", outcome: "fix_regression",
          criteria: [{ id: "routing", status: "fail", score: null, confidence: null, source: "command", freshness: "fresh" }],
          blocking_criteria: ["routing"], next_action: { type: "fix_regression", focus_criteria: ["routing"], reason: "Routing regressed" },
          material_progress: false, evidence_sha256: "a".repeat(64), spec_sha256: loopHash(spec),
          provider_profile: "deterministic", usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    };
    expect(buildRoundWorkOrder(withAudit, { ...plan, focus_criteria: ["routing"] }).mode).toBe("fix_regression");
  });
  it("does not inherit focus or mode from an audit of an older spec", async () => {
    const { loaded } = await loopFixture();
    const revisedSpec: LoopSpec = { ...spec, revision: 2, criteria: spec.criteria.filter((item) => item.id !== "tests") };
    const revised: LoadedLoop = {
      ...loaded,
      spec: revisedSpec,
      state: {
        ...loaded.state,
        spec_revision: 2,
        spec_sha256: loopHash(revisedSpec),
        last_audit: {
          kind: "jevrev.round-audit-result", schema_version: "1", loop_id: loaded.state.loop_id,
          round_number: 1, audit_mode: "progress", outcome: "fix_regression",
          criteria: [{ id: "tests", status: "fail", score: null, confidence: null, source: "command", freshness: "fresh" }],
          blocking_criteria: ["tests"], next_action: { type: "fix_regression", focus_criteria: ["tests"], reason: "Old failure" },
          material_progress: false, evidence_sha256: "a".repeat(64), spec_sha256: loopHash(spec),
          provider_profile: "deterministic", usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    };
    expect(buildRoundWorkOrder(revised, plan).mode).toBe("progress");
  });
  it.each(["waiting_human", "budget_paused", "completed", "aborted"] as const)(
    "does not issue from %s", async (status) => {
      const { loaded } = await loopFixture();
      expect(() => buildRoundWorkOrder({ ...loaded, state: { ...loaded.state, status } }, plan)).toThrow();
    },
  );
});
