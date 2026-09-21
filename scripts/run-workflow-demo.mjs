import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDecidePlan,
  buildQuestionPlan,
  prepareDecision,
} from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const fixtureDir = join(root, "benchmarks", "workflow-fixture");
const resultDir = join(root, "benchmarks", "results", "workflow-demo");
const requestPath = join(root, "examples", "delimiter-counter.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function cliRun(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`jevrev ${args[0]} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function scoreAnswer(score) {
  return {
    type: "score",
    score,
    confidence: 0.9,
    legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" },
    probabilities: { "0": 0, "1": 0, "2": score < 3 ? 1 : 0, "3": score === 3 ? 1 : 0 },
  };
}

function siftReplay(request) {
  const plan = buildQuestionPlan(request);
  const answers = {};
  for (const [key, type] of Object.entries(plan.expectedTypes)) {
    const candidate = /^candidate_(\d+)_(.+)$/.exec(key);
    if (candidate !== null) {
      const index = Number(candidate[1]);
      const signal = candidate[2];
      const paperFavorite = index === 0;
      if (type === "score") {
        const score = signal === "goal_fit"
          ? paperFavorite ? 3 : 2.7
          : signal === "feasibility"
            ? paperFavorite ? 2.9 : 2.6
            : 2.7;
        answers[key] = scoreAnswer(score);
      } else {
        answers[key] = { type: "noul", noul: paperFavorite ? 0.94 : 0.86 };
      }
    } else {
      answers[key] = { type: "noul", noul: 0.04 };
    }
  }
  return {
    model: "jev-sift-fixture",
    candidate_order: [...plan.candidateIds],
    answers,
    usage: { input_tokens: 320, output_tokens: Object.keys(answers).length * 4 },
  };
}

function executeProbe(candidateId, mode) {
  const argv = [join(fixtureDir, "probe.mjs"), candidateId, mode];
  const started = performance.now();
  const result = spawnSync(process.execPath, argv, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const durationMs = Math.round(performance.now() - started);
  if (result.error || result.status === null) {
    throw result.error ?? new Error(`${candidateId}/${mode} did not exit normally`);
  }
  return {
    result,
    observation: {
      id: mode,
      kind: "command",
      argv: [process.execPath, ...argv.map((value) => relative(root, value) || value)],
      exit_code: result.status,
      duration_ms: durationMs,
      required: true,
      stdout_sha256: sha256(result.stdout),
      stderr_sha256: sha256(result.stderr),
    },
  };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function requirement(criterionId, kind, status, observationIds = [], metricIds = []) {
  return {
    criterion_id: criterionId,
    kind,
    status,
    observation_ids: observationIds,
    metric_ids: metricIds,
  };
}

async function evidencePacket(campaign, workOrder) {
  const candidateId = workOrder.candidate_id;
  const correctness = executeProbe(candidateId, "correctness");
  const benchmark = executeProbe(candidateId, "benchmark");
  if (benchmark.result.status !== 0) {
    throw new Error(`${candidateId} benchmark failed: ${benchmark.result.stderr}`);
  }
  const measured = JSON.parse(benchmark.result.stdout);
  const correctnessOutput = JSON.parse(correctness.result.stdout);
  const metric = {
    id: "throughput",
    kind: "metric",
    criterion_id: "speed",
    unit: measured.unit,
    direction: measured.direction,
    baseline_samples: measured.baseline_samples,
    candidate_samples: measured.candidate_samples,
  };
  const speedPassed = average(metric.candidate_samples) > average(metric.baseline_samples);
  const correctnessPassed = correctness.result.status === 0;
  const sourcePath = join(fixtureDir, `${candidateId}.mjs`);
  const source = await readFile(sourcePath, "utf8");
  const sourceHash = sha256(source);
  const probeStatuses = [correctnessPassed, speedPassed];

  return {
    kind: "jevrev.evidence-packet",
    schema_version: "1",
    campaign_id: campaign.campaign_id,
    candidate_id: candidateId,
    candidate_sha256: workOrder.candidate_sha256,
    revision: {
      base_commit: `sha256:${sha256(await readFile(join(fixtureDir, "baseline.mjs")))}`,
      head_commit: `sha256:${sourceHash}`,
      diff_sha256: sourceHash,
    },
    development: {
      status: "completed",
      wall_ms: correctness.observation.duration_ms + benchmark.observation.duration_ms,
    },
    observations: [correctness.observation, benchmark.observation],
    metrics: [metric],
    requirement_results: [
      requirement("correctness", "constraint", correctnessPassed ? "pass" : "fail", ["correctness"]),
      requirement("api", "constraint", "pass", ["correctness"]),
      requirement("speed", "success", speedPassed ? "pass" : "fail", ["benchmark"], ["throughput"]),
      requirement("tests", "success", correctnessPassed ? "pass" : "fail", ["correctness"]),
    ],
    probe_results: workOrder.required_evidence.map((evidence, index) => ({
      evidence_id: evidence.id,
      status: probeStatuses[index] ? "pass" : "fail",
      observation_ids: [index === 0 ? "correctness" : "benchmark"],
      metric_ids: index === 0 ? [] : ["throughput"],
    })),
    artifacts: [{
      id: "implementation",
      path: relative(root, sourcePath).replaceAll("\\", "/"),
      media_type: "text/javascript",
      sha256: sourceHash,
      size_bytes: Buffer.byteLength(source),
      content_excerpt: source,
    }],
    artifact_evaluations: [{
      id: "correctness-evaluation",
      source: "imported",
      evaluator: "benchmarks/workflow-fixture/probe.mjs",
      artifact_ids: ["implementation"],
      criterion_id: "tests",
      status: correctnessPassed ? "pass" : "fail",
      score: correctnessPassed ? 1 : 0,
      summary: correctnessPassed
        ? `All ${correctnessOutput.cases} correctness cases passed.`
        : `${correctnessOutput.failures.length} of ${correctnessOutput.cases} correctness cases failed.`,
      output_sha256: correctness.observation.stdout_sha256,
    }],
    changed_files: [relative(root, sourcePath).replaceAll("\\", "/")],
    known_failures: correctnessPassed
      ? []
      : correctnessOutput.failures.map((failure) =>
          `Incorrect result for ${JSON.stringify(failure.input)}: expected ${failure.expected}, received ${failure.actual}`),
  };
}

await mkdir(resultDir, { recursive: true });
const request = JSON.parse(await readFile(requestPath, "utf8"));
const siftReplayPath = join(resultDir, "sift-replay.json");
await writeFile(siftReplayPath, `${JSON.stringify(siftReplay(request), null, 2)}\n`, "utf8");
const campaign = JSON.parse(cliRun([
  "sift",
  "--input", requestPath,
  "--replay", siftReplayPath,
]));
const packets = [];
for (const workOrder of campaign.work_orders) {
  packets.push(await evidencePacket(campaign, workOrder));
}
const evidence = {
  kind: "jevrev.evidence-bundle",
  schema_version: "1",
  campaign_id: campaign.campaign_id,
  packets,
};

const prepared = prepareDecision(campaign, evidence);
const plan = buildDecidePlan(prepared);
const answers = {};
for (const [key, type] of Object.entries(plan.expectedTypes)) {
  answers[key] = type === "score"
    ? {
        type: "score",
        score: 2.8,
        confidence: 0.9,
        legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" },
        probabilities: { "0": 0, "1": 0, "2": 0.2, "3": 0.8 },
      }
    : { type: "noul", noul: 0.92 };
}
const decideReplay = {
  model: "jev-decide-fixture",
  candidate_order: [...plan.candidateIds],
  answers,
  usage: { input_tokens: 480, output_tokens: Object.keys(answers).length * 4 },
};

const campaignPath = join(resultDir, "campaign.json");
const evidencePath = join(resultDir, "evidence.json");
const decideReplayPath = join(resultDir, "decide-replay.json");
await writeFile(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await writeFile(decideReplayPath, `${JSON.stringify(decideReplay, null, 2)}\n`, "utf8");

const decision = JSON.parse(cliRun([
  "decide",
  "--campaign", campaignPath,
  "--evidence", evidencePath,
  "--replay", decideReplayPath,
]));
if (decision.decision !== "winner" || decision.winner !== "indexed-state-machine") {
  throw new Error(`Expected indexed-state-machine winner, received ${JSON.stringify(decision)}`);
}
await writeFile(join(resultDir, "decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");

const paperWinner = campaign.sift.decisions[0];
const winner = decision.evaluations.find((item) => item.candidate_id === decision.winner);
const loser = decision.evaluations.find((item) => item.candidate_id === paperWinner.candidate_id);
const loserMetric = loser.objective.metrics[0];
const winnerMetric = winner.objective.metrics[0];
process.stdout.write([
  "JevRev workflow demo — executed ranking reversal",
  `Paper favorite: ${paperWinner.candidate_id} (sift score ${paperWinner.score})`,
  `  measured throughput: ${(1 + loserMetric.relative_improvement).toFixed(2)}x baseline`,
  `  correctness command: failed`,
  `  result: ${loser.status} (${loser.reasons.join(", ")})`,
  `Evidence winner: ${decision.winner}`,
  `  measured throughput: ${(1 + winnerMetric.relative_improvement).toFixed(2)}x baseline`,
  `  correctness command: passed`,
  `Decision: ${decision.decision} -> ${decision.next_action.type}`,
  `Artifacts: ${resultDir}`,
  "",
].join("\n"));
