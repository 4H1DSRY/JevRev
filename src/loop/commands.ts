import { readFile } from "node:fs/promises";
import { InputError, ProviderError } from "../domain/errors.js";
import { LocalJudge, ReplayJudge, SemIfJudge, TypeSafeJudge, type Judge } from "../judge.js";
import { auditRound } from "./auditor.js";
import { issueNextRound } from "./planner.js";
import { loopHash, loopSpecSchema, roundEvidenceSchema, roundPlanSchema, type LoopSpec, type RoundAuditResult, type RoundEvidence, type RoundPlan } from "./schemas.js";
import { appendLoopEvent, createLoop, loadLoop, type LoadedLoop } from "./store.js";

export type LoopProvider = "jev" | "local" | "semif";

export interface LoopJudgeOptions {
  provider?: LoopProvider;
  apiKey?: string;
  jevUrl?: string;
  localUrl?: string;
  semifUrl?: string;
  semifModel?: string;
  model?: string;
  replay?: unknown;
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch (error) { throw new InputError(`Could not read ${path}`, { cause: error }); }
  try { return JSON.parse(raw) as unknown; } catch (error) { throw new InputError(`Could not parse JSON from ${path}`, { cause: error }); }
}

export async function readLoopSpec(path: string): Promise<LoopSpec> {
  try { return loopSpecSchema.parse(await readJson(path)); }
  catch (error) { throw new InputError(`Invalid Loop spec: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export async function readRoundPlan(path: string): Promise<RoundPlan> {
  try { return roundPlanSchema.parse(await readJson(path)); }
  catch (error) { throw new InputError(`Invalid round plan: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export async function readRoundEvidence(path: string): Promise<RoundEvidence> {
  try { return roundEvidenceSchema.parse(await readJson(path)); }
  catch (error) { throw new InputError(`Invalid round evidence: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export function loopEvidenceTemplate(loop: LoadedLoop, headRevision: string): RoundEvidence {
  if (loop.state.active_order === null) throw new InputError(`Loop has no active round to template (status: ${loop.state.status})`);
  const order = loop.state.active_order;
  return {
    kind: "jevrev.round-evidence", schema_version: "1", loop_id: loop.state.loop_id,
    round_number: order.round_number, spec_sha256: loop.state.spec_sha256,
    work_order_sha256: loopHash(order), base_revision: order.base_revision,
    head_revision: headRevision, wall_ms: 0, provider_tokens: 0, changed_files: [],
    observations: [], metrics: [], artifact_evaluations: [],
    criterion_results: loop.spec.criteria.map((criterion) => ({
      id: criterion.id, status: "unknown" as const, freshness: "fresh" as const,
      source_round: order.round_number, head_revision: headRevision,
      observation_ids: [], metric_ids: [], artifact_evaluation_ids: [],
    })),
    protected_surface_results: loop.spec.protected_surfaces.map((surface) => ({
      id: surface.id, status: "unknown" as const, freshness: "fresh" as const,
      source_round: order.round_number, head_revision: headRevision,
      observation_ids: [], metric_ids: [], artifact_evaluation_ids: [],
    })),
    known_failures: [],
  };
}

export async function createLoopCommand(directory: string, spec: LoopSpec, baseRevision: string): Promise<LoadedLoop> {
  return createLoop(directory, spec, baseRevision);
}

export async function nextLoopCommand(directory: string, plan?: RoundPlan) {
  return issueNextRound(directory, plan);
}

export function buildLoopJudge(options: LoopJudgeOptions): Judge | undefined {
  if (options.replay !== undefined) return new ReplayJudge(options.replay);
  const provider = options.provider ?? "jev";
  if (provider === "local") return new LocalJudge(options.localUrl === undefined ? {} : { baseUrl: options.localUrl });
  if (provider === "semif") return new SemIfJudge({
    ...(options.semifUrl === undefined ? {} : { baseUrl: options.semifUrl }),
    ...(options.semifModel === undefined ? {} : { model: options.semifModel }),
  });
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) throw new ProviderError("Missing Jev API key. Set JEVREV_JEV_API_KEY or use --provider local/semif.");
  return new TypeSafeJudge({ apiKey: options.apiKey, ...(options.jevUrl === undefined ? {} : { baseUrl: options.jevUrl }), ...(options.model === undefined ? {} : { model: options.model }) });
}

export async function auditLoopCommand(directory: string, evidenceInput: RoundEvidence, options: LoopJudgeOptions = {}): Promise<{ loop: LoadedLoop; result: RoundAuditResult }> {
  const loop = await loadLoop(directory);
  if (loop.state.active_order === null) throw new InputError(`Loop has no active round to audit (status: ${loop.state.status})`);
  const needsJudge = loop.spec.criteria.some((criterion) =>
    criterion.type === "judged" && (loop.state.active_order?.mode === "completion" || loop.state.active_order?.focus_criteria.includes(criterion.id)),
  );
  const judge = needsJudge ? buildLoopJudge(options) : undefined;
  const result = await auditRound(loop.spec, loop.state.active_order, evidenceInput, {
    ...(judge === undefined ? {} : { judge }),
    providerProfile: judge === undefined ? "deterministic" : options.replay === undefined ? `${options.provider ?? "jev"}/${options.model ?? "default"}` : "replay",
    previousAudit: loop.state.last_audit,
    consecutiveStalled: loop.state.consecutive_stalled,
    plateauReplans: loop.state.plateau_replans,
    cumulativeWallMs: loop.state.cumulative_wall_ms,
    cumulativeProviderTokens: loop.state.cumulative_provider_tokens,
  });
  const updated = await appendLoopEvent(directory, { type: "ROUND_AUDITED", result, evidence: evidenceInput });
  return { loop: updated, result };
}

export async function resumeLoopCommand(directory: string, approvedBy: string, reason: string): Promise<LoadedLoop> {
  return appendLoopEvent(directory, { type: "LOOP_RESUMED", approved_by: approvedBy, reason });
}

export async function abortLoopCommand(directory: string): Promise<LoadedLoop> {
  return appendLoopEvent(directory, { type: "LOOP_ABORTED" });
}

export async function approveLoopSpecCommand(directory: string, spec: LoopSpec, approvedBy: string, reason: string): Promise<LoadedLoop> {
  const loop = await loadLoop(directory);
  if (spec.revision !== loop.state.spec_revision + 1) throw new InputError(`Spec revision must be ${loop.state.spec_revision + 1}`);
  return appendLoopEvent(directory, { type: "SPEC_APPROVED", spec, approved_by: approvedBy, reason });
}

export function loopStatusData(loop: LoadedLoop): Record<string, unknown> {
  const lastAudit = loop.state.last_audit;
  const resumedFrom = loop.state.status === "ready" && loop.events.at(-1)?.payload.type === "LOOP_RESUMED"
    ? lastAudit?.outcome ?? null
    : null;
  return {
    loop_id: loop.state.loop_id,
    status: loop.state.status,
    goal: loop.spec.goal,
    spec_revision: loop.state.spec_revision,
    round: loop.state.last_round,
    head_revision: loop.state.head_revision,
    active_mode: loop.state.active_order?.mode ?? null,
    cumulative_wall_ms: loop.state.cumulative_wall_ms,
    cumulative_provider_tokens: loop.state.cumulative_provider_tokens,
    consecutive_stalled: loop.state.consecutive_stalled,
    plateau_replans: loop.state.plateau_replans,
    resumed_from: resumedFrom,
    last_outcome: lastAudit?.outcome ?? null,
    next_action: resumedFrom === null ? lastAudit?.next_action ?? null : null,
  };
}

export function renderLoopHuman(loop: LoadedLoop): string {
  const data = loopStatusData(loop);
  const lines = [
    `loop ${String(data.loop_id)}  ${String(data.status)}`,
    `goal: ${String(data.goal)}`,
    `spec: r${String(data.spec_revision)}  round: ${String(data.round)}  head: ${String(data.head_revision)}`,
    `budget: ${String(data.cumulative_wall_ms)}ms / ${String(data.cumulative_provider_tokens)} provider tokens`,
  ];
  if (data.resumed_from !== null) lines.push(`resumed after: ${String(data.resumed_from)}`);
  if (data.active_mode !== null) lines.push(`active: ${String(data.active_mode)}`);
  if (data.last_outcome !== null) lines.push(`last audit: ${String(data.last_outcome)}`);
  const action = data.next_action as { type?: string; focus_criteria?: string[] } | null;
  if (action?.type !== undefined) lines.push(`next: ${action.type}${action.focus_criteria?.length ? ` (${action.focus_criteria.join(", ")})` : ""}`);
  return `${lines.join("\n")}\n`;
}
