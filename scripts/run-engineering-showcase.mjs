import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLoopCommand, createLongStore, createLoopCommand, loadLongStore, loadLoop,
  loopEvidenceTemplate, nextLoopCommand, recordLoopAuditEvent, recordLoopCommand,
} from "../dist/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
const flag = process.argv.indexOf("--output-dir");
if ((flag >= 0 && (flag !== 2 || process.argv.length !== 4)) || (flag < 0 && process.argv.length !== 2)) {
  throw new Error("usage: node scripts/run-engineering-showcase.mjs [--output-dir <directory>]");
}
const resultsRoot = join(root, "benchmarks", "results");
await mkdir(resultsRoot, { recursive: true });
const outputDir = flag < 0 ? await mkdtemp(join(resultsRoot, "engineering-")) : resolve(process.argv[3]);
if (flag >= 0) await mkdir(outputDir, { recursive: true });
process.chdir(outputDir);
const fixture = join(root, "benchmarks", "engineering-showcase");
const source = join(outputDir, "ledger.mjs");
const cases = ["tenant", "race", "retry"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceRevision = async () => `sha256:${digest(await readFile(source))}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

await copyFile(join(fixture, "baseline.mjs"), source);
const baselineRevision = await sourceRevision();
const spec = {
  kind: "jevrev.loop-spec", schema_version: "1", revision: 1,
  title: "Tenant-safe idempotency ledger",
  goal: "Repair a single in-memory event ledger so tenants are isolated, concurrent duplicates share one execution, and failed work can retry",
  workspace: ".",
  criteria: cases.map((id) => ({
    id, type: "hard", required_commands: [id],
    description: {
      tenant: "The same event ID in different tenants has independent outcomes",
      race: "Concurrent delivery of one event runs its handler once",
      retry: "A failed attempt does not poison a later retry",
    }[id],
  })),
  protected_surfaces: [],
  budget: { per_round_wall_ms: 120_000, per_round_changed_files: 1, pause_total_wall_ms: 600_000, pause_total_provider_tokens: 1_000 },
  plateau: { window: 3, min_material_delta: 0.01 },
};
const plan = {
  kind: "jevrev.round-plan", schema_version: "1",
  round_goal: "Run the three frozen idempotency invariants against the current ledger",
  focus_criteria: cases,
  hypothesis: "The ledger isolates tenants, coalesces duplicate work, and allows retry after failure",
  allowed_scope: ["ledger.mjs"], do_not_change: [],
  required_evidence: cases.map((id) => ({ id, kind: "command", description: `Execute the ${id} invariant` })),
  stop_conditions: ["Repair a failing invariant before requesting completion"],
};
const longSpec = {
  kind: "jevrev.long-spec", schema_version: "1", revision: 1,
  session_id: `jvlng_${randomBytes(8).toString("hex")}`,
  title: "Idempotency repair observer", goal: "Observe verified Loop audit outcomes without editing the ledger",
  workspace: ".", allowed_scope: ["ledger.mjs"], protected_surfaces: [], milestones: [],
  budget: { max_wall_ms: 600_000, max_provider_tokens: 1_000, max_tool_calls: 100 },
  thresholds: { stall_after_ms: 60_000, heartbeat_after_ms: 30_000, repeated_failure_window: 60_000, repeated_failure_count: 2, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 5_000 },
  alert_policy: { cooldown_ms: 1_000, max_open_alerts: 16, max_alert_history: 64, severity_escalation_window: 60_000 },
  observer_budget: { provider: "none", max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 1_000, min_interval_ms: 1_000, max_context_bytes: 4_000 },
};
const loopDir = join(outputDir, "loop");
const longDir = join(outputDir, "long");
await createLoopCommand(loopDir, spec, baselineRevision);
await createLongStore(longDir, longSpec);

const rounds = [];
let tamperRejected = false;
let duplicateSuppressed = false;
for (const round of [1, 2, 3]) {
  if (round === 2) await copyFile(join(fixture, "repaired.mjs"), source);
  const revision = await sourceRevision();
  const issued = await nextLoopCommand(loopDir, round === 3 ? undefined : plan);
  const evidencePath = join(outputDir, `evidence-${round}.json`);
  const evidenceTemplate = loopEvidenceTemplate(issued.loop, revision);
  evidenceTemplate.changed_files = round === 2 ? ["ledger.mjs"] : [];
  evidenceTemplate.builder_notes = round === 1
    ? "Baseline inspection: no code edit; execute frozen invariants."
    : round === 2 ? "Host copied the repaired candidate into the same ledger artifact."
      : "Fresh completion probe of the unchanged repaired revision.";
  await writeFile(evidencePath, json(evidenceTemplate));
  const checks = [];
  for (const id of cases) {
    const reportPath = join(outputDir, `round-${round}-${id}.json`);
    const observation = await recordLoopCommand({
      directory: loopDir, evidencePath, observationId: id, criterionIds: [id],
      argv: [process.execPath, join(fixture, "check.mjs"), source, id, reportPath],
    });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    if (report.passed !== (observation.exit_code === 0 && observation.termination === "exited")) {
      throw new Error(`Round ${round} ${id} report disagrees with the recorded process exit`);
    }
    checks.push({ id, ...report, exit_code: observation.exit_code, stdout_sha256: observation.stdout_sha256 });
  }
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const audited = await auditLoopCommand(loopDir, evidence);
  const bridge = {
    loop_id: audited.loop.state.loop_id, round_number: round,
    work_order_sha256: evidence.work_order_sha256,
    audit_outcome: audited.result.outcome, evidence_sha256: audited.result.evidence_sha256,
  };
  if (round === 1) {
    try {
      await recordLoopAuditEvent(longDir, loopDir, { ...bridge, evidence_sha256: "0".repeat(64) });
    } catch { tamperRejected = true; }
    if (!tamperRejected) throw new Error("Long accepted a mismatched Loop evidence digest");
  }
  const accepted = await recordLoopAuditEvent(longDir, loopDir, bridge);
  if (accepted.accepted.length !== 1) throw new Error(`Long did not record Loop round ${round}`);
  if (round === 1) {
    const replayed = await recordLoopAuditEvent(longDir, loopDir, bridge);
    duplicateSuppressed = replayed.accepted.length === 0;
    if (!duplicateSuppressed) throw new Error("Long did not deduplicate the replayed Loop audit");
  }
  rounds.push({
    number: round, mode: issued.order.mode, source_revision: revision,
    checks, outcome: audited.result.outcome,
    blocking_criteria: audited.result.blocking_criteria,
    next_action: audited.result.next_action.type,
    evidence_sha256: audited.result.evidence_sha256,
  });
}
const loop = await loadLoop(loopDir);
const long = await loadLongStore(longDir);
if (loop.state.status !== "completed" || rounds.map((item) => item.outcome).join(",") !== "fix_regression,verify,completed") {
  throw new Error("Unexpected engineering Loop sequence");
}
if (rounds[0].source_revision === rounds[1].source_revision || rounds[1].source_revision !== rounds[2].source_revision) {
  throw new Error("The same artifact did not change exactly once before fresh verification");
}
if (long.events.length !== 3 || long.events.some((event, index) => event.payload.payload.data.audit_outcome !== rounds[index].outcome)) {
  throw new Error("Long observation does not match the verified Loop audits");
}
const trace = {
  case: "tenant-safe-idempotency", loop_id: loop.state.loop_id, long_session_id: long.spec.session_id,
  spec_sha256: loop.state.spec_sha256, baseline_revision: baselineRevision,
  rounds, loop_event_count: loop.events.length, loop_event_head_sha256: loop.events.at(-1).event_sha256,
  long_event_count: long.events.length, long_event_head_sha256: long.snapshot.last_event_sha256,
  tampered_bridge_rejected: tamperRejected, duplicate_bridge_suppressed: duplicateSuppressed,
};
await writeFile(join(outputDir, "trace.json"), json(trace));
process.stdout.write([
  "JevRev engineering case — tenant-safe idempotency ledger",
  ...rounds.map((item) => `Round ${item.number} · ${item.mode} · ${item.checks.map((check) => `${check.id}:${check.passed ? "PASS" : "FAIL"}`).join(" ")} -> ${item.outcome}`),
  `Loop: ${loop.events.length} verified events · ${loop.state.status}`,
  `Long: ${long.events.length} verified audit observations · tamper rejected · replay deduplicated`,
  `Artifacts: ${outputDir}`, "",
].join("\n"));
