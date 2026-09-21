import type { DecisionReason, RankResult } from "./domain/schemas.js";

const REASON_LABELS: Record<DecisionReason["code"], string> = {
  GOAL_MISMATCH: "weak goal fit",
  CONSTRAINT_RISK: "hard-constraint risk",
  LOW_FEASIBILITY: "low feasibility",
  WEAK_VALIDATION: "weak validation plan",
  LOW_EXECUTION_VALUE: "not worth an implementation slot",
  LOW_CONFIDENCE: "uncertain; needs review",
  DUPLICATE_CANDIDATE: "duplicates another survivor",
  BUDGET_CUTOFF: "outside implementation budget",
};

function reasonLabel(reason: DecisionReason): string {
  const label = REASON_LABELS[reason.code];
  return reason.related_candidate_id === undefined
    ? label
    : `${label} (${reason.related_candidate_id})`;
}

export function renderHuman(result: RankResult): string {
  const lines = [
    `JevRev ${result.run_id} | ${result.model}`,
    `Kept ${result.summary.kept}/${result.summary.evaluated} | shortlist ${result.summary.shortlisted} | review ${result.summary.review} | rejected ${result.summary.rejected}`,
    "",
  ];

  for (const decision of result.decisions) {
    const marker =
      decision.status === "keep" ? "+" : decision.status === "review" ? "?" : "x";
    lines.push(
      `${marker} #${decision.rank} ${decision.candidate_id} - ${decision.title}`,
      `  ${decision.status} | score ${decision.score.toFixed(3)} | confidence ${decision.confidence.toFixed(3)}`,
      `  goal ${decision.signals.goal_fit.toFixed(2)} | constraints ${decision.signals.constraint_fit.toFixed(2)} | feasibility ${decision.signals.feasibility.toFixed(2)} | validation ${decision.signals.validation_quality.toFixed(2)} | value ${decision.signals.execution_value.toFixed(2)}`,
    );
    if (decision.reasons.length > 0) {
      lines.push(`  reason: ${decision.reasons.map(reasonLabel).join("; ")}`);
    }
    lines.push("");
  }

  lines.push(
    result.selected.length > 0
      ? `Implement next: ${result.selected.join(", ")}`
      : "No candidate cleared the current policy.",
    result.shortlist.some((id) => !result.selected.includes(id))
      ? `Review before implementation: ${result.shortlist.filter((id) => !result.selected.includes(id)).join(", ")}`
      : "",
  );

  return lines.join("\n");
}

export function renderJson(result: RankResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
