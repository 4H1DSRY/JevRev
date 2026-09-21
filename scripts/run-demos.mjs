import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resultDir = join(root, "benchmarks", "results");
const cli = join(root, "dist", "cli.js");

const profiles = {
  "parser-speedup": {
    good: ["allocation-cut", "byte-fast-path"],
    expectedSelected: ["allocation-cut", "byte-fast-path"],
    medium: ["bounded-memoization", "incremental-cache"],
    duplicatePairs: [["allocation-cut", "object-pool"]],
  },
  "api-boundary-hardening": {
    good: ["shared-boundary-validator"],
    expectedSelected: ["shared-boundary-validator", "handler-try-catch"],
    medium: ["handler-try-catch", "fuzz-only"],
    duplicatePairs: [],
  },
  "flaky-ci-concurrency": {
    good: ["isolated-db-namespace", "injected-clock"],
    expectedSelected: ["isolated-db-namespace", "injected-clock"],
    medium: ["serialize-suite"],
    duplicatePairs: [],
  },
};

function scoreAnswer(score) {
  const lower = Math.floor(score);
  const upper = Math.ceil(score);
  const probabilities = { "0": 0, "1": 0, "2": 0, "3": 0 };
  if (lower === upper) probabilities[String(lower)] = 1;
  else {
    probabilities[String(lower)] = upper - score;
    probabilities[String(upper)] = score - lower;
  }
  return {
    type: "score",
    score,
    confidence: 0.9,
    legend: { "0": "weak", "1": "limited", "2": "plausible", "3": "strong" },
    probabilities,
  };
}

function responseFor(request, profile) {
  const answers = {};
  const good = new Set(profile.good);
  const medium = new Set(profile.medium);
  const duplicatePairs = new Set(profile.duplicatePairs.map(([a, b]) => [a, b].sort().join("\0")));
  const signalValue = (candidate, signal) => {
    const id = candidate.id;
    if (signal === "constraint_fit") {
      const bad = ["native-extension", "parallel-parser", "coerce-everything", "raise-body-limit", "blanket-retry", "longer-timeouts", "serialize-suite", "skip-flaky-case"].includes(id);
      return bad ? 0.08 : 0.94;
    }
    if (signal === "execution_value") return good.has(id) ? 0.94 : medium.has(id) ? 0.72 : 0.18;
    if (good.has(id)) return 2.8;
    if (medium.has(id)) return 2.0;
    return signal === "validation_quality" ? 0.8 : 0.7;
  };

  request.candidates.forEach((candidate, index) => {
    answers[`candidate_${index}_goal_fit`] = scoreAnswer(signalValue(candidate, "goal_fit"));
    answers[`candidate_${index}_constraint_fit`] = { type: "noul", noul: signalValue(candidate, "constraint_fit") };
    answers[`candidate_${index}_feasibility`] = scoreAnswer(signalValue(candidate, "feasibility"));
    answers[`candidate_${index}_validation_quality`] = scoreAnswer(signalValue(candidate, "validation_quality"));
    answers[`candidate_${index}_execution_value`] = { type: "noul", noul: signalValue(candidate, "execution_value") };
  });
  for (let left = 0; left < request.candidates.length; left += 1) {
    for (let right = left + 1; right < request.candidates.length; right += 1) {
      const pair = [request.candidates[left].id, request.candidates[right].id].sort().join("\0");
      answers[`pair_${left}_${right}_duplicate`] = { type: "noul", noul: duplicatePairs.has(pair) ? 0.96 : 0.05 };
    }
  }
  return {
    model: "jevrev-demo-replay",
    answers,
    usage: { input_tokens: Object.keys(answers).length * 40, output_tokens: Object.keys(answers).length * 4 },
  };
}

await mkdir(resultDir, { recursive: true });
for (const [name, profile] of Object.entries(profiles)) {
  const requestPath = join(root, "examples", `${name}.json`);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const replayPath = join(resultDir, `${name}-replay.json`);
  await writeFile(replayPath, `${JSON.stringify(responseFor(request, profile), null, 2)}\n`, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", "--input", requestPath, "--replay", replayPath, "--format", "human"], {
    cwd: root,
    encoding: "utf8",
  });
  process.stdout.write(`\n=== ${name} ===\n`);
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
  }
  const validation = spawnSync(process.execPath, [cli, "run", "--input", requestPath, "--replay", replayPath, "--format", "json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (validation.status !== 0) {
    throw new Error(`${name}: JSON validation run failed: ${validation.stderr || validation.stdout}`);
  }
  const parsed = JSON.parse(validation.stdout);
  const missing = profile.expectedSelected.filter((id) => !parsed.selected.includes(id));
  if (missing.length > 0) {
    throw new Error(`${name}: expected selected IDs missing: ${missing.join(", ")}`);
  }
}
