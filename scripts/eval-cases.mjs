#!/usr/bin/env node

/*
 * Run request fixtures from another directory through the built JevRev CLI.
 * This script is intentionally read-only: it creates no result files and
 * inherits credentials from the current process without ever printing them.
 */

import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "dist", "cli.js");

function usage() {
  return [
    "Usage: node scripts/eval-cases.mjs --cases-dir <path> [options]",
    "",
    "Options:",
    "  --cases-dir <path>    directory containing request JSON files",
    "  --provider <name>     jev, semif, or local (default: semif)",
    "  --all                 include every request-shaped JSON file (default: case*.json)",
    "  --timeout-ms <n>      per-case child-process timeout (default: 300000)",
    "  --semif-url <url>     pass a SemIf endpoint to the CLI",
    "  --local-url <url>     pass a local scorer endpoint to the CLI",
    "  --jev-url <url>       pass a Jev endpoint to the CLI",
    "  --model <name>        pass a Jev model to the CLI",
    "  -h, --help            show this help",
    "",
    "The JEVREV_JEV_API_KEY/TYPESAFE_API_KEY environment variable is inherited",
    "by the child process. It is never read into output or written to disk.",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {
    casesDir: process.env.JEVREV_CASES_DIR,
    provider: process.env.JEVREV_EVAL_PROVIDER ?? "semif",
    all: false,
    timeoutMs: Number(process.env.JEVREV_EVAL_TIMEOUT_MS ?? "300000"),
    semifUrl: undefined,
    localUrl: undefined,
    jevUrl: undefined,
    model: undefined,
  };

  const valueOptions = new Map([
    ["--cases-dir", "casesDir"],
    ["--provider", "provider"],
    ["--timeout-ms", "timeoutMs"],
    ["--semif-url", "semifUrl"],
    ["--local-url", "localUrl"],
    ["--jev-url", "jevUrl"],
    ["--model", "model"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--all") {
      values.all = true;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    const key = valueOptions.get(option);
    if (key === undefined) {
      throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    values[key] = key === "timeoutMs" ? Number(value) : value;
  }

  if (values.casesDir === undefined || values.casesDir.length === 0) {
    throw new Error(`--cases-dir is required (or set JEVREV_CASES_DIR)\n\n${usage()}`);
  }
  if (!isAbsolute(values.casesDir)) values.casesDir = resolve(process.cwd(), values.casesDir);
  if (!["jev", "semif", "local"].includes(values.provider)) {
    throw new Error(`--provider must be jev, semif, or local (received ${values.provider})`);
  }
  if (!Number.isInteger(values.timeoutMs) || values.timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return values;
}

function isRequest(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.version === "1" &&
      value.task &&
      typeof value.task === "object" &&
      Array.isArray(value.candidates) &&
      value.budget &&
      typeof value.budget === "object",
  );
}

async function requestFiles(directory, includeAll) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
    if (!includeAll && !/^case\d+[-_].*\.json$/i.test(entry.name)) continue;
    const path = join(directory, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isRequest(parsed)) files.push(path);
  }
  files.sort((left, right) => basename(left).localeCompare(basename(right), "en", { numeric: true }));
  return files;
}

function childArgs(options, inputPath) {
  const args = [cli, "run", "--input", inputPath, "--provider", options.provider, "--format", "json"];
  if (options.semifUrl !== undefined) args.push("--semif-url", options.semifUrl);
  if (options.localUrl !== undefined) args.push("--local-url", options.localUrl);
  if (options.jevUrl !== undefined) args.push("--jev-url", options.jevUrl);
  if (options.model !== undefined) args.push("--model", options.model);
  return args;
}

function redactSecrets(value) {
  let redacted = value;
  for (const name of ["JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY"]) {
    const secret = process.env[name]?.trim();
    if (secret !== undefined && secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

function compactError(result) {
  const detail = redactSecrets(
    (result.stderr || result.stdout || "child process produced no diagnostic").trim(),
  );
  const clipped = detail.length > 1_000 ? `${detail.slice(0, 1_000)}...` : detail;
  if (result.error) return redactSecrets(result.error.message);
  if (result.status === null) return `child process did not exit normally${result.signal ? ` (${result.signal})` : ""}`;
  return `exit ${result.status}: ${clipped}`;
}

function countStatus(result, status) {
  if (Number.isInteger(result?.summary?.[status])) return result.summary[status];
  const decisionStatus = status === "rejected" ? "reject" : status;
  return Array.isArray(result?.decisions)
    ? result.decisions.filter((decision) => decision.status === decisionStatus).length
    : 0;
}

function runCase(options, inputPath) {
  const started = performance.now();
  const child = spawnSync(process.execPath, childArgs(options, inputPath), {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const elapsedMs = performance.now() - started;
  if (child.error || child.status !== 0) {
    return { ok: false, elapsedMs, error: compactError(child) };
  }
  let result;
  try {
    result = JSON.parse(child.stdout);
  } catch (error) {
    return {
      ok: false,
      elapsedMs,
      error: `CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, elapsedMs, error: "CLI returned a JSON value instead of a result object" };
  }
  return {
    ok: true,
    elapsedMs,
    result,
    selectedIds: Array.isArray(result.selected) ? result.selected : [],
    selected: Array.isArray(result.selected) ? result.selected.length : 0,
    review: countStatus(result, "review"),
    rejected: countStatus(result, "rejected"),
    inputTokens: Number(result.usage?.input_tokens ?? 0),
    outputTokens: Number(result.usage?.output_tokens ?? 0),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = await requestFiles(options.casesDir, options.all);
  if (files.length === 0) {
    throw new Error(`No request JSON files found in ${options.casesDir}${options.all ? "" : " (default filter is case*.json; use --all to include more)"}`);
  }
  if (!(await readFile(cli).catch(() => undefined))) {
    throw new Error(`Built CLI not found at ${cli}; run npm run build first`);
  }

  console.log(`JevRev case evaluation (${options.provider})`);
  console.log(`cases: ${files.length} | source: ${options.casesDir}`);
  let passed = 0;
  let failed = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalElapsed = 0;

  for (const inputPath of files) {
    const name = basename(inputPath);
    const execution = runCase(options, inputPath);
    totalElapsed += execution.elapsedMs;
    if (!execution.ok) {
      failed += 1;
      console.log(`FAIL ${name}: ${execution.error}`);
      continue;
    }
    passed += 1;
    totalInput += execution.inputTokens;
    totalOutput += execution.outputTokens;
    console.log(
      `OK   ${name}: selected=${execution.selectedIds.join(",") || "-"} ` +
        `review=${execution.review} rejected=${execution.rejected} ` +
        `next=${execution.result.next_action ?? "-"}/${execution.result.empty_reason ?? "-"} ` +
        `tokens=${execution.inputTokens}+${execution.outputTokens} wall=${Math.round(execution.elapsedMs)}ms`,
    );
  }

  console.log(
    `Summary: ${passed}/${files.length} passed; failed=${failed}; ` +
      `tokens=${totalInput}+${totalOutput} (${totalInput + totalOutput} total); ` +
      `wall=${Math.round(totalElapsed)}ms`,
  );
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`eval-cases: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
