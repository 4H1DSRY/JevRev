import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { InputError, ProtocolError } from "../domain/errors.js";
import {
  loopHash, loopSpecSchema, roundAuditResultSchema, roundEvidenceSchema,
  roundWorkOrderSchema, type LoopSpec, type RoundAuditResult, type RoundEvidence,
  type RoundWorkOrder,
} from "./schemas.js";
import { transition, type LoopState } from "./state-machine.js";

const eventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("LOOP_CREATED"), loop_id: z.string().regex(/^jvl_[a-f0-9]{16}$/), spec: loopSpecSchema, base_revision: z.string().min(1) }).strict(),
  z.object({ type: z.literal("ROUND_ISSUED"), order: roundWorkOrderSchema }).strict(),
  z.object({ type: z.literal("ROUND_AUDITED"), result: roundAuditResultSchema, evidence: roundEvidenceSchema }).strict(),
  z.object({ type: z.literal("LOOP_RESUMED"), approved_by: z.string().trim().min(1).max(120), reason: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ type: z.literal("LOOP_ABORTED") }).strict(),
  z.object({ type: z.literal("SPEC_APPROVED"), spec: loopSpecSchema, approved_by: z.string().trim().min(1).max(120), reason: z.string().trim().min(1).max(1_000) }).strict(),
]);
export type LoopEventPayload = z.infer<typeof eventPayloadSchema>;

const eventSchema = z.object({
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  previous_event_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  event_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: eventPayloadSchema,
}).strict();
export type LoopEvent = z.infer<typeof eventSchema>;

const ZERO_HASH = "0".repeat(64);
const LOCK_NAME = ".mutation.lock";
const INVALID_LOCK_STALE_MS = 10 * 60_000;

export interface LoadedLoop {
  directory: string;
  spec: LoopSpec;
  state: LoopState;
  events: LoopEvent[];
}

function eventWithHash(sequence: number, previous: string, payload: LoopEventPayload): LoopEvent {
  const base = {
    sequence,
    timestamp: new Date().toISOString(),
    previous_event_sha256: previous,
    payload_sha256: loopHash(payload),
    payload,
  };
  return eventSchema.parse({ ...base, event_sha256: loopHash(base) });
}

function verifyEvent(event: LoopEvent, sequence: number, previous: string): void {
  const { event_sha256: _hash, ...base } = event;
  if (event.sequence !== sequence || event.previous_event_sha256 !== previous ||
      event.payload_sha256 !== loopHash(event.payload) || loopHash(base) !== event.event_sha256) {
    throw new ProtocolError(`Loop event chain is invalid at sequence ${sequence}`);
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new InputError(`Could not atomically write ${path}`, { cause: error });
  }
}

function applyEvent(
  state: LoopState,
  currentSpec: LoopSpec,
  payload: Exclude<LoopEventPayload, { type: "LOOP_CREATED" }>,
): { state: LoopState; spec: LoopSpec } {
  switch (payload.type) {
    case "ROUND_ISSUED":
      return { state: transition(state, { type: "issue", order: payload.order, spec: currentSpec }), spec: currentSpec };
    case "ROUND_AUDITED":
      return { state: transition(state, { type: "audit", result: payload.result, evidence: payload.evidence, spec: currentSpec }), spec: currentSpec };
    case "LOOP_RESUMED":
      return { state: transition(state, { type: "resume" }), spec: currentSpec };
    case "LOOP_ABORTED":
      return { state: transition(state, { type: "abort" }), spec: currentSpec };
    case "SPEC_APPROVED":
      if (payload.spec.goal !== currentSpec.goal && payload.reason.length < 10) {
        throw new InputError("Changing the goal requires a meaningful approval reason");
      }
      return {
        state: transition(state, { type: "approve_spec", revision: payload.spec.revision, spec_sha256: loopHash(payload.spec) }),
        spec: payload.spec,
      };
  }
}

export async function createLoop(directoryInput: string, specInput: LoopSpec, baseRevision: string): Promise<LoadedLoop> {
  const spec = loopSpecSchema.parse(specInput);
  if (spec.revision !== 1 || baseRevision.trim().length === 0) {
    throw new InputError("A new loop needs spec revision 1 and a base revision");
  }
  const directory = resolve(directoryInput);
  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    throw new InputError(`Loop directory must not already exist: ${directory}`, { cause: error });
  }
  const loopId = `jvl_${randomBytes(8).toString("hex")}`;
  const created = eventWithHash(1, ZERO_HASH, { type: "LOOP_CREATED", loop_id: loopId, spec, base_revision: baseRevision });
  const state: LoopState = {
    loop_id: loopId, spec_revision: spec.revision, spec_sha256: loopHash(spec),
    status: "ready", last_round: 0, active_order: null, last_audit: null,
    cumulative_wall_ms: 0, cumulative_provider_tokens: 0, plateau_replans: 0,
    consecutive_stalled: 0, head_revision: baseRevision,
  };
  // This identity file is immutable; its digest is checked on every load.
  await atomicJson(join(directory, "identity.json"), { loop_id: loopId, created_event_sha256: created.event_sha256 });
  await writeFile(join(directory, "events.jsonl"), `${JSON.stringify(created)}\n`, { encoding: "utf8", flag: "wx" });
  await atomicJson(join(directory, "snapshot.json"), {
    sequence: 1, event_sha256: created.event_sha256, state, spec,
  });
  return { directory, spec, state, events: [created] };
}

export async function loadLoop(directoryInput: string): Promise<LoadedLoop> {
  const directory = resolve(directoryInput);
  let raw: string;
  let identity: unknown;
  try {
    [raw, identity] = await Promise.all([
      readFile(join(directory, "events.jsonl"), "utf8"),
      readFile(join(directory, "identity.json"), "utf8").then((value) => JSON.parse(value) as unknown),
    ]);
  } catch (error) {
    throw new InputError(`Could not read loop directory ${directory}`, { cause: error });
  }
  if (!raw.endsWith("\n")) throw new ProtocolError("Loop event log has an incomplete trailing event");
  const lines = raw.trimEnd().split("\n");
  if (lines.length === 0) throw new ProtocolError("Loop event log is empty");
  const events: LoopEvent[] = [];
  let previous = ZERO_HASH;
  for (const [index, line] of lines.entries()) {
    let event: LoopEvent;
    try {
      event = eventSchema.parse(JSON.parse(line) as unknown);
    } catch (error) {
      throw new ProtocolError(`Invalid loop event at sequence ${index + 1}`, { cause: error });
    }
    verifyEvent(event, index + 1, previous);
    previous = event.event_sha256;
    events.push(event);
  }
  const first = events[0]!;
  if (first.payload.type !== "LOOP_CREATED" || identity === null || typeof identity !== "object" ||
      !('loop_id' in identity) || !('created_event_sha256' in identity) ||
      identity.created_event_sha256 !== first.event_sha256 || identity.loop_id !== first.payload.loop_id) {
    throw new ProtocolError("Loop identity and creation event do not match");
  }
  let spec = first.payload.spec;
  let state: LoopState = {
    loop_id: first.payload.loop_id,
    spec_revision: spec.revision,
    spec_sha256: loopHash(spec),
    status: "ready", last_round: 0, active_order: null, last_audit: null,
    cumulative_wall_ms: 0, cumulative_provider_tokens: 0, plateau_replans: 0,
    consecutive_stalled: 0, head_revision: first.payload.base_revision,
  };
  for (const event of events.slice(1)) {
    if (event.payload.type === "LOOP_CREATED") throw new ProtocolError("A loop cannot be created twice");
    ({ state, spec } = applyEvent(state, spec, event.payload));
  }
  // Never write during a read: concurrent readers must not race a mutation
  // or require write access just to inspect status. The verified event stream
  // reconstructs state; the next locked mutation refreshes the snapshot.
  return { directory, spec, state, events };
}

export async function appendLoopEvent(directoryInput: string, payloadInput: LoopEventPayload): Promise<LoadedLoop> {
  const directory = resolve(directoryInput);
  const payload = eventPayloadSchema.parse(payloadInput);
  if (payload.type === "LOOP_CREATED") throw new ProtocolError("Cannot append a second creation event");
  const lockPath = join(directory, LOCK_NAME);
  const lock = await acquireMutationLock(lockPath, directory);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    const loaded = await loadLoop(directory);
    const applied = applyEvent(loaded.state, loaded.spec, payload);
    const previous = loaded.events.at(-1)!.event_sha256;
    const event = eventWithHash(loaded.events.length + 1, previous, payload);
    const handle = await open(join(directory, "events.jsonl"), "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicJson(join(directory, "snapshot.json"), {
      sequence: event.sequence, event_sha256: event.event_sha256,
      state: applied.state, spec: applied.spec,
    }).catch(() => undefined); // Cache failure must not turn a durable append into a reported failure.
    return { directory, ...applied, events: [...loaded.events, event] };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function acquireMutationLock(
  lockPath: string,
  directory: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      const metadata = await stat(lockPath).catch(() => undefined);
      if (metadata === undefined) {
        if (attempt === 0) continue;
        throw new InputError(`Cannot lock loop directory: ${directory}`, { cause: error });
      }
      const raw = await readFile(lockPath, "utf8").then((value) => JSON.parse(value) as unknown).catch(() => undefined);
      const record = raw !== null && typeof raw === "object" &&
        "pid" in raw && typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 &&
        "created_at" in raw && typeof raw.created_at === "string"
        ? { pid: raw.pid, createdAt: Date.parse(raw.created_at) }
        : undefined;
      const alive = record === undefined ? undefined : processAlive(record.pid);
      const stale = record === undefined
        ? Date.now() - metadata.mtimeMs >= INVALID_LOCK_STALE_MS
        : alive === false;
      if (!stale || attempt > 0) {
        throw new InputError(`Loop is being updated (or has a stale lock): ${lockPath}`, { cause: error });
      }
      const tombstone = `${lockPath}.${randomUUID()}.stale`;
      try {
        await rename(lockPath, tombstone);
        await unlink(tombstone).catch(() => undefined);
      } catch (takeoverError) {
        throw new InputError(`Could not recover stale loop lock: ${lockPath}`, { cause: takeoverError });
      }
    }
  }
  throw new InputError(`Cannot lock loop directory: ${directory}`);
}

function processAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? false : undefined;
  }
}
