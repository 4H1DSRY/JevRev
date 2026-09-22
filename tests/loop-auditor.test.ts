import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditRound } from "../src/loop/auditor.js";
import { loopHash, loopSpecSchema, type LoopSpec, type RoundEvidence, type RoundWorkOrder } from "../src/loop/schemas.js";
import { buildRoundWorkOrder } from "../src/loop/planner.js";
import { createLoop } from "../src/loop/store.js";
import type { Judge } from "../src/judge.js";
import type { QuestionPlan } from "../src/questions.js";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error("Unsafe cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});

const baseSpec: LoopSpec = {
  kind: "jevrev.loop-spec", schema_version: "1", revision: 1, title: "Parser", goal: "Make parser faster", workspace: ".",
  criteria: [
    { id: "tests", type: "hard", description: "Tests pass", required_commands: ["test"] },
    { id: "speed", type: "metric", description: "P75 latency", unit: "ms", direction: "lower", aggregation: "p75", target: 100, minimum_samples: 4 },
    { id: "quality", type: "judged", description: "Quality stays acceptable", target: 0.75, required_confidence: 0.6, rubric: ["bad", "weak", "good", "excellent"], required_artifacts: ["report"] },
  ],
  protected_surfaces: [{ id: "api", description: "Public API remains compatible" }],
  budget: { per_round_wall_ms: 10_000, per_round_changed_files: 5, pause_total_wall_ms: 100_000, pause_total_provider_tokens: 10_000 },
  plateau: { window: 2, min_material_delta: 0.05 },
};

const progressPlan = {
  kind: "jevrev.round-plan" as const, schema_version: "1" as const, round_goal: "Improve parser", focus_criteria: ["speed", "quality"], hypothesis: "Cache hot tokens", allowed_scope: ["src/parser.ts"], do_not_change: ["api"], required_evidence: [{ id: "speed-run", description: "Benchmark", kind: "metric" as const }, { id: "quality-report", description: "Quality report", kind: "artifact" as const }], stop_conditions: ["Do not break API"],
};

async function fixture(mode: "progress" | "completion" = "progress") {
  const root = mkdtempSync(join(tmpdir(), "jevrev-loop-auditor-"));
  roots.push(root);
  const directory = join(root, "run");
  const loop = await createLoop(directory, baseSpec, "base");
  const order = mode === "completion"
    ? buildRoundWorkOrder({ ...loop, state: { ...loop.state, status: "completion_pending", last_round: 1, head_revision: "head" } })
    : buildRoundWorkOrder(loop, progressPlan);
  return { loop, order };
}

function evidence(order: RoundWorkOrder, patch: Partial<RoundEvidence> = {}): RoundEvidence {
  const base: RoundEvidence = {
    kind: "jevrev.round-evidence", schema_version: "1", loop_id: order.loop_id, round_number: order.round_number,
    spec_sha256: order.spec_sha256, work_order_sha256: loopHash(order), base_revision: order.base_revision, head_revision: "head",
    wall_ms: 100, provider_tokens: 10, changed_files: ["src/parser.ts"],
    observations: [{ id: "test", exit_code: 0, duration_ms: 10, head_revision: "head", termination: "exited", source: "recorded" }],
    metrics: [{ id: "speed-sample", criterion_id: "speed", unit: "ms", samples: [80, 90, 95, 100], head_revision: "head" }],
    artifact_evaluations: [{ id: "report-eval", artifact_id: "report", sha256: "a".repeat(64), status: "pass", head_revision: "head", source: "imported", summary: "The diff preserves the parser API and keeps the fast path readable." }],
    criterion_results: [
      { id: "tests", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] },
      { id: "speed", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: [], metric_ids: ["speed-sample"], artifact_evaluation_ids: [] },
      { id: "quality", status: "unknown", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: [], metric_ids: [], artifact_evaluation_ids: ["report-eval"] },
    ],
    protected_surface_results: [{ id: "api", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] }],
    known_failures: [],
  };
  return { ...base, ...patch };
}

const fakeJudge: Judge = {
  async evaluate(plan: QuestionPlan) {
    const answers: Record<string, { type: "score"; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }> = {};
    for (const [key, question] of Object.entries(plan.questions)) {
      if (question.type !== "score") throw new Error("expected score question");
      answers[key] = { type: "score", score: question.criteria.length - 1, confidence: 0.9, legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])), probabilities: { [String(question.criteria.length - 1)]: 1 } };
    }
    return { model: "fake-jev", answers, usage: { input_tokens: 12, output_tokens: 8 } };
  },
};

describe("JevLoop evidence auditor", () => {
  it("rejects evidence from a different work order", async () => {
    const { order } = await fixture();
    await expect(auditRound(baseSpec, order, evidence(order, { work_order_sha256: "b".repeat(64) }))).rejects.toThrow("not bound");
  });
  it("continues a progress round when a judged criterion still needs Jev", async () => {
    const { order } = await fixture();
    const result = await auditRound(baseSpec, order, evidence(order));
    expect(result.outcome).toBe("continue");
    expect(result.criteria.find((criterion) => criterion.id === "tests")).toMatchObject({ status: "pass", source: "command" });
    expect(result.criteria.find((criterion) => criterion.id === "speed")).toMatchObject({ status: "pass", source: "metric" });
    expect(result.criteria.find((criterion) => criterion.id === "quality")).toMatchObject({ status: "unknown", source: "jev" });
    expect(result.next_action.focus_criteria).toContain("quality");
  });
  it("routes a recorded command failure to fix_regression", async () => {
    const { order } = await fixture();
    const failed = evidence(order, {
      observations: [{ id: "test", exit_code: 1, duration_ms: 10, head_revision: "head", termination: "exited", source: "recorded" }],
      criterion_results: [{ id: "tests", status: "fail", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] }],
    });
    const result = await auditRound(baseSpec, order, failed);
    expect(result.outcome).toBe("fix_regression");
    expect(result.blocking_criteria).toEqual(["tests", "api"]);
    expect(result.next_action.focus_criteria).toEqual(["tests", "api"]);
  });
  it("does not erase a builder-reported failure or a declared failed claim", async () => {
    const { order } = await fixture();
    const result = await auditRound(baseSpec, order, evidence(order, {
      known_failures: ["snapshot check failed"],
      criterion_results: [{ id: "speed", status: "fail", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: [], metric_ids: [], artifact_evaluation_ids: [] }],
    }));
    expect(result.outcome).toBe("fix_regression");
    expect(result.criteria.find((criterion) => criterion.id === "speed")).toMatchObject({ status: "fail" });
  });
  it("uses one Jev batch for judged criteria and normalizes the score", async () => {
    const { order } = await fixture();
    const result = await auditRound(baseSpec, order, evidence(order), { judge: fakeJudge });
    expect(result.criteria.find((criterion) => criterion.id === "quality")).toMatchObject({ status: "pass", score: 1, confidence: 0.9, source: "jev" });
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 8 });
  });
  it("pauses completion for a human when judged evidence has no Jev response", async () => {
    const { order } = await fixture("completion");
    const result = await auditRound(baseSpec, order, evidence(order));
    expect(result.outcome).toBe("waiting_human");
    expect(result.next_action.type).toBe("ask_human");
    expect(result.next_action.focus_criteria).toEqual(["quality"]);
  });
  it("requests completion verification only after a clean progress round", async () => {
    const { order } = await fixture();
    const result = await auditRound(baseSpec, order, evidence(order), { judge: fakeJudge });
    expect(result.outcome).toBe("verify");
    expect(result.next_action.focus_criteria).toEqual(["tests", "speed", "quality"]);
  });
  it("completes a full evidence-backed round", async () => {
    const { order } = await fixture("completion");
    const result = await auditRound(baseSpec, order, evidence(order), { judge: fakeJudge });
    expect(result.outcome).toBe("completed");
    expect(result.next_action).toMatchObject({ type: "stop_success", focus_criteria: [] });
    expect(result.criteria.every((criterion) => criterion.status === "pass" && criterion.freshness === "fresh")).toBe(true);
  });
  it("replans after a plateau, then asks a human after the replan is spent", async () => {
    const { order } = await fixture();
    const stalledEvidence = evidence(order, { criterion_results: [] });
    const first = await auditRound(baseSpec, order, stalledEvidence, { consecutiveStalled: 1 });
    expect(first.outcome).toBe("replan");
    const second = await auditRound(baseSpec, order, stalledEvidence, { consecutiveStalled: 1, plateauReplans: 1 });
    expect(second.outcome).toBe("waiting_human");
  });
  it("pauses instead of continuing past the frozen total budget", async () => {
    const { order } = await fixture();
    const result = await auditRound(baseSpec, order, evidence(order), { cumulativeWallMs: 99_950 });
    expect(result.outcome).toBe("budget_paused");
    expect(result.next_action.type).toBe("wait_budget");
  });
  it("counts builder-reported provider tokens toward the frozen budget", async () => {
    const { order } = await fixture();
    const result = await auditRound(baseSpec, order, evidence(order, { provider_tokens: 10_000 }), { cumulativeProviderTokens: 0 });
    expect(result.outcome).toBe("budget_paused");
  });
  it("does not complete with stale or unknown judged artifacts", async () => {
    const { order } = await fixture("completion");
    const stale = evidence(order, {
      artifact_evaluations: [{ id: "report-eval", artifact_id: "report", sha256: "a".repeat(64), status: "unknown", head_revision: "old", source: "imported", summary: "Stale report." }],
    });
    const result = await auditRound(baseSpec, order, stale, { judge: fakeJudge });
    expect(result.outcome).not.toBe("completed");
    expect(result.criteria.find((criterion) => criterion.id === "quality")?.status).not.toBe("pass");
  });
  it("combines multiple metric records instead of choosing the best run", async () => {
    const { order } = await fixture("completion");
    const combined = evidence(order, {
      metrics: [
        { id: "speed-good", criterion_id: "speed", unit: "ms", samples: [80, 90, 95, 100], head_revision: "head" },
        { id: "speed-bad", criterion_id: "speed", unit: "ms", samples: [140, 150, 160, 170], head_revision: "head" },
      ],
      criterion_results: [
        { id: "tests", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] },
        { id: "speed", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: [], metric_ids: ["speed-good", "speed-bad"], artifact_evaluation_ids: [] },
        { id: "quality", status: "unknown", freshness: "fresh", source_round: order.round_number, head_revision: "head", observation_ids: [], metric_ids: [], artifact_evaluation_ids: ["report-eval"] },
      ],
    });
    const result = await auditRound(baseSpec, order, combined, { judge: fakeJudge });
    expect(result.criteria.find((criterion) => criterion.id === "speed")?.status).toBe("fail");
  });
  it("does not carry an audit across an approved spec revision", async () => {
    const { order } = await fixture();
    const first = await auditRound(baseSpec, order, evidence(order), { judge: fakeJudge });
    const revisedSpec: LoopSpec = { ...baseSpec, revision: 2, title: "Parser revised" };
    const revisedOrder: RoundWorkOrder = { ...order, spec_revision: 2, spec_sha256: loopHash(revisedSpec) };
    const revisedEvidence = evidence(revisedOrder, { criterion_results: [], protected_surface_results: [] });
    const result = await auditRound(revisedSpec, revisedOrder, revisedEvidence, { judge: fakeJudge, previousAudit: first });
    expect(result.criteria.find((criterion) => criterion.id === "tests")).toMatchObject({ status: "unknown", freshness: "fresh" });
    expect(result.criteria.find((criterion) => criterion.id === "tests")?.freshness).not.toBe("carried_forward");
  });
  it("gives Jev the artifact summary and bounded content excerpt", async () => {
    const { order } = await fixture();
    let serializedPlan = "";
    const judge: Judge = {
      async evaluate(plan: QuestionPlan) {
        serializedPlan = JSON.stringify(plan.state);
        return fakeJudge.evaluate(plan);
      },
    };
    const withContent = evidence(order, {
      artifact_evaluations: [{ id: "report-eval", artifact_id: "report", sha256: "a".repeat(64), status: "pass", head_revision: "head", source: "imported", summary: "Readable parser diff", content: "export function parseFast(input) { return parseSlow(input); }" }],
    });
    await auditRound(baseSpec, order, withContent, { judge });
    expect(serializedPlan).toContain("Readable parser diff");
    expect(serializedPlan).toContain("parseFast");
  });
  it("evaluates a metric multiplier against its frozen baseline", async () => {
    const { order } = await fixture();
    const relativeSpec: LoopSpec = {
      ...baseSpec,
      criteria: baseSpec.criteria.map((criterion) => criterion.id === "speed" && criterion.type === "metric"
        ? { ...criterion, baseline: 100, target: 2 }
        : criterion),
    };
    const parsedRelativeSpec = loopSpecSchema.parse(relativeSpec);
    const relativeOrder = { ...order, spec_sha256: loopHash(parsedRelativeSpec) };
    const relativeEvidence = evidence(relativeOrder, {
      metrics: [{ id: "speed-sample", criterion_id: "speed", unit: "ms", samples: [220, 230, 240, 250], head_revision: "head" }],
    });
    const result = await auditRound(parsedRelativeSpec, relativeOrder, relativeEvidence);
    expect(result.criteria.find((criterion) => criterion.id === "speed")?.status).toBe("fail");
  });
});
