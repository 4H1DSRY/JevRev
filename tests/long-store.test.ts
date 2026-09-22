import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeExternalEvent } from "../src/long/normalize.js";
import { createLongStore, ingestLongBatch, loadLongStore } from "../src/long/store.js";
import { longHash, type LongSpec } from "../src/long/schemas.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => { if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error("unsafe cleanup"); rmSync(path, { recursive: true, force: true }); }));

const spec: LongSpec = {
  kind: "jevrev.long-spec", schema_version: "1", revision: 1, session_id: "jvlng_1111111111111111", title: "Store", goal: "Observe", workspace: ".", allowed_scope: [], protected_surfaces: [], milestones: [],
  budget: { max_wall_ms: 10_000, max_provider_tokens: 100, max_tool_calls: 100 }, thresholds: { stall_after_ms: 1000, heartbeat_after_ms: 100, repeated_failure_window: 1000, repeated_failure_count: 2, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 1000 }, alert_policy: { cooldown_ms: 100, max_open_alerts: 4, max_alert_history: 20, severity_escalation_window: 1000 }, observer_budget: { provider: "none", max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 1000, min_interval_ms: 100, max_context_bytes: 1000 },
};
const receivedAt = new Date("2026-09-22T12:00:00.000Z");

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jevrev-long-store-")); roots.push(root); const directory = join(root, "long"); await createLongStore(directory, spec); return directory;
}

function draft(id: string, value = 1) {
  return normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: id, event_type: "heartbeat", payload: { value } }, { spec, receivedAt });
}

describe("JevLong event store", () => {
  it("creates, appends a batch, and reloads the verified chain", async () => {
    const directory = await fixture();
    const trustedReceive = new Date("2026-09-22T12:00:00.500Z");
    const result = await ingestLongBatch(directory, [draft("one"), draft("two")], { receivedAt: trustedReceive });
    expect(result.accepted.map((event) => event.sequence)).toEqual([1, 2]);
    expect(result.accepted.every((event) => event.payload.received_at === trustedReceive.toISOString())).toBe(true);
    expect((await loadLongStore(directory)).snapshot).toMatchObject({ sequence: 2, event_count: 2 });
    expect(readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("makes identical adapter retries no-op and rejects payload reuse", async () => {
    const directory = await fixture(); const first = draft("same", 1); await ingestLongBatch(directory, [first]);
    const duplicate = await ingestLongBatch(directory, [{ ...draft("same", 1), received_at: "2026-09-22T12:00:01.000Z", occurred_at: "2026-09-22T12:00:01.000Z" }]);
    expect(duplicate.accepted).toHaveLength(0); expect(duplicate.duplicate_event_ids).toHaveLength(1);
    await expect(ingestLongBatch(directory, [draft("same", 2)])).rejects.toThrow("different payload");
    expect((await loadLongStore(directory)).events).toHaveLength(1);
  });

  it("rejects duplicate keys within an atomic batch and preserves prior state", async () => {
    const directory = await fixture();
    await expect(ingestLongBatch(directory, [draft("same", 1), draft("same", 1)])).rejects.toThrow("Duplicate adapter");
    expect((await loadLongStore(directory)).events).toHaveLength(0);
  });

  it("rejects external recorded events even if the envelope is otherwise valid", async () => {
    const directory = await fixture();
    await expect(ingestLongBatch(directory, [{ ...draft("recorded"), source: "recorded" }])).rejects.toThrow("recorded");
  });

  it("detects tampered payloads and incomplete journal lines", async () => {
    const directory = await fixture(); await ingestLongBatch(directory, [draft("tamper")]);
    const path = join(directory, "events.jsonl"); const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("heartbeat", "unknown_event"), "utf8"); await expect(loadLongStore(directory)).rejects.toThrow("chain");
    writeFileSync(path, original.trimEnd(), "utf8"); await expect(loadLongStore(directory)).rejects.toThrow("incomplete");
  });

  it("detects complete-line rollback behind the durable checkpoint", async () => {
    const directory = await fixture(); await ingestLongBatch(directory, [draft("roll-1"), draft("roll-2")]);
    const path = join(directory, "events.jsonl"); const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, `${lines[0]}\n`, "utf8");
    await expect(loadLongStore(directory)).rejects.toThrow("rolled back");
  });

  it("rejects an event bound to another spec revision or digest", async () => {
    const directory = await fixture();
    await expect(ingestLongBatch(directory, [{ ...draft("wrong-spec"), spec_revision: 2 }])).rejects.toThrow("frozen spec");
  });

  it("recovers a missing snapshot from the journal", async () => {
    const directory = await fixture(); await ingestLongBatch(directory, [draft("recover")]); rmSync(join(directory, "snapshot.json"));
    const loaded = await loadLongStore(directory); expect(loaded.events).toHaveLength(1); expect(loaded.snapshot.sequence).toBe(1);
  });

  it("rebuilds a stale or malformed snapshot from the verified journal", async () => {
    const directory = await fixture(); await ingestLongBatch(directory, [draft("snapshot")]);
    writeFileSync(join(directory, "snapshot.json"), JSON.stringify({ sequence: 999 }), "utf8");
    const loaded = await loadLongStore(directory); expect(loaded.snapshot).toMatchObject({ sequence: 1, event_count: 1, session_id: spec.session_id });
  });

  it("returns durable success on checkpoint failure and completes pending recovery", async () => {
    const directory = await fixture(); const snapshot = join(directory, "snapshot.json"); rmSync(snapshot); mkdirSync(snapshot);
    const first = await ingestLongBatch(directory, [draft("pending-1")], { receivedAt });
    expect(first.accepted).toHaveLength(1);
    rmSync(snapshot, { recursive: true, force: true });
    const second = await ingestLongBatch(directory, [draft("pending-2")], { receivedAt: new Date(receivedAt.getTime() + 1) });
    expect(second.accepted).toHaveLength(1);
    expect((await loadLongStore(directory)).events).toHaveLength(2);
  });

  it("fails closed on malformed pending state", async () => {
    const directory = await fixture(); writeFileSync(join(directory, "pending.json"), "{bad", "utf8");
    await expect(ingestLongBatch(directory, [draft("bad-pending")])).rejects.toThrow("pending transaction");
    expect((await loadLongStore(directory)).events).toHaveLength(0);
  });

  it("recovers a lock owned by a confirmed dead process", async () => {
    const directory = await fixture();
    writeFileSync(join(directory, ".mutation.lock"), JSON.stringify({ pid: 2147483647, created_at: new Date().toISOString() }), "utf8");
    expect((await ingestLongBatch(directory, [draft("after-dead-lock")])).accepted).toHaveLength(1);
  });

  it("rejects received time moving backwards", async () => {
    const directory = await fixture(); await ingestLongBatch(directory, [draft("time-1")], { receivedAt });
    const older = { ...draft("time-2"), received_at: "2026-09-22T11:59:59.000Z", occurred_at: "2026-09-22T11:59:59.000Z" };
    await expect(ingestLongBatch(directory, [older], { receivedAt: new Date("2026-09-22T11:59:59.000Z") })).rejects.toThrow("moves backwards");
  });

  it("rejects a future occurred_at even when a caller forges received_at", async () => {
    const directory = await fixture();
    const future = { ...draft("future"), occurred_at: "2099-01-01T00:00:00.000Z", received_at: "2099-01-01T00:00:00.000Z" };
    await expect(ingestLongBatch(directory, [future], { receivedAt })).rejects.toThrow("future");
  });

  it("rejects an oversized batch before taking a mutation", async () => {
    const directory = await fixture();
    await expect(ingestLongBatch(directory, Array.from({ length: 257 }, (_, index) => draft(`event-${index}`)))).rejects.toThrow("256");
    expect((await loadLongStore(directory)).events).toHaveLength(0);
  });

  it("rejects a batch over one MiB atomically", async () => {
    const directory = await fixture();
    const large = Array.from({ length: 220 }, (_, index) => normalizeExternalEvent({ adapter_id: "jsonl", adapter_event_id: `large-${index}`, event_type: "heartbeat", payload: { text: "x".repeat(5_000) } }, { spec, receivedAt }));
    await expect(ingestLongBatch(directory, large)).rejects.toThrow("1 MiB");
    expect((await loadLongStore(directory)).events).toHaveLength(0);
  });
});
