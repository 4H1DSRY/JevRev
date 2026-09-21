import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { arch, cpus, platform, release } from "node:os";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const resultsDir = join(root, "benchmarks", "results");
const tempDir = join(resultsDir, "requests");
const cli = join(root, "dist", "cli.js");
const requestedReps = Number(process.env.JEVREV_BENCH_REPS ?? "5");
const provider = process.env.JEVREV_BENCH_PROVIDER ?? "semif";
const semifUrl = process.env.JEVREV_SEMIF_URL ?? "http://127.0.0.1:4878";
const inputPrice = Number(process.env.JEVREV_INPUT_USD_PER_MILLION ?? "0");
const outputPrice = Number(process.env.JEVREV_OUTPUT_USD_PER_MILLION ?? "0");
const artifactSha256 = createHash("sha256").update(await readFile(cli)).digest("hex");
const benchmarkRunId = `bench_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const hostMetadata = {
  benchmark_run_id: benchmarkRunId,
  node: process.version,
  platform: `${platform()}-${arch()}`,
  os_release: release(),
  cpu_model: cpus()[0]?.model ?? "unknown",
  cli_sha256: artifactSha256,
};

if (!Number.isInteger(requestedReps) || requestedReps < 5) {
  throw new Error("JEVREV_BENCH_REPS must be an integer of at least 5");
}
if (provider !== "semif" && provider !== "jev" && provider !== "local") {
  throw new Error("JEVREV_BENCH_PROVIDER must be semif, jev, or local");
}

const manifests = {
  "parser-speedup": {
    utility: {
      "allocation-cut": 0.95,
      "byte-fast-path": 1,
      "bounded-memoization": 0.55,
      "object-pool": 0.8,
      "parallel-parser": 0.15,
      "native-extension": 0.05,
      "incremental-cache": 0.35,
    },
    expected: ["allocation-cut", "byte-fast-path"],
  },
  "api-boundary-hardening": {
    utility: {
      "shared-boundary-validator": 1,
      "handler-try-catch": 0.7,
      "fuzz-only": 0.45,
      "coerce-everything": 0.05,
      "raise-body-limit": 0.02,
      "rewrite-http-layer": 0.25,
    },
    expected: ["shared-boundary-validator", "handler-try-catch"],
  },
  "flaky-ci-concurrency": {
    utility: {
      "isolated-db-namespace": 1,
      "injected-clock": 0.95,
      "blanket-retry": 0.05,
      "longer-timeouts": 0.15,
      "serialize-suite": 0.45,
      "skip-flaky-case": 0,
    },
    expected: ["isolated-db-namespace", "injected-clock"],
  },
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const stdev = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const round = (value, digits = 3) => Number(value.toFixed(digits));

function rotate(items, amount) {
  const offset = amount % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function runOne(requestPath, providerName) {
  const args = [cli, "run", "--input", requestPath, "--provider", providerName, "--format", "json"];
  if (providerName === "semif") args.push("--semif-url", semifUrl);
  if (providerName === "local") args.push("--local-url", process.env.JEVREV_LOCAL_URL ?? "http://127.0.0.1:4877");
  const started = performance.now();
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  const elapsedMs = performance.now() - started;
  if (result.status !== 0) {
    throw new Error(`JevRev failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return { result: JSON.parse(result.stdout), elapsedMs };
}

await mkdir(tempDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });
for (const name of Object.keys(manifests)) {
  await rm(join(resultsDir, `${name}-summary.json`), { force: true });
}
await rm(join(resultsDir, "raw.jsonl"), { force: true });
const raw = [];
const summaries = [];

for (const [name, manifest] of Object.entries(manifests)) {
  const original = JSON.parse(await readFile(join(root, "examples", `${name}.json`), "utf8"));
  const reps = Math.max(requestedReps, original.candidates.length);
  const quality = [];
  const elapsed = [];
  const inputTokens = [];
  const outputTokens = [];
  const selectedCounts = [];
  const shortlistCounts = [];

  for (let repetition = 0; repetition < reps; repetition += 1) {
    const request = {
      ...original,
      candidates: rotate(original.candidates, repetition),
    };
    const requestPath = join(tempDir, `${name}-${repetition}.json`);
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const baselineId = request.candidates[0].id;
    const baselineQuality = manifest.utility[baselineId] ?? 0;
    const execution = runOne(requestPath, provider);
    const selectedUtilities = execution.result.selected.map((id) => manifest.utility[id] ?? 0);
    const shortlistUtilities = execution.result.shortlist.map((id) => manifest.utility[id] ?? 0);
    const selectedQuality = selectedUtilities.length === 0
      ? 0
      : Math.max(...selectedUtilities);
    const shortlistQuality = shortlistUtilities.length === 0
      ? 0
      : Math.max(...shortlistUtilities);
    const selectedMeanUtility = selectedUtilities.length === 0
      ? 0
      : mean(selectedUtilities);
    const shortlistMeanUtility = shortlistUtilities.length === 0
      ? 0
      : mean(shortlistUtilities);
    const expected = new Set(manifest.expected);
    const selectedSet = new Set(execution.result.selected);
    const shortlistSet = new Set(execution.result.shortlist);
    const selectedTruePositives = [...selectedSet].filter((id) => expected.has(id)).length;
    const shortlistTruePositives = [...shortlistSet].filter((id) => expected.has(id)).length;
    quality.push({
      baseline: baselineQuality,
      selected: selectedQuality,
      shortlist: shortlistQuality,
      selectedMeanUtility,
      shortlistMeanUtility,
      selectedPrecision: selectedSet.size === 0 ? 0 : selectedTruePositives / selectedSet.size,
      shortlistPrecision: shortlistSet.size === 0 ? 0 : shortlistTruePositives / shortlistSet.size,
      selectedRecall: expected.size === 0 ? 0 : selectedTruePositives / expected.size,
      shortlistRecall: expected.size === 0 ? 0 : shortlistTruePositives / expected.size,
    });
    elapsed.push(execution.elapsedMs);
    inputTokens.push(execution.result.usage.input_tokens);
    outputTokens.push(execution.result.usage.output_tokens);
    selectedCounts.push(execution.result.selected.length);
    shortlistCounts.push(execution.result.shortlist.length);
    raw.push({
      benchmark_run_id: benchmarkRunId,
      scenario: name,
      repetition: repetition + 1,
      provider,
      timestamp_utc: new Date().toISOString(),
      node: process.version,
      model: execution.result.model,
      endpoint: provider === "semif" ? `${semifUrl.replace(/\/$/, "")}/v1/chat/completions` : provider,
      cli_sha256: artifactSha256,
      host: hostMetadata,
      run_id: execution.result.run_id,
      baseline_id: baselineId,
      baseline_quality: baselineQuality,
      selected: execution.result.selected,
      shortlist: execution.result.shortlist,
      selected_quality: selectedQuality,
      shortlist_quality: shortlistQuality,
      selected_mean_utility: selectedMeanUtility,
      shortlist_mean_utility: shortlistMeanUtility,
      selected_precision: quality.at(-1).selectedPrecision,
      shortlist_precision: quality.at(-1).shortlistPrecision,
      selected_recall: quality.at(-1).selectedRecall,
      shortlist_recall: quality.at(-1).shortlistRecall,
      elapsed_ms: round(execution.elapsedMs, 1),
      input_tokens: execution.result.usage.input_tokens,
      output_tokens: execution.result.usage.output_tokens,
      estimated_token_cost_usd: (execution.result.usage.input_tokens * inputPrice + execution.result.usage.output_tokens * outputPrice) / 1_000_000,
      pricing: { input_usd_per_million: inputPrice, output_usd_per_million: outputPrice, basis: "user-supplied illustrative rates; not official Jev billing" },
    });
  }

  const baselineValues = quality.map((item) => item.baseline);
  const selectedValues = quality.map((item) => item.selected);
  const shortlistValues = quality.map((item) => item.shortlist);
  const selectedMeanUtilities = quality.map((item) => item.selectedMeanUtility);
  const shortlistMeanUtilities = quality.map((item) => item.shortlistMeanUtility);
  const selectedPrecisions = quality.map((item) => item.selectedPrecision);
  const shortlistPrecisions = quality.map((item) => item.shortlistPrecision);
  const selectedRecalls = quality.map((item) => item.selectedRecall);
  const shortlistRecalls = quality.map((item) => item.shortlistRecall);
  const inputMean = mean(inputTokens);
  const outputMean = mean(outputTokens);
  const judgeCost = (inputMean * inputPrice + outputMean * outputPrice) / 1_000_000;
  const summary = {
    scenario: name,
    repetitions: reps,
    repetitions_requested: requestedReps,
    rotation_method: "deterministic cyclic rotation covering every candidate as first item",
    run_metadata: hostMetadata,
    provider,
    expected_high_value: manifest.expected,
    baseline_first_idea: {
      quality_mean: round(mean(baselineValues)),
      quality_stdev: round(stdev(baselineValues)),
      implementation_slots: 1,
      judge_time_ms: 0,
      judge_tokens: 0,
      estimated_token_cost_usd: 0,
    },
    jevrev: {
      shortlist_quality_mean: round(mean(shortlistValues)),
      shortlist_quality_stdev: round(stdev(shortlistValues)),
      shortlist_mean_utility: round(mean(shortlistMeanUtilities)),
      shortlist_precision_mean: round(mean(shortlistPrecisions)),
      shortlist_recall_mean: round(mean(shortlistRecalls)),
      strict_selected_quality_mean: round(mean(selectedValues)),
      strict_selected_quality_stdev: round(stdev(selectedValues)),
      strict_selected_mean_utility: round(mean(selectedMeanUtilities)),
      strict_selected_precision_mean: round(mean(selectedPrecisions)),
      strict_selected_recall_mean: round(mean(selectedRecalls)),
      elapsed_ms_mean: round(mean(elapsed), 1),
      elapsed_ms_stdev: round(stdev(elapsed), 1),
      input_tokens_mean: round(inputMean, 1),
      output_tokens_mean: round(outputMean, 1),
      implementation_slots_mean: round(mean(selectedCounts)),
      shortlist_slots_mean: round(mean(shortlistCounts)),
      estimated_token_cost_usd_mean: round(judgeCost, 6),
      estimated_token_cost_delta_vs_first_idea_usd: round(judgeCost, 6),
    },
    compare_with_implement_all: {
      candidate_count: original.candidates.length,
      implementation_slots_saved_mean: round(original.candidates.length - mean(shortlistCounts), 2),
    },
    pricing: {
      input_usd_per_million: inputPrice,
      output_usd_per_million: outputPrice,
      basis: "user-supplied illustrative rates; not official Jev billing",
    },
    cost_note: provider === "jev"
      ? "Estimated token cost uses the supplied illustrative rates; it is not official Jev billing."
      : "Local inference is reported at $0 API spend; hardware and electricity are excluded.",
  };
  summaries.push(summary);
  console.log(`\n${name}`);
  console.log(`  first-idea quality: ${summary.baseline_first_idea.quality_mean} ± ${summary.baseline_first_idea.quality_stdev}`);
  console.log(`  JevRev shortlist:   ${summary.jevrev.shortlist_quality_mean} ± ${summary.jevrev.shortlist_quality_stdev}`);
  console.log(`  shortlist precision/recall: ${summary.jevrev.shortlist_precision_mean} / ${summary.jevrev.shortlist_recall_mean}`);
  console.log(`  strict selected:    ${summary.jevrev.strict_selected_quality_mean} ± ${summary.jevrev.strict_selected_quality_stdev}`);
  console.log(`  JevRev time:        ${summary.jevrev.elapsed_ms_mean} ms ± ${summary.jevrev.elapsed_ms_stdev}`);
  console.log(`  JevRev tokens:      ${summary.jevrev.input_tokens_mean} in / ${summary.jevrev.output_tokens_mean} out`);
  console.log(`  estimated token cost: $${summary.jevrev.estimated_token_cost_usd_mean.toFixed(6)} per run`);
  console.log(`  slots vs all:       saves ${summary.compare_with_implement_all.implementation_slots_saved_mean}`);
}

for (const summary of summaries) {
  await writeFile(
    join(resultsDir, `${summary.scenario}-summary.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
}
await writeFile(join(resultsDir, "raw.jsonl"), `${raw.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
console.log(`\nRaw observations: ${join(resultsDir, "raw.jsonl")}`);
