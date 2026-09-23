import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopStatusData, renderLoopHuman } from "../src/loop/commands.js";
import { loopHash, type LoopSpec } from "../src/loop/schemas.js";

const root = resolve(import.meta.dirname, "..");
const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const cli = resolve(root, "src", "cli.ts");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], { cwd: root, encoding: "utf8" });
}

const spec: LoopSpec = {
  kind: "jevrev.loop-spec", schema_version: "1", revision: 1, title: "CLI loop", goal: "Make parser faster", workspace: ".",
  criteria: [
    { id: "tests", type: "hard", description: "Tests pass", required_commands: ["test"] },
    { id: "quality", type: "judged", description: "Quality", target: 0.7, required_confidence: 0.5, rubric: ["bad", "good", "excellent"], required_artifacts: ["report"] },
  ],
  protected_surfaces: [{ id: "api", description: "API unchanged" }],
  budget: { per_round_wall_ms: 10_000, per_round_changed_files: 2, pause_total_wall_ms: 100_000, pause_total_provider_tokens: 10_000 },
  plateau: { window: 3, min_material_delta: 0.01 },
};

function evidence(order: Record<string, any>, mode: "progress" | "completion") {
  const head = mode === "progress" ? "head-1" : "head-2";
  return {
    kind: "jevrev.round-evidence", schema_version: "1", loop_id: order.loop_id, round_number: order.round_number,
    spec_sha256: order.spec_sha256, work_order_sha256: loopHash(order), base_revision: order.base_revision, head_revision: head,
    wall_ms: 20, provider_tokens: 5, changed_files: mode === "completion" ? [] : ["src/parser.ts"],
    observations: [{ id: "test", exit_code: 0, duration_ms: 10, head_revision: head, termination: "exited", source: "recorded" }],
    metrics: [], artifact_evaluations: [{ id: "report-eval", artifact_id: "report", sha256: "a".repeat(64), status: "pass", head_revision: head, source: "imported", summary: "The report shows the API remains unchanged." }],
    criterion_results: [
      { id: "tests", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: head, observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] },
      { id: "quality", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: head, observation_ids: [], metric_ids: [], artifact_evaluation_ids: ["report-eval"] },
    ],
    protected_surface_results: [{ id: "api", status: "pass", freshness: "fresh", source_round: order.round_number, head_revision: head, observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] }],
    known_failures: [],
  };
}

function replay() {
  return {
    model: "jev-cli-replay", candidate_order: ["quality"], answers: { finalist_0_criterion: { type: "score", score: 2, confidence: 0.9, legend: { "0": "bad", "1": "good", "2": "excellent" }, probabilities: { "0": 0, "1": 0, "2": 1 } } }, usage: { input_tokens: 5, output_tokens: 2 },
  };
}

describe("JevLoop CLI workflow", () => {
  it("runs create -> next -> audit -> completion next -> completed audit", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop");
    const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(spec));
    const planPath = join(rootDir, "plan.json"); writeFileSync(planPath, JSON.stringify({ kind: "jevrev.round-plan", schema_version: "1", round_goal: "Improve", focus_criteria: ["quality"], hypothesis: "Keep changes small", allowed_scope: ["src/parser.ts"], do_not_change: ["api"], required_evidence: [{ id: "report", description: "Report", kind: "artifact" }], stop_conditions: ["API unchanged"] }));
    let result = run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base", "--format", "json"]);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).status).toBe("ready");
    result = run(["loop", "next", "--directory", directory, "--plan", planPath, "--format", "json"]);
    expect(result.status).toBe(0); const order1 = JSON.parse(result.stdout); expect(order1.mode).toBe("progress");
    const evidence1Path = join(rootDir, "evidence-1.json"); writeFileSync(evidence1Path, JSON.stringify(evidence(order1, "progress")));
    const replayPath = join(rootDir, "replay.json"); writeFileSync(replayPath, JSON.stringify(replay()));
    result = run(["loop", "audit", "--directory", directory, "--evidence", evidence1Path, "--replay", replayPath, "--format", "json"]);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).outcome).toBe("verify");
    result = run(["loop", "next", "--directory", directory, "--format", "json"]);
    expect(result.status).toBe(0); const order2 = JSON.parse(result.stdout); expect(order2.mode).toBe("completion");
    const evidence2Path = join(rootDir, "evidence-2.json"); writeFileSync(evidence2Path, JSON.stringify(evidence(order2, "completion")));
    result = run(["loop", "audit", "--directory", directory, "--evidence", evidence2Path, "--replay", replayPath, "--format", "json"]);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "completed", next_action: { type: "stop_success" } });
    result = run(["loop", "status", "--directory", directory, "--format", "json"]);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", round: 2 });
  }, 20_000);

  it("keeps human boundaries explicit for spec approval and provider selection", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop"); const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(spec));
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base"]).status).toBe(0);
    const revised = { ...spec, revision: 2, title: "Revised" }; const revisedPath = join(rootDir, "revised.json"); writeFileSync(revisedPath, JSON.stringify(revised));
    expect(run(["loop", "approve", "--directory", directory, "--spec", revisedPath, "--approved-by", "human", "--reason", "Tighten acceptance criteria"]).status).toBe(2);
    const approved = run(["loop", "approve", "--directory", directory, "--spec", revisedPath, "--approved-by", "human", "--reason", "Tighten acceptance criteria", "--yes"]);
    expect(approved.status).toBe(0);
    const resumeWithoutConfirmation = run(["loop", "resume", "--directory", directory, "--approved-by", "human", "--reason", "Continue after review"]);
    expect(resumeWithoutConfirmation.status).toBe(2);
  });

  it("rejects an invalid format before mutating the loop", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop"); const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(spec));
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base", "--format", "bogus"]).status).toBe(2);
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base"]).status).toBe(0);
    const invalid = run(["loop", "next", "--directory", directory, "--format", "bogus"]);
    expect(invalid.status).toBe(2);
    expect(run(["loop", "status", "--directory", directory, "--format", "json"]).stdout).toContain('"status": "ready"');
  });

  it("rejects an unwritable output target before issuing a round", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop"); const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(spec));
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base"]).status).toBe(0);
    const invalid = run(["loop", "next", "--directory", directory, "--output", join(rootDir, "missing", "result.json")]);
    expect(invalid.status).toBe(2);
    expect(run(["loop", "status", "--directory", directory, "--format", "json"]).stdout).toContain('"status": "ready"');
  });

  it("audits a hard-only loop without requiring a Jev API key", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop");
    const hardSpec = { ...spec, criteria: [{ id: "tests", type: "hard" as const, description: "Tests", required_commands: ["test"] }], protected_surfaces: [] };
    const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(hardSpec));
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base"]).status).toBe(0);
    const planPath = join(rootDir, "plan.json"); writeFileSync(planPath, JSON.stringify({ kind: "jevrev.round-plan", schema_version: "1", round_goal: "Run tests", focus_criteria: ["tests"], hypothesis: "Current code is correct", allowed_scope: [], do_not_change: [], required_evidence: [{ id: "test", description: "Test command", kind: "command" }], stop_conditions: ["Stop on failure"] }));
    const next = run(["loop", "next", "--directory", directory, "--plan", planPath, "--format", "json"]); expect(next.status).toBe(0);
    const order = JSON.parse(next.stdout);
    const evidencePath = join(rootDir, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify({ kind: "jevrev.round-evidence", schema_version: "1", loop_id: order.loop_id, round_number: 1, spec_sha256: order.spec_sha256, work_order_sha256: loopHash(order), base_revision: "base", head_revision: "head", wall_ms: 20, provider_tokens: 0, changed_files: [], observations: [{ id: "test", exit_code: 0, duration_ms: 10, head_revision: "head", termination: "exited", source: "recorded" }], metrics: [], artifact_evaluations: [], criterion_results: [{ id: "tests", status: "pass", freshness: "fresh", source_round: 1, head_revision: "head", observation_ids: ["test"], metric_ids: [], artifact_evaluation_ids: [] }], protected_surface_results: [], known_failures: [] }));
    const audit = run(["loop", "audit", "--directory", directory, "--evidence", evidencePath, "--format", "json"]);
    expect(audit.status).toBe(0);
    expect(JSON.parse(audit.stdout).outcome).toBe("verify");
  });

  it("returns the child command failure code from Loop evidence run", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop");
    const hardSpec = { ...spec, criteria: [{ id: "tests", type: "hard" as const, description: "Tests", required_commands: ["test"] }], protected_surfaces: [] };
    const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(hardSpec));
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base"]).status).toBe(0);
    const planPath = join(rootDir, "plan.json"); writeFileSync(planPath, JSON.stringify({ kind: "jevrev.round-plan", schema_version: "1", round_goal: "Run tests", focus_criteria: ["tests"], hypothesis: "The test command exposes regressions", allowed_scope: [], do_not_change: [], required_evidence: [{ id: "test", description: "Test command", kind: "command" }], stop_conditions: ["Stop on failure"] }));
    expect(run(["loop", "next", "--directory", directory, "--plan", planPath]).status).toBe(0);
    const evidencePath = join(rootDir, "evidence.json");
    expect(run(["loop", "evidence-template", "--directory", directory, "--head-revision", "head", "--output", evidencePath]).status).toBe(0);
    const failingScript = join(rootDir, "fail.cjs"); writeFileSync(failingScript, "process.exit(9);\n");
    const failed = run(["loop", "evidence", "run", "--directory", directory, "--evidence", evidencePath, "--id", "test", process.execPath, failingScript]);
    expect(failed.status).toBe(9);
  });

  it("keeps the completion evidence slot ID separate from the spec artifact reference", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop"); const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(spec));
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base"]).status).toBe(0);
    const planPath = join(rootDir, "plan.json"); writeFileSync(planPath, JSON.stringify({ kind: "jevrev.round-plan", schema_version: "1", round_goal: "Collect evidence", focus_criteria: ["quality"], hypothesis: "The artifact is understandable", allowed_scope: [], do_not_change: [], required_evidence: [{ id: "report", description: "Report", kind: "artifact" }], stop_conditions: ["Stop on failure"] }));
    expect(run(["loop", "next", "--directory", directory, "--plan", planPath]).status).toBe(0);
    const evidencePath = join(rootDir, "evidence.json");
    expect(run(["loop", "evidence-template", "--directory", directory, "--head-revision", "head", "--output", evidencePath]).status).toBe(0);
    const recorded = run(["loop", "evidence", "artifact", "--directory", directory, "--evidence", evidencePath, "--id", "artifact-slot-1", "--artifact-id", "report", "--file", "package.json", "--summary", "The package metadata is readable.", "--status", "pass", "--criterion", "quality"]);
    expect(recorded.status).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ id: "artifact-slot-1", artifact_id: "report", status: "pass" });
  });

  it("emits a bound incomplete evidence template for the active round", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-loop-cli-")); roots.push(rootDir);
    const directory = join(rootDir, "loop"); const specPath = join(rootDir, "spec.json"); writeFileSync(specPath, JSON.stringify(spec));
    expect(run(["loop", "create", "--directory", directory, "--spec", specPath, "--base-revision", "base"]).status).toBe(0);
    const planPath = join(rootDir, "plan.json"); writeFileSync(planPath, JSON.stringify({ kind: "jevrev.round-plan", schema_version: "1", round_goal: "Improve", focus_criteria: ["quality"], hypothesis: "Small change", allowed_scope: ["src/parser.ts"], do_not_change: ["api"], required_evidence: [{ id: "report", description: "Report", kind: "artifact" }], stop_conditions: ["Stop on failure"] }));
    expect(run(["loop", "next", "--directory", directory, "--plan", planPath]).status).toBe(0);
    const template = run(["loop", "evidence-template", "--directory", directory, "--head-revision", "head-1"]);
    expect(template.status).toBe(0);
    expect(JSON.parse(template.stdout)).toMatchObject({ kind: "jevrev.round-evidence", round_number: 1, head_revision: "head-1", criterion_results: [{ id: "tests", status: "unknown" }, { id: "quality", status: "unknown" }] });

    const humanTemplate = run(["loop", "evidence-template", "--directory", directory, "--head-revision", "head-1", "--format", "human"]);
    expect(humanTemplate.status).toBe(0);
    expect(humanTemplate.stdout).toContain("round 1  evidence template");
    expect(humanTemplate.stdout).toContain("criteria: tests=unknown, quality=unknown");
  });

  it("does not present a paused action as current after a human resume", () => {
    const loop = {
      spec: { goal: "Make parser faster" },
      state: {
        loop_id: "jvl_0000000000000000", status: "ready", spec_revision: 1,
        last_round: 1, head_revision: "head", active_order: null,
        cumulative_wall_ms: 10, cumulative_provider_tokens: 20,
        consecutive_stalled: 0, plateau_replans: 0, spec_sha256: "a".repeat(64),
        last_audit: {
          outcome: "waiting_human",
          next_action: { type: "ask_human", focus_criteria: ["quality"], reason: "Needs review" },
        },
      },
      events: [{ payload: { type: "LOOP_RESUMED" } }],
    } as unknown as Parameters<typeof loopStatusData>[0];
    expect(loopStatusData(loop)).toMatchObject({ status: "ready", resumed_from: "waiting_human", next_action: null });
    expect(renderLoopHuman(loop)).toContain("resumed after: waiting_human");
    expect(renderLoopHuman(loop)).not.toContain("next: ask_human");
  });
});
