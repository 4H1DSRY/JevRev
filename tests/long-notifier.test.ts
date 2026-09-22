import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileNotifier, NullNotifier, WebhookNotifier } from "../src/long/notifier.js";
import type { LongAlert } from "../src/long/schemas.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => { if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error("unsafe cleanup"); rmSync(path, { recursive: true, force: true }); }));
const alert: LongAlert = { id: "alert-1", kind: "drift", severity: "high", status: "open", identity_key: "drift:scope", reason_code: "scope_drift", message: "Out of scope", first_sequence: 1, last_sequence: 1, occurrence_count: 1, evidence_event_ids: ["event-1"], raised_at: "2026-09-22T12:00:00.000Z", updated_at: "2026-09-22T12:00:00.000Z" };

describe("JevLong notifiers", () => {
  it("keeps NullNotifier side-effect free", async () => {
    await expect(new NullNotifier().notify([alert])).resolves.toBeUndefined();
  });
  it("writes newline-delimited alert records", async () => {
    const root = mkdtempSync(join(tmpdir(), "jevrev-long-notifier-")); roots.push(root); const path = join(root, "alerts.jsonl");
    await new FileNotifier(path).notify([alert]);
    expect(JSON.parse(readFileSync(path, "utf8").trim())).toMatchObject({ id: "alert-1", kind: "drift" });
  });
  it("sends one JSON webhook batch and fails on non-2xx", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher = async (input: string | URL, init?: RequestInit) => { requests.push({ url: String(input), body: String(init?.body) }); return new Response("ok", { status: 200 }); };
    await new WebhookNotifier("https://example.test/alerts", fetcher).notify([alert]);
    expect(requests).toHaveLength(1); expect(JSON.parse(requests[0]!.body).alerts[0].id).toBe("alert-1");
    const failing = async () => new Response("bad", { status: 503 });
    await expect(new WebhookNotifier("https://example.test/alerts", failing).notify([alert])).rejects.toThrow("503");
  });
});
