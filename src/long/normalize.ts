import { longExternalEventSchema, longHash, longSourceSchema, type LongEvent, type LongSpec, type LongSource } from "./schemas.js";
import { InputError } from "../domain/errors.js";
import { z } from "zod";

const MAX_DEPTH = 8;
const MAX_KEYS = 256;
const MAX_PAYLOAD_BYTES = 60_000;

const rawEventSchema = z.object({
  adapter_id: z.string().trim().min(1).max(256),
  adapter_event_id: z.string().trim().min(1).max(256),
  event_type: z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  payload: z.record(z.string().trim().min(1).max(64), z.json()).default({}),
  source: longSourceSchema.optional(),
}).strict();

export type RawLongEvent = z.input<typeof rawEventSchema>;
export type LongEventDraft = Omit<LongEvent, "sequence">;

const SECRET_KEY = /(api[_-]?key|access[_-]?token|auth(orization)?|password|passwd|secret|private[_-]?key|cookie|session[_-]?token|(^|[_-])token($|[_-]))/i;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+[^\s"',;]+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AIza[0-9A-Za-z_-]{12,})/gi;
const URL_SECRET_VALUE = /([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]+/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const PATH_KEY = /^(?:path|cwd|file|old_path|new_path)$/i;

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) throw new InputError("Long event payload exceeds the maximum JSON depth");
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(PRIVATE_KEY_BLOCK, "[REDACTED]").replace(SECRET_VALUE, "[REDACTED]").replace(URL_SECRET_VALUE, "$1[REDACTED]");
  if (typeof value !== "object") throw new InputError("Long event payload must contain JSON values");
  if (seen.has(value)) throw new InputError("Long event payload cannot contain cyclic data");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_KEYS) throw new InputError("Long event payload has too many array items");
      return value.map((item) => redact(item, depth + 1, seen));
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_KEYS) throw new InputError("Long event payload has too many object keys");
    return Object.fromEntries(entries.map(([key, item]) => [key,
      SECRET_KEY.test(key) ? "[REDACTED]" : PATH_KEY.test(key) && typeof item === "string" ? normalizeReportedPath(item) : redact(item, depth + 1, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

function safeTimestamp(value: string | undefined, receivedAt: Date, maxClockSkewMs: number): string {
  if (value === undefined) return receivedAt.toISOString();
  const occurred = Date.parse(value);
  if (!Number.isFinite(occurred)) throw new InputError("Long event occurred_at is invalid");
  if (occurred > receivedAt.getTime() + maxClockSkewMs) throw new InputError("Long event occurred_at is too far in the future");
  return new Date(occurred).toISOString();
}

export function normalizeExternalEvent(
  input: unknown,
  options: { spec: LongSpec; receivedAt?: Date; source?: Exclude<LongSource, "recorded"> },
): LongEventDraft {
  const parsed = rawEventSchema.safeParse(input);
  if (!parsed.success) throw new InputError(`Invalid external Long event: ${parsed.error.message}`);
  const receivedAt = options.receivedAt ?? new Date();
  if (!Number.isFinite(receivedAt.getTime())) throw new InputError("Long event receivedAt is invalid");
  const payloadData = redact(parsed.data.payload, 0, new WeakSet<object>()) as LongEvent["payload"]["data"];
  const payload = { data: payloadData } as LongEvent["payload"];
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) throw new InputError("Long event payload exceeds 60 KiB after redaction");
  const canonicalAdapterId = canonicalId(parsed.data.adapter_id);
  const canonicalAdapterEventId = canonicalId(parsed.data.adapter_event_id);
  const eventId = `evt-${longHash([canonicalAdapterId, canonicalAdapterEventId]).slice(0, 32)}`;
  const draft = {
    kind: "jevrev.long-event" as const,
    schema_version: "1" as const,
    session_id: options.spec.session_id,
    event_id: eventId,
    adapter_id: canonicalAdapterId,
    adapter_event_id: canonicalAdapterEventId,
    occurred_at: safeTimestamp(parsed.data.occurred_at, receivedAt, options.spec.thresholds.max_clock_skew_ms),
    received_at: receivedAt.toISOString(),
    spec_revision: options.spec.revision,
    spec_sha256: longHash(options.spec),
    source: options.source ?? "imported",
    event_type: parsed.data.event_type,
    payload_sha256: longHash(payload),
    payload,
  } satisfies LongEventDraft;
  // Validate the normalized shape while retaining the internal source contract.
  longExternalEventSchema.parse({ sequence: 1, ...draft });
  return draft;
}

function canonicalId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) throw new InputError("Long adapter identity cannot be canonicalized safely");
  return normalized;
}

function normalizeReportedPath(value: string): string {
  const normalized = value.trim().replace(/\\+/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (normalized.length === 0 || normalized.length > 1_000 || /^(?:[a-zA-Z]:|\/)/.test(normalized) ||
      normalized.split("/").includes("..") || /[:\u0000-\u001f\u007f]/.test(normalized)) {
    throw new InputError(`Long event path escapes or is invalid: ${value}`);
  }
  return normalized;
}
