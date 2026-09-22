import { longAlertSchema, longSpecSchema, type LongAlert, type LongEvent, type LongSpec } from "./schemas.js";
import type { SignalResult } from "./signals.js";

export interface PolicyState { alerts: readonly LongAlert[] }
export interface PolicyResult { alerts: LongAlert[]; raised: LongAlert[]; recovered: LongAlert[] }

function nowIso(evaluatedAt: Date): string { return evaluatedAt.toISOString(); }
function severityFor(kind: LongAlert["kind"]): LongAlert["severity"] {
  if (kind === "fatal_error" || kind === "protected_surface" || kind === "protocol") return "critical";
  if (kind === "failure_loop" || kind === "drift" || kind === "budget_risk") return "high";
  if (kind === "stall" || kind === "silent") return "notice";
  return "info";
}
function newAlert(kind: LongAlert["kind"], reasonCode: string, message: string, sequence: number, eventIds: string[], evaluatedAt: Date): LongAlert {
  return longAlertSchema.parse({ id: `alert-${kind}-${sequence}`, kind, severity: severityFor(kind), status: "open", identity_key: `${kind}:${reasonCode}`, reason_code: reasonCode, message, first_sequence: sequence, last_sequence: sequence, occurrence_count: 1, evidence_event_ids: eventIds.slice(-64), raised_at: nowIso(evaluatedAt), updated_at: nowIso(evaluatedAt) });
}

export function evaluateLongPolicy(specInput: LongSpec, signals: SignalResult, events: readonly LongEvent[], state: PolicyState, evaluatedAt: Date): PolicyResult {
  const spec = longSpecSchema.parse(specInput);
  const sequence = events.at(-1)?.sequence ?? 0;
  const eventIds = (key: string) => signals.evidence_event_ids[key] ?? [];
  const conditions: Array<{ kind: LongAlert["kind"]; reason: string; message: string; active: boolean; evidence: string[] }> = [
    { kind: "silent", reason: "heartbeat_timeout", message: "No heartbeat received within the configured window", active: signals.activity === "silent", evidence: eventIds("activity") },
    { kind: "stall", reason: "stall_threshold", message: "Meaningful progress has stopped", active: signals.stall_score >= 1, evidence: eventIds("stall") },
    { kind: "failure_loop", reason: "repeated_failure", message: "The same failure pattern has repeated", active: signals.failure_score >= 1, evidence: eventIds("failure") },
    { kind: "drift", reason: "scope_drift", message: "Changes left the declared scope", active: signals.drift_score >= spec.thresholds.drift_warning_score, evidence: eventIds("drift") },
    { kind: "protected_surface", reason: "protected_change", message: "A protected surface changed", active: (signals.evidence_event_ids.drift?.length ?? 0) > 0 && signals.drift_score >= spec.thresholds.drift_warning_score, evidence: eventIds("drift") },
    { kind: "budget_risk", reason: "budget_projection", message: "Projected resource usage crossed the warning threshold", active: signals.budget_risk >= 1, evidence: eventIds("budget") },
  ];
  const current = new Map(state.alerts.map((alert) => [alert.identity_key, alert]));
  const raised: LongAlert[] = [];
  const recovered: LongAlert[] = [];
  for (const condition of conditions) {
    const key = `${condition.kind}:${condition.reason}`;
    const prior = current.get(key);
    if (condition.active) {
      if (prior?.status === "open" || prior?.status === "acknowledged") {
        current.set(key, longAlertSchema.parse({ ...prior, last_sequence: sequence || prior.last_sequence, occurrence_count: prior.occurrence_count + 1, evidence_event_ids: [...new Set([...prior.evidence_event_ids, ...condition.evidence])].slice(-64), updated_at: nowIso(evaluatedAt) }));
      } else {
        const alert = newAlert(condition.kind, condition.reason, condition.message, sequence || 1, condition.evidence, evaluatedAt);
        current.set(key, alert); raised.push(alert);
      }
    } else if (prior?.status === "open") {
      const closed = longAlertSchema.parse({ ...prior, status: "recovered", last_sequence: sequence || prior.last_sequence, updated_at: nowIso(evaluatedAt) });
      current.set(key, closed); recovered.push(closed);
    }
  }
  const alerts = [...current.values()].slice(-spec.alert_policy.max_alert_history);
  return { alerts, raised, recovered };
}
