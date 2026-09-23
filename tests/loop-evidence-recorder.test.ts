import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLoop, loadLoop } from "../src/loop/store.js";
import { issueNextRound } from "../src/loop/planner.js";
import { loopEvidenceTemplate } from "../src/loop/commands.js";
import { recordLoopArtifact, recordLoopCommand, recordLoopMetric } from "../src/loop/evidence-recorder.js";
import { roundEvidenceSchema } from "../src/loop/schemas.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const spec = {
  kind: "jevrev.loop-spec" as const, schema_version: "1" as const, revision: 1, title: "Recorder", goal: "Record a round", workspace: ".",
  criteria: [{ id: "tests", type: "hard" as const, description: "Tests pass", required_commands: ["tests"] }, { id: "quality", type: "metric" as const, description: "Quality", unit: "score", direction: "higher" as const, aggregation: "mean" as const, target: 1, minimum_samples: 2 }],
  protected_surfaces: [], budget: { per_round_wall_ms: 10_000, per_round_changed_files: 2, pause_total_wall_ms: 100_000, pause_total_provider_tokens: 10_000 }, plateau: { window: 3, min_material_delta: 0.01 },
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jevrev-loop-recorder-")); roots.push(root);
  const directory = join(root, "loop");
  await createLoop(directory, spec, "base");
  const issued = await issueNextRound(directory, { kind: "jevrev.round-plan", schema_version: "1", round_goal: "Record facts", focus_criteria: ["tests", "quality"], hypothesis: "Recorder is usable", allowed_scope: [], do_not_change: [], required_evidence: [{ id: "tests", description: "tests", kind: "command" }, { id: "quality", description: "quality", kind: "metric" }], stop_conditions: ["Stop on failure"] });
  const evidencePath = join(root, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(loopEvidenceTemplate(await loadLoop(directory), "head")));
  return { root, directory, evidencePath, order: issued.order };
}

describe("JevLoop evidence recorder", () => {
  it("records a direct command into the active round without advancing Loop", async () => {
    const { directory, evidencePath } = await fixture();
    const observation = await recordLoopCommand({ directory, evidencePath, observationId: "tests", argv: [process.execPath, "-e", "process.stdout.write('ok')"], criterionIds: ["tests"] });
    expect(observation).toMatchObject({ id: "tests", exit_code: 0, termination: "exited", head_revision: "head" });
    const evidence = roundEvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    expect(evidence.criterion_results.find((item) => item.id === "tests")).toMatchObject({ status: "pass", observation_ids: ["tests"] });
    expect((await loadLoop(directory)).state.status).toBe("issued");
  });

  it("records metric and artifact facts against the same head revision", async () => {
    const { directory, evidencePath } = await fixture();
    await recordLoopMetric({ directory, evidencePath, metric: { id: "quality", criterion_id: "quality", unit: "score", samples: [1, 1.1] }, result: "pass" });
    await recordLoopArtifact({ directory, evidencePath, artifactId: "report", file: "README.md", summary: "Report was inspected", status: "pass", criterionId: "quality" });
    const evidence = roundEvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    expect(evidence.metrics).toHaveLength(1);
    expect(evidence.criterion_results.find((item) => item.id === "quality")).toMatchObject({ status: "pass", metric_ids: ["quality"], artifact_evaluation_ids: ["report"] });
  });

  it("allows the CLI-style criterion override when metric JSON is generic", async () => {
    const { directory, evidencePath } = await fixture();
    await recordLoopMetric({ directory, evidencePath, criterionId: "quality", metric: { id: "quality", unit: "score", samples: [1, 1.1] }, result: "pass" });
    const evidence = roundEvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    expect(evidence.metrics[0]).toMatchObject({ criterion_id: "quality", head_revision: "head" });
  });

  it("rejects a metric attached to a hard criterion or with the wrong unit", async () => {
    const { directory, evidencePath } = await fixture();
    await expect(recordLoopMetric({ directory, evidencePath, criterionId: "tests", metric: { id: "bad", unit: "score", samples: [1, 1.1] } })).rejects.toThrow("metric criterion");
    await expect(recordLoopMetric({ directory, evidencePath, criterionId: "quality", metric: { id: "bad", unit: "milliseconds", samples: [1, 1.1] } })).rejects.toThrow("unit does not match");
  });

  it("recovers a lock left by a dead process", async () => {
    const { directory, evidencePath } = await fixture();
    writeFileSync(`${evidencePath}.lock`, JSON.stringify({ pid: 999999, created_at: new Date().toISOString() }));
    const observation = await recordLoopCommand({ directory, evidencePath, observationId: "tests", argv: [process.execPath, "-e", "process.stdout.write('ok')"], criterionIds: ["tests"] });
    expect(observation.exit_code).toBe(0);
  });
});
