import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { InputError, ProtocolError } from "../domain/errors.js";
import type { EvidenceBundle } from "../workflow/schemas.js";
import {
  appendUnique,
  evidencePacket,
  readEvidenceBundle,
  writeEvidenceBundle,
} from "./store.js";

export interface RecordCommandOptions {
  evidencePath: string;
  candidateId: string;
  observationId: string;
  argv: readonly string[];
  workspace?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  optional?: boolean;
  complete?: boolean;
  replace?: boolean;
  probeIds?: readonly string[];
  requirementRefs?: readonly string[];
  echo?: boolean;
}

export interface RecordedCommand {
  candidate_id: string;
  observation_id: string;
  exit_code: number;
  duration_ms: number;
  termination: "exited" | "timed_out" | "spawn_error" | "buffer_exceeded";
  stdout_bytes: number;
  stderr_bytes: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SECRET_ENVIRONMENT_NAMES = new Set([
  "JEVREV_JEV_API_KEY",
  "TYPESAFE_API_KEY",
]);

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SECRET_ENVIRONMENT_NAMES.has(name)),
  );
}

async function safeWorkingDirectory(
  workspaceInput: string,
  cwdInput: string,
): Promise<{ absolute: string; relative: string }> {
  const workspace = await realpath(resolve(workspaceInput));
  const cwd = await realpath(resolve(workspace, cwdInput));
  const pathFromWorkspace = relative(workspace, cwd);
  if (pathFromWorkspace === "") return { absolute: cwd, relative: "." };
  if (pathFromWorkspace.startsWith("..") || isAbsolute(pathFromWorkspace)) {
    throw new InputError(`Evidence command cwd escapes workspace: ${cwdInput}`);
  }
  return { absolute: cwd, relative: pathFromWorkspace.replaceAll("\\", "/") };
}

function linkProbe(
  bundle: EvidenceBundle,
  candidateId: string,
  observationId: string,
  probeId: string,
  passed: boolean,
): void {
  const packet = evidencePacket(bundle, candidateId);
  const probe = packet.probe_results.find((item) => item.evidence_id === probeId);
  if (probe === undefined) throw new ProtocolError(`Unknown probe evidence ID: ${probeId}`);
  appendUnique(probe.observation_ids, observationId);
  probe.status = passed ? "pass" : "fail";
}

function linkRequirement(
  bundle: EvidenceBundle,
  candidateId: string,
  observationId: string,
  reference: string,
  passed: boolean,
): void {
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const criterionId = reference.slice(separator + 1);
  if ((kind !== "success" && kind !== "constraint") || criterionId.length === 0) {
    throw new InputError(`Requirement must be success:<id> or constraint:<id>: ${reference}`);
  }
  const packet = evidencePacket(bundle, candidateId);
  const requirement = packet.requirement_results.find(
    (item) => item.kind === kind && item.criterion_id === criterionId,
  );
  if (requirement === undefined) throw new ProtocolError(`Unknown requirement: ${reference}`);
  appendUnique(requirement.observation_ids, observationId);
  requirement.status = passed ? "pass" : "fail";
}

export async function recordCommand(options: RecordCommandOptions): Promise<RecordedCommand> {
  if (options.argv.length === 0 || options.argv[0]?.length === 0) {
    throw new InputError("Evidence command executable cannot be empty");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new InputError("timeout must be a positive integer");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new InputError("max output bytes must be a positive integer");

  const { path: evidencePath, bundle } = await readEvidenceBundle(options.evidencePath);
  const packet = evidencePacket(bundle, options.candidateId);
  const existingIndex = packet.observations.findIndex((item) => item.id === options.observationId);
  if (existingIndex >= 0 && !options.replace) {
    throw new ProtocolError(`Observation already exists: ${options.observationId}; pass --replace to overwrite it`);
  }

  const cwd = await safeWorkingDirectory(options.workspace ?? process.cwd(), options.cwd ?? ".");
  const started = performance.now();
  const child = spawnSync(options.argv[0]!, [...options.argv.slice(1)], {
    cwd: cwd.absolute,
    env: childEnvironment(),
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    encoding: "buffer",
  });
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const stdout = Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.alloc(0);
  const errorText = child.error?.message ?? "";
  const childStderr = Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.alloc(0);
  const stderrBuffer = errorText.length === 0
    ? childStderr
    : Buffer.concat([childStderr, Buffer.from(`${childStderr.length > 0 ? "\n" : ""}${errorText}`)]);
  // Command output is hashed for evidence but is not safe to print by default.
  // Callers can opt in for interactive debugging with `echo: true`.
  if (options.echo ?? false) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderrBuffer.length > 0) process.stderr.write(stderrBuffer);
  }

  const errorCode = (child.error as NodeJS.ErrnoException | undefined)?.code;
  const termination: RecordedCommand["termination"] = errorCode === "ETIMEDOUT"
    ? "timed_out"
    : errorCode === "ENOBUFS"
      ? "buffer_exceeded"
      : child.error !== undefined
        ? "spawn_error"
        : "exited";
  const exitCode = child.status ?? (termination === "timed_out" ? 124 : 127);
  const observation = {
    id: options.observationId,
    kind: "command" as const,
    cwd: cwd.relative,
    argv: [...options.argv],
    exit_code: exitCode,
    duration_ms: durationMs,
    required: !(options.optional ?? false),
    stdout_sha256: digest(stdout),
    stderr_sha256: digest(stderrBuffer),
    termination,
    ...(child.signal === null ? {} : { signal: child.signal }),
    stdout_bytes: stdout.length,
    stderr_bytes: stderrBuffer.length,
  };
  if (existingIndex >= 0) packet.observations[existingIndex] = observation;
  else packet.observations.push(observation);
  packet.known_failures = packet.known_failures.filter(
    (failure) => !failure.startsWith("TEMPLATE:"),
  );
  packet.development.wall_ms += durationMs;
  if (options.complete) packet.development.status = "completed";

  const passed = exitCode === 0 && termination === "exited";
  for (const probeId of options.probeIds ?? []) {
    linkProbe(bundle, options.candidateId, options.observationId, probeId, passed);
  }
  for (const reference of options.requirementRefs ?? []) {
    linkRequirement(bundle, options.candidateId, options.observationId, reference, passed);
  }

  await writeEvidenceBundle(evidencePath, bundle);
  return {
    candidate_id: options.candidateId,
    observation_id: options.observationId,
    exit_code: exitCode,
    duration_ms: durationMs,
    termination,
    stdout_bytes: stdout.length,
    stderr_bytes: stderrBuffer.length,
  };
}
