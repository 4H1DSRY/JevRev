import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { InputError, ProtocolError } from "../domain/errors.js";
import { createFreshDirectory } from "../io/directories.js";
import { longEventSchema, longHash, longSpecSchema, type LongEvent, type LongSpec } from "./schemas.js";
import type { LongEventDraft } from "./normalize.js";

const ZERO_HASH = "0".repeat(64);
const LOCK_NAME = ".mutation.lock";
const PENDING_NAME = "pending.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const INVALID_LOCK_STALE_MS = 10 * 60_000;

const identitySchema = z.object({ session_id: z.string(), spec_sha256: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.string().datetime({ offset: true }) }).strict();
const journalEventSchema = z.object({ sequence: z.number().int().positive(), previous_event_sha256: z.string().regex(/^[a-f0-9]{64}$/), event_sha256: z.string().regex(/^[a-f0-9]{64}$/), payload: longEventSchema }).strict();
const headSchema = z.object({
  session_id: z.string(), spec_revision: z.number().int().positive(), spec_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().nonnegative(), event_count: z.number().int().nonnegative(), last_event_at: z.string().datetime({ offset: true }).nullable(),
  last_event_sha256: z.string().regex(/^[a-f0-9]{64}$/), journal_bytes: z.number().int().nonnegative(), dedupe_bytes: z.number().int().nonnegative(),
}).strict();
const dedupeEntrySchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), event_id: z.string() }).strict();
const dedupeLineSchema = dedupeEntrySchema.extend({ key: z.string().min(1) }).strict();
const pendingSchema = z.object({ old_head: headSchema, new_head: headSchema, journal_append: z.string(), dedupe_append: z.string() }).strict();

export type LongJournalEvent = z.infer<typeof journalEventSchema>;
export type LongJournalHead = z.infer<typeof headSchema>;
export interface LoadedLongStore { directory: string; spec: LongSpec; events: LongJournalEvent[]; snapshot: LongJournalHead }
function eventHash(sequence: number, previous: string, payload: LongEvent): string { return longHash({ sequence, previous_event_sha256: previous, payload }); }
function eventEnvelope(sequence: number, previous: string, payload: LongEvent): LongJournalEvent {
  const envelope = journalEventSchema.parse({ sequence, previous_event_sha256: previous, event_sha256: eventHash(sequence, previous, payload), payload });
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_EVENT_BYTES) throw new InputError("Long event exceeds 64 KiB");
  return envelope;
}
function dedupeFingerprint(payload: LongEvent): string {
  return longHash({ session_id: payload.session_id, adapter_id: payload.adapter_id, adapter_event_id: payload.adapter_event_id,
    spec_revision: payload.spec_revision, spec_sha256: payload.spec_sha256, source: payload.source, event_type: payload.event_type, payload_sha256: payload.payload_sha256 });
}
function initialHead(spec: LongSpec): LongJournalHead {
  return headSchema.parse({ session_id: spec.session_id, spec_revision: spec.revision, spec_sha256: longHash(spec), sequence: 0,
    event_count: 0, last_event_at: null, last_event_sha256: ZERO_HASH, journal_bytes: 0, dedupe_bytes: 0 });
}
async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw new InputError(`Could not atomically write ${path}`, { cause: error }); }
}
async function readIdentityAndSpec(directory: string): Promise<LongSpec> {
  try {
    const [identityRaw, specRaw] = await Promise.all([readFile(join(directory, "identity.json"), "utf8"), readFile(join(directory, "spec.json"), "utf8")]);
    const identity = identitySchema.parse(JSON.parse(identityRaw) as unknown);
    const spec = longSpecSchema.parse(JSON.parse(specRaw) as unknown);
    if (identity.session_id !== spec.session_id || identity.spec_sha256 !== longHash(spec)) throw new ProtocolError("Long identity is not bound to spec");
    return spec;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new InputError(`Could not read Long store ${directory}`, { cause: error });
  }
}

export async function createLongStore(directoryInput: string, specInput: LongSpec): Promise<LoadedLongStore> {
  const spec = longSpecSchema.parse(specInput);
  const directory = resolve(directoryInput);
  await createFreshDirectory(directory, "Long store");
  const head = initialHead(spec);
  await atomicWrite(join(directory, "identity.json"), { session_id: spec.session_id, spec_sha256: longHash(spec), created_at: new Date().toISOString() });
  await atomicWrite(join(directory, "spec.json"), spec);
  await writeFile(join(directory, "events.jsonl"), "", { encoding: "utf8", flag: "wx" });
  await writeFile(join(directory, "dedupe.jsonl"), "", { encoding: "utf8", flag: "wx" });
  await atomicWrite(join(directory, "snapshot.json"), head);
  return { directory, spec, events: [], snapshot: head };
}

function verifyJournal(raw: string, spec: LongSpec): { events: LongJournalEvent[]; head: LongJournalHead } {
  if (raw.length > 0 && !raw.endsWith("\n")) throw new ProtocolError("Long event log has an incomplete trailing event");
  const events: LongJournalEvent[] = [];
  const eventIds = new Set<string>();
  let previous = ZERO_HASH;
  for (const [index, line] of raw.trimEnd() === "" ? [] : raw.trimEnd().split("\n").entries()) {
    let event: LongJournalEvent;
    try { event = journalEventSchema.parse(JSON.parse(line) as unknown); }
    catch (error) { throw new ProtocolError(`Invalid Long event at sequence ${index + 1}`, { cause: error }); }
    if (event.sequence !== index + 1 || event.payload.sequence !== event.sequence || event.previous_event_sha256 !== previous || event.event_sha256 !== eventHash(event.sequence, previous, event.payload)) throw new ProtocolError(`Long event chain is invalid at sequence ${index + 1}`);
    if (event.payload.session_id !== spec.session_id || event.payload.spec_revision !== spec.revision || event.payload.spec_sha256 !== longHash(spec)) throw new ProtocolError(`Long event ${event.sequence} is not bound to the frozen spec`);
    if (eventIds.has(event.payload.event_id)) throw new ProtocolError(`Long event ID is duplicated at sequence ${index + 1}`);
    eventIds.add(event.payload.event_id);
    const priorReceived = events.at(-1)?.payload.received_at;
    if (priorReceived !== undefined && Date.parse(event.payload.received_at) < Date.parse(priorReceived)) throw new ProtocolError(`Long event ${event.sequence} received_at moves backwards`);
    previous = event.event_sha256;
    events.push(event);
  }
  return { events, head: headSchema.parse({ session_id: spec.session_id, spec_revision: spec.revision, spec_sha256: longHash(spec),
    sequence: events.length, event_count: events.length, last_event_at: events.at(-1)?.payload.received_at ?? null,
    last_event_sha256: previous, journal_bytes: Buffer.byteLength(raw, "utf8"), dedupe_bytes: 0 }) };
}

export async function loadLongStore(directoryInput: string): Promise<LoadedLongStore> {
  const directory = resolve(directoryInput);
  const spec = await readIdentityAndSpec(directory);
  let raw: string;
  try { raw = await readFile(join(directory, "events.jsonl"), "utf8"); }
  catch (error) { throw new InputError(`Could not read Long store ${directory}`, { cause: error }); }
  const verified = verifyJournal(raw, spec);
  verified.head.dedupe_bytes = await stat(join(directory, "dedupe.jsonl")).then((value) => value.size).catch(() => 0);
  const cached = await readFile(join(directory, "snapshot.json"), "utf8").then((value) => headSchema.safeParse(JSON.parse(value) as unknown)).catch(() => undefined);
  if (cached?.success && cached.data.sequence > verified.head.sequence) throw new ProtocolError("Long journal was rolled back behind its checkpoint");
  if (cached?.success && cached.data.sequence > 0 && verified.events[cached.data.sequence - 1]?.event_sha256 !== cached.data.last_event_sha256) throw new ProtocolError("Long checkpoint does not match the verified journal");
  return { directory, spec, events: verified.events, snapshot: verified.head };
}

async function loadDedupe(directory: string, head: LongJournalHead, events: readonly LongJournalEvent[]): Promise<Map<string, z.infer<typeof dedupeEntrySchema>>> {
  const expected = new Map<string, z.infer<typeof dedupeEntrySchema>>();
  for (const event of events) expected.set(`${event.payload.adapter_id}:${event.payload.adapter_event_id}`, { fingerprint: dedupeFingerprint(event.payload), event_id: event.payload.event_id });
  let raw: string;
  try { raw = await readFile(join(directory, "dedupe.jsonl"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProtocolError("Long dedupe index cannot be read", { cause: error });
    const rebuilt = expected.size === 0 ? "" : `${[...expected].map(([key, value]) => JSON.stringify({ key, ...value })).join("\n")}\n`;
    await writeFile(join(directory, "dedupe.jsonl"), rebuilt, "utf8");
    head.dedupe_bytes = Buffer.byteLength(rebuilt, "utf8");
    return new Map(expected);
  }
  if (Buffer.byteLength(raw, "utf8") !== head.dedupe_bytes || (raw.length > 0 && !raw.endsWith("\n"))) throw new ProtocolError("Long dedupe index is inconsistent");
  const entries = new Map<string, z.infer<typeof dedupeEntrySchema>>();
  for (const line of raw.trimEnd() === "" ? [] : raw.trimEnd().split("\n")) {
    const parsed = dedupeLineSchema.parse(JSON.parse(line) as unknown);
    if (entries.has(parsed.key)) throw new ProtocolError(`Duplicate key in Long dedupe index: ${parsed.key}`);
    entries.set(parsed.key, { fingerprint: parsed.fingerprint, event_id: parsed.event_id });
  }
  if (entries.size !== expected.size || [...expected].some(([key, value]) => entries.get(key)?.fingerprint !== value.fingerprint || entries.get(key)?.event_id !== value.event_id)) {
    throw new ProtocolError("Long dedupe index does not match the verified journal");
  }
  return new Map(entries);
}

async function recoverPending(directory: string): Promise<void> {
  const path = join(directory, PENDING_NAME);
  let pending: z.infer<typeof pendingSchema>;
  try { pending = pendingSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ProtocolError("Long pending transaction is invalid", { cause: error });
  }
  const journalPath = join(directory, "events.jsonl");
  const dedupePath = join(directory, "dedupe.jsonl");
  const [journalSuffix, dedupeSuffix] = await Promise.all([
    readSuffix(journalPath, pending.old_head.journal_bytes),
    readSuffix(dedupePath, pending.old_head.dedupe_bytes),
  ]);
  if (journalSuffix === pending.journal_append && dedupeSuffix === pending.dedupe_append) {
    await atomicWrite(join(directory, "snapshot.json"), pending.new_head);
  } else {
    await Promise.all([truncate(journalPath, pending.old_head.journal_bytes), truncate(dedupePath, pending.old_head.dedupe_bytes)]);
    await atomicWrite(join(directory, "snapshot.json"), pending.old_head);
  }
  await unlink(path).catch(() => undefined);
}

async function readSuffix(path: string, offset: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < offset) return "";
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

async function acquireLock(directory: string): Promise<Awaited<ReturnType<typeof open>>> {
  const path = join(directory, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const handle = await open(path, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); return handle; }
    catch (error) {
      const metadata = await stat(path).catch(() => undefined);
      const raw = await readFile(path, "utf8").then((value) => JSON.parse(value) as { pid?: unknown }).catch(() => undefined);
      const dead = typeof raw?.pid === "number" && !processAlive(raw.pid);
      const malformedStale = raw === undefined && metadata !== undefined && Date.now() - metadata.mtimeMs >= INVALID_LOCK_STALE_MS;
      if (attempt === 0 && (dead || malformedStale)) {
        const tombstone = `${path}.${randomUUID()}.stale`;
        try { await rename(path, tombstone); await unlink(tombstone).catch(() => undefined); continue; }
        catch (takeoverError) { throw new InputError(`Could not recover stale Long lock: ${directory}`, { cause: takeoverError }); }
      }
      throw new InputError(`Long store is being updated: ${directory}`, { cause: error });
    }
  }
  throw new InputError(`Long store is being updated: ${directory}`);
}

async function ingestLongBatchInternal(directoryInput: string, drafts: readonly LongEventDraft[], options: { receivedAt?: Date; allowRecorded: boolean }): Promise<{ snapshot: LongJournalHead; accepted: LongJournalEvent[]; duplicate_event_ids: string[] }> {
  if (drafts.length > 256) throw new InputError("Long ingest batch exceeds 256 events");
  const directory = resolve(directoryInput);
  const lock = await acquireLock(directory);
  try {
    await recoverPending(directory);
    const spec = await readIdentityAndSpec(directory);
    const loaded = await loadLongStore(directory);
    const head = loaded.snapshot;
    const batchKeys = new Set<string>();
    const accepted: LongJournalEvent[] = [];
    const duplicate_event_ids: string[] = [];
    const dedupe = await loadDedupe(directory, head, loaded.events);
    const eventIds = new Set([...dedupe.values()].map((entry) => entry.event_id));
    const dedupeLines: Array<z.infer<typeof dedupeLineSchema>> = [];
    let previous = head.last_event_sha256;
    let sequence = head.sequence;
    let previousReceived = head.last_event_at;
    let batchBytes = 0;
    const receivedAt = options.receivedAt ?? new Date();
    if (!Number.isFinite(receivedAt.getTime())) throw new InputError("Long ingest receivedAt is invalid");
    const receivedIso = receivedAt.toISOString();
    for (const draft of drafts) {
      if (draft.source === "recorded" && options.allowRecorded !== true) throw new ProtocolError("Long ingest cannot submit recorded events");
      const payload = longEventSchema.parse({ ...draft, received_at: receivedIso, sequence: sequence + 1 });
      if (payload.session_id !== spec.session_id || payload.spec_revision !== spec.revision || payload.spec_sha256 !== longHash(spec)) throw new ProtocolError("Long event does not match the frozen spec");
      if (Date.parse(payload.occurred_at) > receivedAt.getTime() + spec.thresholds.max_clock_skew_ms) throw new ProtocolError("Long event occurred_at is too far in the future");
      if (previousReceived !== null && Date.parse(payload.received_at) < Date.parse(previousReceived)) throw new ProtocolError("Long event received_at moves backwards");
      const key = `${payload.adapter_id}:${payload.adapter_event_id}`;
      if (batchKeys.has(key)) throw new ProtocolError(`Duplicate adapter event in batch: ${key}`);
      batchKeys.add(key);
      const prior = dedupe.get(key);
      const fingerprint = dedupeFingerprint(payload);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) throw new ProtocolError(`Adapter event ID was reused with a different payload: ${key}`);
        duplicate_event_ids.push(prior.event_id);
        continue;
      }
      if (eventIds.has(payload.event_id)) throw new ProtocolError(`Duplicate Long event ID: ${payload.event_id}`);
      const envelope = eventEnvelope(++sequence, previous, payload);
      accepted.push(envelope);
      batchBytes += Buffer.byteLength(JSON.stringify(envelope), "utf8") + 1;
      if (batchBytes > MAX_BATCH_BYTES) throw new InputError("Long ingest batch exceeds 1 MiB");
      const entry = { fingerprint, event_id: payload.event_id };
      dedupe.set(key, entry);
      eventIds.add(payload.event_id);
      dedupeLines.push({ key, ...entry });
      previous = envelope.event_sha256;
      previousReceived = payload.received_at;
    }
    if (accepted.length === 0) return { snapshot: head, accepted, duplicate_event_ids };
    const appendText = `${accepted.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const dedupeText = `${dedupeLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    if (head.journal_bytes + Buffer.byteLength(appendText, "utf8") > MAX_SESSION_BYTES) throw new InputError("Long session journal exceeds 256 MiB; rotate the session");
    const nextHead = headSchema.parse({ ...head, sequence, event_count: sequence, last_event_at: accepted.at(-1)!.payload.received_at,
      last_event_sha256: previous, journal_bytes: head.journal_bytes + Buffer.byteLength(appendText, "utf8"),
      dedupe_bytes: head.dedupe_bytes + Buffer.byteLength(dedupeText, "utf8") });
    await atomicWrite(join(directory, PENDING_NAME), pendingSchema.parse({ old_head: head, new_head: nextHead, journal_append: appendText, dedupe_append: dedupeText }));
    const journalHandle = await open(join(directory, "events.jsonl"), "a");
    try { await journalHandle.writeFile(appendText); await journalHandle.sync(); } finally { await journalHandle.close(); }
    const dedupeHandle = await open(join(directory, "dedupe.jsonl"), "a");
    try { await dedupeHandle.writeFile(dedupeText); await dedupeHandle.sync(); } finally { await dedupeHandle.close(); }
    try {
      await atomicWrite(join(directory, "snapshot.json"), nextHead);
      await unlink(join(directory, PENDING_NAME)).catch(() => undefined);
    } catch {
      // The journal append is durable. Leave pending.json so the next locked
      // mutation can replay cache/index updates without duplicating the batch.
    }
    return { snapshot: nextHead, accepted, duplicate_event_ids };
  } finally {
    await lock.close();
    await unlink(join(directory, LOCK_NAME)).catch(() => undefined);
  }
}

export async function ingestLongBatch(directoryInput: string, drafts: readonly LongEventDraft[], options: { receivedAt?: Date } = {}): Promise<{ snapshot: LongJournalHead; accepted: LongJournalEvent[]; duplicate_event_ids: string[] }> {
  return ingestLongBatchInternal(directoryInput, drafts, { ...options, allowRecorded: false });
}

export async function ingestRecordedLongBatch(directoryInput: string, drafts: readonly LongEventDraft[], options: { receivedAt?: Date } = {}): Promise<{ snapshot: LongJournalHead; accepted: LongJournalEvent[]; duplicate_event_ids: string[] }> {
  return ingestLongBatchInternal(directoryInput, drafts, { ...options, allowRecorded: true });
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
