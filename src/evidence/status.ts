import { resolve } from "node:path";
import { InputError } from "../domain/errors.js";
import { prepareDecision } from "../workflow/evidence.js";
import { campaignSchema, type Campaign } from "../workflow/schemas.js";
import { readEvidenceBundle } from "./store.js";
import { readJsonFile } from "../io/json.js";
import { formatZodError } from "../io/validation.js";

export interface EvidenceStatusResult {
  kind: "jevrev.evidence-status";
  schema_version: "1";
  campaign_id: string;
  summary: { ready: number; incomplete: number; rejected: number };
  candidates: Array<{
    candidate_id: string;
    state: "ready" | "incomplete" | "rejected";
    development: string;
    observations: number;
    metrics: number;
    artifacts: number;
    requirements: Array<{
      id: string;
      kind: "success" | "constraint";
      status: "pass" | "fail" | "unknown";
      evidence_count: number;
    }>;
    probes: Array<{
      id: string;
      description: string;
      status: "pass" | "fail" | "unknown";
      evidence_count: number;
    }>;
    reasons: string[];
    next_action: "ready_for_decide" | "collect_evidence" | "revise_or_stop";
  }>;
}

export interface EvidenceNextResult {
  kind: "jevrev.evidence-next";
  schema_version: "1";
  campaign_id: string;
  candidate_id: string | null;
  action: "collect_evidence" | "ready_for_decide" | "revise_or_stop";
  item: { kind: "requirement" | "probe"; id: string; description: string } | null;
}

async function readCampaign(pathInput: string): Promise<Campaign> {
  const path = resolve(pathInput);
  try {
    const parsed = campaignSchema.safeParse(await readJsonFile(path));
    if (!parsed.success) throw new InputError(`Invalid campaign: ${formatZodError(parsed.error)}`);
    return parsed.data;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`Could not read campaign: ${path}`, { cause: error });
  }
}

export async function evidenceStatus(
  campaignPath: string,
  evidencePath: string,
): Promise<EvidenceStatusResult> {
  const [campaign, evidence] = await Promise.all([
    readCampaign(campaignPath),
    readEvidenceBundle(evidencePath),
  ]);
  const prepared = prepareDecision(campaign, evidence.bundle);
  const candidates = [...campaign.work_orders, ...campaign.review_work_orders].map((workOrder) => {
    const evaluation = prepared.evaluations.find(
      (item) => item.candidate_id === workOrder.candidate_id,
    )!;
    const packet = evidence.bundle.packets.find(
      (item) => item.candidate_id === workOrder.candidate_id,
    );
    const requirements = [
      ...campaign.request.task.success.map((criterion) => ({
        id: criterion.id,
        kind: "success" as const,
      })),
      ...campaign.request.task.constraints
        .filter((constraint) => constraint.kind === "hard")
        .map((constraint) => ({ id: constraint.id, kind: "constraint" as const })),
    ].map((required) => {
      const result = packet?.requirement_results.find(
        (item) => item.kind === required.kind && item.criterion_id === required.id,
      );
      return {
        ...required,
        status: result?.status ?? "unknown" as const,
        evidence_count: (result?.observation_ids.length ?? 0) +
          (result?.metric_ids.length ?? 0) +
          (result?.artifact_evaluation_ids?.length ?? 0),
      };
    });
    const probes = workOrder.required_evidence.map((required) => {
      const result = packet?.probe_results.find((item) => item.evidence_id === required.id);
      return {
        id: required.id,
        description: required.description,
        status: result?.status ?? "unknown" as const,
        evidence_count: (result?.observation_ids.length ?? 0) +
          (result?.metric_ids.length ?? 0) +
          (result?.artifact_evaluation_ids?.length ?? 0),
      };
    });
    const state = evaluation.status === "viable"
      ? "ready" as const
      : evaluation.status === "incomplete"
        ? "incomplete" as const
        : "rejected" as const;
    return {
      candidate_id: workOrder.candidate_id,
      state,
      development: packet?.development.status ?? "missing",
      observations: packet?.observations.length ?? 0,
      metrics: packet?.metrics.length ?? 0,
      artifacts: packet?.artifacts?.length ?? 0,
      requirements,
      probes,
      reasons: evaluation.reasons,
      next_action: state === "ready"
        ? "ready_for_decide" as const
        : state === "incomplete"
          ? "collect_evidence" as const
          : "revise_or_stop" as const,
    };
  });
  return {
    kind: "jevrev.evidence-status",
    schema_version: "1",
    campaign_id: campaign.campaign_id,
    summary: {
      ready: candidates.filter((candidate) => candidate.state === "ready").length,
      incomplete: candidates.filter((candidate) => candidate.state === "incomplete").length,
      rejected: candidates.filter((candidate) => candidate.state === "rejected").length,
    },
    candidates,
  };
}

export function renderEvidenceStatus(result: EvidenceStatusResult): string {
  const lines = [
    `JevRev evidence ${result.campaign_id}`,
    `Ready ${result.summary.ready} | incomplete ${result.summary.incomplete} | rejected ${result.summary.rejected}`,
    "",
  ];
  for (const candidate of result.candidates) {
    const marker = candidate.state === "ready" ? "+" : candidate.state === "incomplete" ? "?" : "x";
    lines.push(
      `${marker} ${candidate.candidate_id} — ${candidate.state} (${candidate.development})`,
      `  recorded: ${candidate.observations} command(s), ${candidate.metrics} metric(s), ${candidate.artifacts} artifact(s)`,
    );
    for (const requirement of candidate.requirements) {
      lines.push(`  ${requirement.status === "pass" ? "✓" : requirement.status === "fail" ? "×" : "?"} ${requirement.kind}:${requirement.id} — ${requirement.status} (${requirement.evidence_count} evidence)`);
    }
    for (const probe of candidate.probes) {
      lines.push(`  ${probe.status === "pass" ? "✓" : probe.status === "fail" ? "×" : "?"} ${probe.id} — ${probe.status}: ${probe.description}`);
    }
    if (candidate.reasons.length > 0) lines.push(`  reasons: ${candidate.reasons.join(", ")}`);
    lines.push(`  next: ${candidate.next_action}`, "");
  }
  return lines.join("\n");
}

export function evidenceNext(result: EvidenceStatusResult): EvidenceNextResult {
  const candidate = result.candidates.find((item) => item.state === "incomplete")
    ?? result.candidates.find((item) => item.state === "ready")
    ?? result.candidates[0];
  if (candidate === undefined) {
    return { kind: "jevrev.evidence-next", schema_version: "1", campaign_id: result.campaign_id, candidate_id: null, action: "ready_for_decide", item: null };
  }
  if (candidate.state === "ready") {
    return { kind: "jevrev.evidence-next", schema_version: "1", campaign_id: result.campaign_id, candidate_id: candidate.candidate_id, action: "ready_for_decide", item: null };
  }
  if (candidate.state === "rejected") {
    return { kind: "jevrev.evidence-next", schema_version: "1", campaign_id: result.campaign_id, candidate_id: candidate.candidate_id, action: "revise_or_stop", item: null };
  }
  const missingRequirement = candidate.requirements.find((item) => item.status === "unknown");
  if (missingRequirement !== undefined) {
    return {
      kind: "jevrev.evidence-next", schema_version: "1", campaign_id: result.campaign_id,
      candidate_id: candidate.candidate_id, action: "collect_evidence",
      item: { kind: "requirement", id: `${missingRequirement.kind}:${missingRequirement.id}`, description: `Record evidence for ${missingRequirement.kind}:${missingRequirement.id}` },
    };
  }
  const missingProbe = candidate.probes.find((item) => item.status === "unknown");
  return missingProbe === undefined
    ? { kind: "jevrev.evidence-next", schema_version: "1", campaign_id: result.campaign_id, candidate_id: candidate.candidate_id, action: "collect_evidence", item: null }
    : {
        kind: "jevrev.evidence-next", schema_version: "1", campaign_id: result.campaign_id,
        candidate_id: candidate.candidate_id, action: "collect_evidence",
        item: { kind: "probe", id: missingProbe.id, description: missingProbe.description },
      };
}

export function renderEvidenceNext(result: EvidenceNextResult): string {
  if (result.item === null) {
    return result.candidate_id === null
      ? `JevRev evidence ${result.campaign_id}\nNo finalist requires more evidence.\nNext: ${result.action}\n`
      : `JevRev evidence ${result.campaign_id}\nCandidate ${result.candidate_id}\nNext: ${result.action}\n`;
  }
  return `JevRev evidence ${result.campaign_id}\nCandidate ${result.candidate_id}\nNext ${result.item.kind}: ${result.item.id}\n${result.item.description}\n`;
}
