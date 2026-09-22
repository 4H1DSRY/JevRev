import { createHash } from "node:crypto";
import { ProtocolError } from "../domain/errors.js";
import type { RankRequest, RankResult } from "../domain/schemas.js";
import { campaignSchema, type Campaign, type WorkOrder } from "./schemas.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function campaignId(
  value: Pick<Campaign, "request" | "sift" | "work_orders"> & { review_work_orders?: Campaign["review_work_orders"] },
): string {
  return `jvc_${digest({
    request: value.request,
    sift: value.sift,
    work_orders: value.work_orders,
    ...(value.review_work_orders !== undefined && value.review_work_orders.length > 0 ? { review_work_orders: value.review_work_orders } : {}),
  }).slice(0, 12)}`;
}

function probeBudget(effort: RankRequest["candidates"][number]["effort"]): WorkOrder["budget"] {
  switch (effort) {
    case "small":
      return { max_wall_ms: 300_000, max_changed_files: 5 };
    case "medium":
      return { max_wall_ms: 600_000, max_changed_files: 8 };
    case "large":
      return { max_wall_ms: 900_000, max_changed_files: 12 };
  }
}

export function buildWorkOrder(candidate: RankRequest["candidates"][number]): WorkOrder {
  return {
    candidate_id: candidate.id,
    candidate_sha256: candidateDigest(candidate),
    hypothesis: candidate.mechanism,
    probe_instruction:
      `Build the smallest reversible probe that can falsify this mechanism: ${candidate.mechanism}`,
    required_evidence: candidate.validation.map((description, index) => ({
      id: `probe-${index + 1}`,
      description,
    })),
    budget: probeBudget(candidate.effort),
    stop_conditions: [
      "Stop when every required evidence item has a recorded result.",
      "Stop immediately if a hard constraint is violated.",
      "Stop when the work-order time or changed-file budget is exhausted.",
    ],
  };
}

export function candidateDigest(
  candidate: RankRequest["candidates"][number],
): string {
  return digest(candidate);
}

export function buildCampaign(request: RankRequest, sift: RankResult): Campaign {
  const candidates = new Map(request.candidates.map((candidate) => [candidate.id, candidate]));
  const workOrders = sift.selected.map((candidateId): WorkOrder => {
    const candidate = candidates.get(candidateId);
    if (candidate === undefined) {
      throw new ProtocolError(`Sift selected unknown candidate: ${candidateId}`);
    }
    return buildWorkOrder(candidate);
  });

  const payload = {
    request,
    sift,
    work_orders: workOrders,
  };
  return campaignSchema.parse({
    kind: "jevrev.campaign",
    schema_version: "1",
    campaign_id: campaignId(payload),
    ...payload,
    review_work_orders: [],
  });
}
