#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { env, stdin as input, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { ZodError } from "zod";
import { InputError, ProtocolError, ProviderError } from "./domain/errors.js";
import { rankRequestSchema, type RankRequest } from "./domain/schemas.js";
import {
  DEFAULT_JEV_URL,
  LocalJudge,
  ReplayJudge,
  SemIfJudge,
  TypeSafeJudge,
} from "./judge.js";
import { rankCandidates } from "./policy.js";
import { buildQuestionPlan } from "./questions.js";
import { renderHuman, renderJson } from "./report.js";
import { buildCampaign } from "./workflow/campaign.js";
import { decideCampaign } from "./workflow/decide.js";
import { buildDecidePlan } from "./workflow/decide-questions.js";
import { prepareDecision } from "./workflow/evidence.js";
import { campaignSchema, evidenceBundleSchema } from "./workflow/schemas.js";
import { renderCampaignHuman, renderDecideHuman, renderWorkflowJson } from "./workflow/report.js";

type Provider = "jev" | "typesafe" | "local" | "semif";
type OutputFormat = "human" | "json";

const DEFAULT_SEMIF_URL = "http://127.0.0.1:4878";
const DEFAULT_LOCAL_URL = "http://127.0.0.1:4877";
const VERSION = "0.2.0";

interface RankOptions {
  input: string;
  replay?: string;
  format: OutputFormat;
  model: string;
  provider: Provider | string;
  jevUrl?: string;
  localUrl?: string;
  semifUrl?: string;
  semifModel?: string;
  output?: string;
  top?: number;
}

interface DoctorOptions {
  format: OutputFormat;
  provider: Provider | string;
  check: boolean;
  jevUrl: string;
  localUrl: string;
  semifUrl: string;
}

interface DecideOptions {
  campaign: string;
  evidence: string;
  replay?: string;
  format: OutputFormat;
  model: string;
  provider: Provider | string;
  jevUrl?: string;
  localUrl?: string;
  semifUrl?: string;
  semifModel?: string;
  output?: string;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  input.setEncoding("utf8");
  let content = "";
  for await (const chunk of input) content += chunk;
  return content;
}

async function readJson(path: string): Promise<unknown> {
  let content: string;
  try {
    content = path === "-" ? await readStdin() : await readFile(path, "utf8");
  } catch (error) {
    throw new InputError(`Could not read ${path}`, { cause: error });
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new InputError(`Could not parse JSON from ${path}`, { cause: error });
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new InvalidArgumentError("must be an integer from 1 to 5");
  }
  return parsed;
}

function parseProvider(value: string): Provider {
  if (value === "jev" || value === "typesafe" || value === "local" || value === "semif") {
    return value;
  }
  throw new InvalidArgumentError("must be jev, semif, or local (typesafe is a compatibility alias)");
}

function normalizedProvider(provider: Provider): Exclude<Provider, "typesafe"> {
  return provider === "typesafe" ? "jev" : provider;
}

function requireJevApiKey(provider: Exclude<Provider, "typesafe">): string | undefined {
  const key = envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY");
  if (provider === "jev" && key === undefined) {
    throw new ProviderError(
      "Missing Jev API key. Set JEVREV_JEV_API_KEY (or TYPESAFE_API_KEY), or use --provider semif/local.",
    );
  }
  return key;
}

function validateFormat(format: string): asserts format is OutputFormat {
  if (format !== "human" && format !== "json") {
    throw new InputError("--format must be human or json");
  }
}

async function emit(rendered: string, outputPath: string | undefined): Promise<void> {
  if (outputPath === undefined) {
    stdout.write(rendered);
    return;
  }
  try {
    await writeFile(outputPath, rendered, "utf8");
  } catch (error) {
    throw new InputError(`Could not write ${outputPath}`, { cause: error });
  }
}

async function evaluateRank(options: RankOptions) {
  const rawRequest = await readJson(options.input);
  let request: RankRequest;
  try {
    request = rankRequestSchema.parse(rawRequest);
    if (options.top !== undefined) {
      request = rankRequestSchema.parse({
        ...request,
        budget: { max_survivors: options.top },
      });
    }
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InputError(`Invalid rank request: ${error.message}`, { cause: error });
    }
    throw error;
  }

  const plan = buildQuestionPlan(request, { canonicalize: options.replay === undefined });
  const provider = normalizedProvider(parseProvider(String(options.provider)));
  const jevApiKey = options.replay === undefined ? requireJevApiKey(provider) : undefined;
  const judge =
    options.replay === undefined
      ? provider === "local"
        ? new LocalJudge(
            options.localUrl === undefined ? {} : { baseUrl: options.localUrl },
          )
        : provider === "semif"
          ? new SemIfJudge({
              ...(options.semifUrl ?? options.localUrl
                ? { baseUrl: options.semifUrl ?? options.localUrl }
                : {}),
              ...(options.semifModel === undefined ? {} : { model: options.semifModel }),
            })
          : new TypeSafeJudge({
              model: options.model,
              ...(jevApiKey === undefined ? {} : { apiKey: jevApiKey }),
              ...(options.jevUrl === undefined ? {} : { baseUrl: options.jevUrl }),
            })
      : new ReplayJudge(await readJson(options.replay));
  const response = await judge.evaluate(plan);
  const providerProfile = options.replay === undefined
    ? `${provider}/${response.model}`
    : "replay";
  const result = rankCandidates(request, response, plan.candidateOrder, { providerProfile });
  return { request, result };
}

async function runRank(options: RankOptions): Promise<void> {
  const { result } = await evaluateRank(options);
  await emit(options.format === "json" ? renderJson(result) : `${renderHuman(result)}\n`, options.output);
}

async function runSift(options: RankOptions): Promise<void> {
  const { request, result } = await evaluateRank(options);
  const campaign = buildCampaign(request, result);
  await emit(
    options.format === "json"
      ? renderWorkflowJson(campaign)
      : `${renderCampaignHuman(campaign)}\n`,
    options.output,
  );
}

async function runDecide(options: DecideOptions): Promise<void> {
  const rawCampaign = await readJson(options.campaign);
  const rawEvidence = await readJson(options.evidence);
  let campaign;
  let bundle;
  try {
    campaign = campaignSchema.parse(rawCampaign);
    bundle = evidenceBundleSchema.parse(rawEvidence);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InputError(`Invalid decide input: ${error.message}`, { cause: error });
    }
    throw error;
  }

  const prepared = prepareDecision(campaign, bundle);
  let response;
  let candidateOrder: readonly number[] = [];
  let providerProfile = "deterministic/no-viable-finalists";
  if (prepared.viable.length > 0) {
    const plan = buildDecidePlan(prepared, { canonicalize: options.replay === undefined });
    candidateOrder = plan.candidateOrder;
    const provider = normalizedProvider(parseProvider(String(options.provider)));
    const jevApiKey = options.replay === undefined ? requireJevApiKey(provider) : undefined;
    const judge = options.replay === undefined
      ? provider === "local"
        ? new LocalJudge(options.localUrl === undefined ? {} : { baseUrl: options.localUrl })
        : provider === "semif"
          ? new SemIfJudge({
              ...(options.semifUrl ?? options.localUrl
                ? { baseUrl: options.semifUrl ?? options.localUrl }
                : {}),
              ...(options.semifModel === undefined ? {} : { model: options.semifModel }),
            })
          : new TypeSafeJudge({
              model: options.model,
              ...(jevApiKey === undefined ? {} : { apiKey: jevApiKey }),
              ...(options.jevUrl === undefined ? {} : { baseUrl: options.jevUrl }),
            })
      : new ReplayJudge(await readJson(options.replay));
    response = await judge.evaluate(plan);
    providerProfile = options.replay === undefined ? `${provider}/${response.model}` : "replay";
  }

  const result = decideCampaign(prepared, response, candidateOrder, { providerProfile });
  await emit(
    options.format === "json" ? renderWorkflowJson(result) : `${renderDecideHuman(result)}\n`,
    options.output,
  );
}

function validatedHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new InputError(`Invalid ${label} URL: ${value}`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InputError(`${label} URL must use http or https`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function endpoint(baseUrl: string, path: string, label: string): string {
  return `${validatedHttpUrl(baseUrl, label)}${path}`;
}

function versionedEndpoint(baseUrl: string, path: string, label: string): string {
  const normalized = validatedHttpUrl(baseUrl, label);
  const versionRoot = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  return `${versionRoot}/${path.replace(/^\/+/, "")}`;
}

function serviceHealthEndpoint(baseUrl: string, label: string): string {
  const normalized = validatedHttpUrl(baseUrl, label);
  const serviceRoot = normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
  return `${serviceRoot}/health`;
}

function doctorHuman(data: Record<string, unknown>): string {
  const endpoints = data.endpoints as Record<string, Record<string, unknown>>;
  const lines = [
    `JevRev ${VERSION}`,
    `provider: ${String(data.provider)}`,
    "",
    "Configured endpoints:",
  ];
  for (const [name, value] of Object.entries(endpoints)) {
    lines.push(`- ${name}: ${String(value.request_url)} (${String(value.state)})`);
  }
  const credentials = data.credentials as { configured: boolean };
  lines.push(
    "",
    `Jev credentials: ${credentials.configured ? "configured" : "not configured"}`,
    "Credential names: JEVREV_JEV_API_KEY or TYPESAFE_API_KEY (never passed on the command line).",
  );
  return `${lines.join("\n")}\n`;
}

async function checkEndpoint(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return `${response.status} ${response.statusText}`.trim();
  } catch (error) {
    return error instanceof Error ? `unreachable: ${error.message}` : "unreachable";
  }
}

async function runDoctor(options: DoctorOptions): Promise<void> {
  const data: Record<string, unknown> = {
    product: "JevRev",
    version: VERSION,
    provider: normalizedProvider(parseProvider(String(options.provider))),
    credentials: { configured: envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY") !== undefined },
    endpoints: {
      jev: {
        base_url: options.jevUrl,
        request_url: endpoint(options.jevUrl, "/v1/systemone", "Jev"),
        state: options.check ? "configured; use `run` for an authenticated request" : "not_checked",
      },
      semif: {
        base_url: options.semifUrl,
        request_url: versionedEndpoint(options.semifUrl, "chat/completions", "SemIf"),
        state: options.check ? await checkEndpoint(serviceHealthEndpoint(options.semifUrl, "SemIf")) : "not_checked",
      },
      local: {
        base_url: options.localUrl,
        request_url: versionedEndpoint(options.localUrl, "score", "local scorer"),
        state: options.check ? await checkEndpoint(serviceHealthEndpoint(options.localUrl, "local scorer")) : "not_checked",
      },
    },
  };
  await emit(options.format === "json" ? `${JSON.stringify(data, null, 2)}\n` : doctorHuman(data), undefined);
}

function addRankCommand(program: Command, name: "run" | "rank" | "sift"): void {
  const defaultFormat: OutputFormat = name === "rank" ? "human" : "json";
  program
    .command(name)
    .description(
      name === "sift"
        ? "Sift candidate approaches and emit bounded probe work orders"
        : name === "run"
        ? "Evaluate candidate approaches and return an implementation shortlist"
        : "Compatibility alias for run",
    )
    .requiredOption("-i, --input <path>", "request JSON path, or - for stdin")
    .option("--replay <path>", "use a captured Jev response instead of a live provider")
    .option("--format <format>", "human or json", defaultFormat)
    .option(
      "--provider <provider>",
      "jev, semif, or local (typesafe is a compatibility alias)",
      envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev",
    )
    .option(
      "--jev-url <url>",
      "Jev API root; request is POST /v1/systemone",
      envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL"),
    )
    .option(
      "--local-url <url>",
      "legacy local reranker base URL",
      envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL"),
    )
    .option(
      "--semif-url <url>",
      "local SemIf llama.cpp base URL",
      envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL"),
    )
    .option(
      "--semif-model <model>",
      "SemIf model identifier",
      envValue("JEVREV_SEMIF_MODEL", "SPECJEV_SEMIF_MODEL"),
    )
    .option(
      "--model <model>",
      "Jev model",
      envValue("JEVREV_JEV_MODEL", "TYPESAFE_DEFAULT_MODEL") ?? "jev-latest",
    )
    .option("--top <count>", "override max survivors", parsePositiveInteger)
    .option("-o, --output <path>", "write the rendered result to a file")
    .action(async (rawOptions: RankOptions) => {
      validateFormat(rawOptions.format);
      if (name === "sift") await runSift(rawOptions);
      else await runRank(rawOptions);
    });
}

function createProgram(): Command {
  const program = new Command()
    .name("jevrev")
    .description("Explore candidate approaches, prune them with Jev, and return the few worth executing")
    .version(VERSION)
    .exitOverride()
    .showHelpAfterError();

  addRankCommand(program, "run");
  addRankCommand(program, "rank");
  addRankCommand(program, "sift");

  program
    .command("decide")
    .description("Choose from probed finalists using deterministic evidence and Jev")
    .requiredOption("--campaign <path>", "campaign JSON emitted by `jevrev sift`")
    .requiredOption("--evidence <path>", "evidence bundle JSON")
    .option("--replay <path>", "use a captured decide response instead of a live provider")
    .option("--format <format>", "human or json", "json")
    .option(
      "--provider <provider>",
      "jev, semif, or local (typesafe is a compatibility alias)",
      envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev",
    )
    .option("--jev-url <url>", "Jev API root", envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL"))
    .option("--local-url <url>", "legacy local reranker base URL", envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL"))
    .option("--semif-url <url>", "local SemIf llama.cpp base URL", envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL"))
    .option("--semif-model <model>", "SemIf model identifier", envValue("JEVREV_SEMIF_MODEL", "SPECJEV_SEMIF_MODEL"))
    .option("--model <model>", "Jev model", envValue("JEVREV_JEV_MODEL", "TYPESAFE_DEFAULT_MODEL") ?? "jev-latest")
    .option("-o, --output <path>", "write the rendered result to a file")
    .action(async (rawOptions: DecideOptions) => {
      validateFormat(rawOptions.format);
      await runDecide(rawOptions);
    });

  program
    .command("doctor")
    .description("Show provider endpoints and optionally probe local services")
    .option("--format <format>", "human or json", "human")
    .option(
      "--provider <provider>",
      "jev, semif, or local",
      envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev",
    )
    .option(
      "--jev-url <url>",
      "Jev API root",
      envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL") ?? DEFAULT_JEV_URL,
    )
    .option(
      "--semif-url <url>",
      "local SemIf base URL",
      envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL") ?? DEFAULT_SEMIF_URL,
    )
    .option(
      "--local-url <url>",
      "legacy local reranker base URL",
      envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL") ?? DEFAULT_LOCAL_URL,
    )
    .option("--check", "probe the local health endpoints")
    .action(async (rawOptions: DoctorOptions) => {
      validateFormat(rawOptions.format);
      await runDoctor(rawOptions);
    });

  return program;
}

export async function main(argv = process.argv): Promise<number> {
  try {
    await createProgram().parseAsync(argv);
    return 0;
  } catch (error) {
    const label = "jevrev";
    if (error instanceof InvalidArgumentError) {
      stderr.write(`${label}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      return 2;
    }
    if (error instanceof InputError) {
      stderr.write(`${label}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof ProviderError) {
      stderr.write(`${label}: provider error: ${error.message}\n`);
      return 3;
    }
    if (error instanceof ProtocolError) {
      stderr.write(`${label}: protocol error: ${error.message}\n`);
      return 4;
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: unexpected error: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await main();
}
