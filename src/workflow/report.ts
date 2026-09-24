import type { Campaign, DecideResult } from "./schemas.js";

export function renderCampaignHuman(campaign: Campaign): string {
  const lines = [
    `JevRev campaign ${campaign.campaign_id}`,
    `Sifted ${campaign.sift.summary.evaluated} ideas into ${campaign.work_orders.length} strict probe work order(s).`,
    "",
  ];
  for (const workOrder of campaign.work_orders) {
    lines.push(
      `→ ${workOrder.candidate_id}`,
      `  hypothesis: ${workOrder.hypothesis}`,
      `  probe: ${workOrder.probe_instruction}`,
      `  budget: ${Math.round(workOrder.budget.max_wall_ms / 1_000)}s / ${workOrder.budget.max_changed_files} changed files`,
      `  evidence: ${workOrder.required_evidence
        .map(({ id, description }) => `${id}: ${description}`)
        .join("; ")}`,
      `  stop conditions: ${workOrder.stop_conditions.join("; ")}`,
      "",
    );
  }
  if (campaign.review_work_orders.length > 0) {
    lines.push(`Review probes explicitly promoted: ${campaign.review_work_orders.map((order) => order.candidate_id).join(", ")}.`);
  }
  if (campaign.work_orders.length === 0 && campaign.review_work_orders.length === 0) {
    lines.push(`No probe work orders. Next action: ${campaign.sift.next_action}.`);
  } else {
    lines.push("Run the probes in isolation, then pass an evidence bundle to `jevrev decide`.");
  }
  return lines.join("\n");
}

export function renderCampaignSummary(campaign: Campaign): string {
  const lines = [
    `JevRev ${campaign.campaign_id}: kept ${campaign.sift.selected.length}/${campaign.sift.summary.evaluated}`,
  ];
  for (const workOrder of campaign.work_orders) {
    const probe = workOrder.probe_instruction.replace(/\s+/g, " ").trim();
    lines.push(`- ${workOrder.candidate_id}: ${probe.length > 180 ? `${probe.slice(0, 177)}...` : probe}`);
  }
  if (campaign.review_work_orders.length > 0) {
    lines.push(`review: ${campaign.review_work_orders.map((order) => order.candidate_id).join(", ")}`);
  }
  lines.push(`next: ${campaign.work_orders.length > 0 ? "run bounded probes, then `jevrev decide`" : campaign.sift.next_action}`);
  return `${lines.join("\n")}\n`;
}

export function renderDecideHuman(result: DecideResult): string {
  const lines = [
    `JevRev decision ${result.campaign_id}`,
    `Outcome: ${result.decision}`,
    "",
  ];
  for (const evaluation of result.evaluations) {
    const marker = evaluation.status === "eligible" ? "+" : evaluation.status === "review" ? "?" : "x";
    lines.push(
      `${marker} ${evaluation.candidate_id} — ${evaluation.status}`,
      `  score: ${evaluation.score === null ? "n/a" : evaluation.score.toFixed(3)} | confidence: ${evaluation.confidence === null ? "n/a" : evaluation.confidence.toFixed(3)}`,
    );
    for (const metric of evaluation.objective.metrics) {
      lines.push(
        `  ${metric.metric_id}: ${metric.baseline_mean} → ${metric.candidate_mean} ${metric.unit} (${metric.relative_improvement === null ? "n/a" : `${(metric.relative_improvement * 100).toFixed(1)}%`} improvement)`,
      );
    }
    if (evaluation.reasons.length > 0) lines.push(`  reasons: ${evaluation.reasons.join(", ")}`);
    lines.push("");
  }
  if (result.winner !== null) lines.push(`Winner: ${result.winner}`);
  if (result.merge_candidates.length > 0) {
    lines.push(`Combined probe: ${result.merge_candidates.join(" + ")}`);
  }
  lines.push(
    `Next: ${result.next_action.type}${result.next_action.candidate_ids.length > 0 ? ` (${result.next_action.candidate_ids.join(", ")})` : ""}`,
  );
  return lines.join("\n");
}

export function renderWorkflowJson(value: Campaign | DecideResult): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
