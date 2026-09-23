import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLoopCommand,
  createLoopCommand,
  loadLoop,
  loopEvidenceTemplate,
  nextLoopCommand,
  recordLoopCommand,
} from "../dist/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);

const outputFlag = process.argv.indexOf("--output-dir");
if (outputFlag >= 0 && (outputFlag !== 2 || process.argv.length !== 4)) {
  throw new Error("usage: node scripts/run-loop-demo.mjs [--output-dir <directory>]");
}
if (outputFlag < 0 && process.argv.length !== 2) {
  throw new Error("usage: node scripts/run-loop-demo.mjs [--output-dir <directory>]");
}
const resultRoot = join(root, "benchmarks", "results");
await mkdir(resultRoot, { recursive: true });
const outputDir = outputFlag >= 0
  ? resolve(process.argv[3])
  : await mkdtemp(join(resultRoot, "loop-demo-"));
if (outputFlag >= 0) await mkdir(outputDir, { recursive: true });

const source = await readFile(join(root, "benchmarks", "workflow-fixture", "indexed-state-machine.mjs"));
const headRevision = `sha256:${createHash("sha256").update(source).digest("hex")}`;
const directory = join(outputDir, "loop");
const spec = {
  kind: "jevrev.loop-spec",
  schema_version: "1",
  revision: 1,
  title: "Delimiter scanner evidence check",
  goal: "Verify the indexed state machine against the correctness and benchmark probes",
  workspace: ".",
  criteria: [
    { id: "correctness", type: "hard", description: "Five delimiter cases pass", required_commands: ["correctness"] },
    { id: "benchmark", type: "hard", description: "The benchmark probe completes", required_commands: ["benchmark"] },
  ],
  protected_surfaces: [],
  budget: {
    per_round_wall_ms: 60_000,
    per_round_changed_files: 1,
    pause_total_wall_ms: 300_000,
    pause_total_provider_tokens: 1_000,
  },
  plateau: { window: 3, min_material_delta: 0.01 },
};
const plan = {
  kind: "jevrev.round-plan",
  schema_version: "1",
  round_goal: "Collect the missing evidence for the same scanner revision",
  focus_criteria: ["correctness", "benchmark"],
  hypothesis: "The candidate passes correctness and the benchmark command produces samples",
  allowed_scope: [],
  do_not_change: [],
  required_evidence: [
    { id: "correctness", description: "Run the five correctness cases", kind: "command" },
    { id: "benchmark", description: "Record the benchmark command outcome", kind: "command" },
  ],
  stop_conditions: ["Stop if either required command fails"],
};

await createLoopCommand(directory, spec, headRevision);
const trace = [];
for (const round of [1, 2, 3]) {
  const issued = await nextLoopCommand(directory, round === 3 ? undefined : plan);
  const order = issued.order;
  const evidencePath = join(outputDir, `evidence-${round}.json`);
  await writeFile(evidencePath, `${JSON.stringify(loopEvidenceTemplate(issued.loop, headRevision), null, 2)}\n`);
  for (const id of round === 1 ? ["correctness"] : ["correctness", "benchmark"]) {
    const observation = await recordLoopCommand({
      directory,
      evidencePath,
      observationId: id,
      criterionIds: [id],
      argv: [process.execPath, "benchmarks/workflow-fixture/probe.mjs", "indexed-state-machine", id],
    });
    if (observation.exit_code !== 0 || observation.termination !== "exited") {
      throw new Error(`Round ${round} ${id} command failed`);
    }
  }
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const audited = await auditLoopCommand(directory, evidence);
  trace.push({
    round,
    mode: order.mode,
    recorded_commands: evidence.observations.map(({ id, exit_code, source }) => ({ id, exit_code, source })),
    outcome: audited.result.outcome,
    next_action: audited.result.next_action.type,
    status: audited.loop.state.status,
  });
}
const loop = await loadLoop(directory);
if (loop.state.status !== "completed" || trace.map(({ outcome }) => outcome).join(",") !== "continue,verify,completed") {
  throw new Error("Unexpected Loop demonstration outcome");
}
await writeFile(join(outputDir, "trace.json"), `${JSON.stringify({ head_revision: headRevision, trace }, null, 2)}\n`);
process.stdout.write([
  "JevRev Loop demo — recorded commands on one unchanged scanner revision",
  ...trace.map((item) => `Round ${item.round}: ${item.recorded_commands.map(({ id }) => id).join(" + ")} -> ${item.outcome} (${item.status})`),
  `Artifacts: ${outputDir}`,
  "",
].join("\n"));
