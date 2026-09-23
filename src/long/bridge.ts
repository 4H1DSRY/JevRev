import { normalizeExternalEvent } from "./normalize.js";
import { ingestRecordedLongBatch, loadLongStore } from "./store.js";
import { InputError } from "../domain/errors.js";
import { loopHash } from "../loop/schemas.js";
import { loadLoop } from "../loop/store.js";

export interface LoopAuditBridgeInput {
  loop_id: string;
  round_number: number;
  work_order_sha256: string;
  audit_outcome: string;
  evidence_sha256: string;
  occurred_at?: string;
}

const LOOP_AUDIT_OUTCOMES = new Set(["continue", "fix_regression", "verify", "replan", "waiting_human", "budget_paused", "completed"]);

export async function recordLoopAuditEvent(directory: string, loopDirectory: string, input: LoopAuditBridgeInput, receivedAt = new Date()) {
  if (!/^jvl_[a-f0-9]{16}$/.test(input.loop_id)) throw new InputError("Invalid Loop ID for Long bridge");
  if (!Number.isInteger(input.round_number) || input.round_number < 1) throw new InputError("Loop bridge round must be positive");
  if (!/^[a-f0-9]{64}$/.test(input.work_order_sha256) || !/^[a-f0-9]{64}$/.test(input.evidence_sha256)) throw new InputError("Loop bridge digests must be SHA-256 hex");
  if (!LOOP_AUDIT_OUTCOMES.has(input.audit_outcome)) throw new InputError("Loop bridge outcome is invalid");
  const loop = await loadLoop(loopDirectory);
  if (loop.state.loop_id !== input.loop_id) throw new InputError("Loop bridge ID does not match the Loop directory");
  const auditEvent = [...loop.events].reverse().find((event) =>
    event.payload.type === "ROUND_AUDITED" && event.payload.result.round_number === input.round_number,
  );
  if (auditEvent === undefined || auditEvent.payload.type !== "ROUND_AUDITED") {
    throw new InputError(`Loop round ${input.round_number} has no audited result to bridge`);
  }
  if (auditEvent.payload.result.outcome !== input.audit_outcome ||
      auditEvent.payload.evidence.work_order_sha256 !== input.work_order_sha256 ||
      loopHash(auditEvent.payload.evidence) !== input.evidence_sha256) {
    throw new InputError("Loop bridge digests or outcome do not match the audited Loop event");
  }
  const store = await loadLongStore(directory);
  const adapterEventId = `${input.loop_id}-round-${input.round_number}`;
  const draft = normalizeExternalEvent({
    adapter_id: "jevrev-loop",
    adapter_event_id: adapterEventId,
    event_type: "loop_audit",
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    payload: {
      loop_id: input.loop_id,
      round_number: input.round_number,
      work_order_sha256: input.work_order_sha256,
      audit_outcome: input.audit_outcome,
      evidence_sha256: input.evidence_sha256,
    },
    source: "imported",
  }, { spec: store.spec, receivedAt });
  return ingestRecordedLongBatch(directory, [{ ...draft, source: "recorded" }], { receivedAt });
}
