import { InputError, ProtocolError } from "../domain/errors.js";
import {
  loopHash, roundPlanSchema, roundWorkOrderSchema,
  type LoopSpec, type RoundPlan, type RoundWorkOrder,
} from "./schemas.js";
import { appendLoopEvent, type LoadedLoop } from "./store.js";

function expectedMode(loop: LoadedLoop): RoundWorkOrder["mode"] {
  if (loop.state.status === "completion_pending") return "completion";
  if (loop.state.last_audit?.spec_sha256 !== loop.state.spec_sha256) return "progress";
  const action = loop.state.last_audit?.next_action.type;
  return action === "fix_regression" || action === "verify" || action === "replan"
    ? action
    : "progress";
}

function requiredNextFocus(loop: LoadedLoop): readonly string[] {
  if (loop.state.last_audit?.spec_sha256 !== loop.state.spec_sha256) return [];
  return loop.state.last_audit?.next_action.focus_criteria ?? [];
}

function validateNormalPlan(loop: LoadedLoop, planInput: RoundPlan): RoundPlan {
  const plan = roundPlanSchema.parse(planInput);
  const focusTargets = new Set([
    ...loop.spec.criteria.map((criterion) => criterion.id),
    ...loop.spec.protected_surfaces.map((surface) => surface.id),
  ]);
  const protectedSurfaces = new Set(loop.spec.protected_surfaces.map((surface) => surface.id));
  if (plan.focus_criteria.some((id) => !focusTargets.has(id))) {
    throw new InputError("Round plan references an unknown focus criterion or protected surface");
  }
  if (plan.do_not_change.some((id) => !protectedSurfaces.has(id))) {
    throw new InputError("Round plan references an unknown protected surface");
  }
  const requiredFocus = requiredNextFocus(loop);
  if (requiredFocus.length > 0 && requiredFocus.some((id) => !plan.focus_criteria.includes(id))) {
    throw new InputError(`Round plan must address the previous audit focus: ${requiredFocus.join(", ")}`);
  }
  return plan;
}

function evidenceSlotId(kind: "command" | "metric" | "artifact" | "protected", criterionId: string, requirementId = "check"): string {
  return `${kind}-${criterionId.slice(0, 20)}-${loopHash([kind, criterionId, requirementId]).slice(0, 12)}`;
}

function completionPlan(spec: LoopSpec): RoundPlan {
  const evidence: RoundPlan["required_evidence"] = [];
  for (const criterion of spec.criteria) {
    if (criterion.type === "hard") {
      evidence.push(...criterion.required_commands.map((command) => ({
        // Hard-command evidence IDs are also the observation IDs required by
        // the completion gate. One recorded command may support multiple
        // criteria, so duplicate command IDs are intentionally deduplicated.
        id: command,
        description: `Fresh recorded command ${command} required for ${criterion.id}`,
        kind: "command" as const,
      })));
    } else if (criterion.type === "metric") {
      evidence.push({ id: evidenceSlotId("metric", criterion.id), description: `Fresh ${criterion.aggregation} ${criterion.unit} samples for ${criterion.id}`, kind: "metric" });
    } else {
      evidence.push(...criterion.required_artifacts.map((artifact) => ({
        id: evidenceSlotId("artifact", criterion.id, artifact),
        description: `Fresh artifact ${artifact} and evaluation required for ${criterion.id}`,
        kind: "artifact" as const,
      })));
    }
  }
  for (const surface of spec.protected_surfaces) {
    evidence.push({ id: evidenceSlotId("protected", surface.id), description: `Fresh regression check for protected surface ${surface.id}`, kind: "command" });
  }
  const requiredEvidence = [...new Map(evidence.map((item) => [`${item.kind}:${item.id}`, item])).values()];
  return roundPlanSchema.parse({
    kind: "jevrev.round-plan",
    schema_version: "1",
    round_goal: "Run the full completion audit on the current artifact",
    focus_criteria: spec.criteria.map((criterion) => criterion.id),
    hypothesis: "All frozen criteria now meet their targets on the same current revision",
    allowed_scope: [],
    do_not_change: spec.protected_surfaces.map((surface) => surface.id),
    required_evidence: requiredEvidence,
    stop_conditions: [
      "Stop and fix any failed hard command or protected-surface regression",
      "Stop and collect more evidence for any incomplete or stale criterion",
      "Stop and ask a human when a judged criterion remains low-confidence",
    ],
  });
}

export function buildRoundWorkOrder(loop: LoadedLoop, planInput?: RoundPlan): RoundWorkOrder {
  if (loop.state.status === "issued" && loop.state.active_order !== null) {
    return loop.state.active_order;
  }
  if (loop.state.status !== "ready" && loop.state.status !== "completion_pending") {
    throw new ProtocolError(`Loop cannot issue a round from ${loop.state.status}`);
  }
  const mode = expectedMode(loop);
  const plan = mode === "completion"
    ? completionPlan(loop.spec)
    : planInput === undefined
      ? (() => { throw new InputError("A round plan is required for the next progress round"); })()
      : validateNormalPlan(loop, planInput);
  const maxWall = plan.budget?.max_wall_ms ?? loop.spec.budget.per_round_wall_ms;
  const maxFiles = plan.budget?.max_changed_files ?? loop.spec.budget.per_round_changed_files;
  if (maxWall > loop.spec.budget.per_round_wall_ms || maxFiles > loop.spec.budget.per_round_changed_files) {
    throw new InputError("Round plan budget exceeds the frozen spec");
  }
  return roundWorkOrderSchema.parse({
    kind: "jevrev.round-work-order",
    schema_version: "1",
    loop_id: loop.state.loop_id,
    round_number: loop.state.last_round + 1,
    spec_revision: loop.spec.revision,
    spec_sha256: loopHash(loop.spec),
    base_revision: loop.state.head_revision,
    mode,
    round_goal: plan.round_goal,
    focus_criteria: plan.focus_criteria,
    hypothesis: plan.hypothesis,
    allowed_scope: plan.allowed_scope,
    do_not_change: plan.do_not_change,
    required_evidence: plan.required_evidence,
    budget: { max_wall_ms: maxWall, max_changed_files: maxFiles },
    stop_conditions: plan.stop_conditions,
  });
}

export async function issueNextRound(directory: string, planInput?: RoundPlan): Promise<{
  loop: LoadedLoop;
  order: RoundWorkOrder;
  issued: boolean;
}> {
  const { loadLoop } = await import("./store.js");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const loop = await loadLoop(directory);
    const order = buildRoundWorkOrder(loop, planInput);
    if (loop.state.status === "issued") return { loop, order, issued: false };
    try {
      const updated = await appendLoopEvent(directory, { type: "ROUND_ISSUED", order });
      return { loop: updated, order, issued: true };
    } catch (error) {
      const racedOnLock = error instanceof InputError && error.message.includes("being updated");
      const racedOnState = error instanceof ProtocolError && error.message.includes("Cannot issue from issued");
      if ((!racedOnLock && !racedOnState) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  throw new ProtocolError("Could not issue round after bounded contention retries");
}
