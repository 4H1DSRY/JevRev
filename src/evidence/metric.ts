import { InputError, ProtocolError } from "../domain/errors.js";
import { summarizeMetric } from "../workflow/evidence.js";
import type { MetricObservation } from "../workflow/schemas.js";
import {
  appendUnique,
  evidencePacket,
  readEvidenceBundle,
  writeEvidenceBundle,
} from "./store.js";

export type EvidenceResultStatus = "pass" | "fail" | "unknown";

export interface RecordMetricOptions {
  evidencePath: string;
  candidateId: string;
  metric: MetricObservation;
  resultStatus?: EvidenceResultStatus;
  replace?: boolean;
  probeIds?: readonly string[];
  requirementRefs?: readonly string[];
}

function requirementReference(reference: string): {
  kind: "success" | "constraint";
  criterionId: string;
} {
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const criterionId = reference.slice(separator + 1);
  if ((kind !== "success" && kind !== "constraint") || criterionId.length === 0) {
    throw new InputError(`Requirement must be success:<id> or constraint:<id>: ${reference}`);
  }
  return { kind, criterionId };
}

export async function recordMetric(options: RecordMetricOptions) {
  const links = [...(options.probeIds ?? []), ...(options.requirementRefs ?? [])];
  if (links.length > 0 && options.resultStatus === undefined) {
    throw new InputError("--result pass|fail|unknown is required when linking a metric");
  }
  const { path, bundle } = await readEvidenceBundle(options.evidencePath);
  const packet = evidencePacket(bundle, options.candidateId);
  const existingIndex = packet.metrics.findIndex((metric) => metric.id === options.metric.id);
  if (existingIndex >= 0 && !options.replace) {
    throw new ProtocolError(`Metric already exists: ${options.metric.id}; pass --replace to overwrite it`);
  }
  if (existingIndex >= 0) packet.metrics[existingIndex] = options.metric;
  else packet.metrics.push(options.metric);

  for (const probeId of options.probeIds ?? []) {
    const probe = packet.probe_results.find((result) => result.evidence_id === probeId);
    if (probe === undefined) throw new ProtocolError(`Unknown probe evidence ID: ${probeId}`);
    appendUnique(probe.metric_ids, options.metric.id);
    probe.status = options.resultStatus!;
  }
  for (const reference of options.requirementRefs ?? []) {
    const { kind, criterionId } = requirementReference(reference);
    if (criterionId !== options.metric.criterion_id) {
      throw new ProtocolError(
        `Metric ${options.metric.id} measures ${options.metric.criterion_id}, not ${criterionId}`,
      );
    }
    const requirement = packet.requirement_results.find(
      (result) => result.kind === kind && result.criterion_id === criterionId,
    );
    if (requirement === undefined) throw new ProtocolError(`Unknown requirement: ${reference}`);
    appendUnique(requirement.metric_ids, options.metric.id);
    requirement.status = options.resultStatus!;
  }
  packet.known_failures = packet.known_failures.filter(
    (failure) => !failure.startsWith("TEMPLATE:"),
  );
  await writeEvidenceBundle(path, bundle);
  return summarizeMetric(options.metric);
}
