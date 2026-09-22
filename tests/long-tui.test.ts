import { describe, expect, it } from "vitest";
import { dashboardFromStatus, longEventSummary, renderLongDashboard, renderLongTui } from "../src/long/tui.js";
import { watchLong } from "../src/long/watch.js";
import type { LongDashboard } from "../src/long/tui.js";
import type { LongAlert } from "../src/long/schemas.js";

const alert: LongAlert = { id: "alert-1", kind: "failure_loop", severity: "high", status: "open", identity_key: "failure:repeat", reason_code: "repeat", message: "Same test failed", first_sequence: 4, last_sequence: 8, occurrence_count: 4, evidence_event_ids: ["e1"], raised_at: "2026-09-22T12:00:00.000Z", updated_at: "2026-09-22T12:00:00.000Z" };
const dashboard: LongDashboard = { sessionId: "jvlng_0123456789abcdef", sequence: 8, activity: "active", progress: 0.5, signals: { stall_score: 0.1, failure_score: 0.8, drift_score: 0, budget_risk: 0.3 }, openToolCalls: 1, cost: { wall_ms: 1000, provider_tokens: 200, tool_calls: 4 }, alerts: [alert], lastEventAt: "2026-09-22T12:00:00.000Z" };

describe("JevLong TUI", () => {
  it("renders a visual dashboard with boxes, bars, risk labels, alerts and timeline", () => {
    const output = renderLongDashboard(dashboard, { width: 86, color: false, timeline: ["tool_started npm test", "test_result failed"] });
    expect(output).toContain("JEVLONG"); expect(output).toContain("RISK"); expect(output).toContain("PROGRESS"); expect(output).toContain("ATTENTION");
    expect(output).toContain("Same test failed"); expect(output).toContain("█"); expect(output).toContain("test_result failed"); expect(output).not.toContain("\x1b[");
    expect(output).toContain("watching · Ctrl-C to exit");
    expect(output.split("\n").filter((line) => line.startsWith("┌") || line.startsWith("│") || line.startsWith("└") || line.startsWith("╔") || line.startsWith("║") || line.startsWith("╚")).every((line) => line.length === 86)).toBe(true);
  });
  it("uses question marks for unknown progress instead of inventing zero", () => {
    const output = renderLongDashboard({ ...dashboard, progress: "unknown", alerts: [] }, { width: 80, color: false });
    expect(output).toContain("UNKNOWN"); expect(output).toContain("?"); expect(output).toContain("no open alerts");
  });
  it("maps status data into a TUI dashboard", () => {
    const value = dashboardFromStatus({ store: { spec: { session_id: dashboard.sessionId }, snapshot: { sequence: 8, last_event_at: dashboard.lastEventAt } }, signals: { ...dashboard.signals, activity: dashboard.activity, progress_index: dashboard.progress, open_tool_calls: dashboard.openToolCalls, cost: dashboard.cost, evidence_event_ids: {} }, policy: { alerts: dashboard.alerts } });
    expect(value).toMatchObject({ sessionId: dashboard.sessionId, sequence: 8, openToolCalls: 1, progress: 0.5 });
  });
  it("watch accepts zero iterations without touching the store", async () => {
    const frames: string[] = []; let sleeps = 0;
    await expect(watchLong("missing", { iterations: 0, onFrame: (frame) => { frames.push(frame); }, sleep: async () => { sleeps += 1; } })).resolves.toBeUndefined();
    expect(frames).toHaveLength(0); expect(sleeps).toBe(0);
  });
  it("renders the interactive cockpit as a fixed viewport with layered panes", () => {
    const output = renderLongTui({
      title: "Parser session", goal: "Improve parser throughput", dashboard,
      sessions: [{ directory: ".jevrev/parser", title: "Parser session", sessionId: dashboard.sessionId, activity: "active", progress: 0.5, openAlerts: 1, lastEventAt: dashboard.lastEventAt }],
      events: [{ sequence: 8, at: dashboard.lastEventAt!, type: "test_result", summary: "npm test failed", source: "imported" }],
      alerts: [alert], evidence: ["failure · evt-1"], tab: "overview", focus: "sessions", selectedSession: 0, selectedItem: 0,
    }, { width: 96, height: 20, color: false });
    const lines = output.split("\r\n");
    expect(lines).toHaveLength(20); expect(lines.every((line) => line.length === 96)).toBe(true);
    expect(output).toContain("SESSIONS"); expect(output).toContain("OVERVIEW"); expect(output).toContain("ATTENTION");
    expect(output).toContain("1–4"); expect(output).not.toContain("╔"); expect(output).not.toContain("╚");
  });
  it("summarizes event payloads for the activity pane", () => {
    expect(longEventSummary({ event_type: "file_change", payload: { data: { operation: "modify", path: "src/parser.ts" } }, source: "imported", sequence: 3, received_at: "2026-09-22T12:00:00.000Z" })).toMatchObject({ type: "file_change", summary: "modify src/parser.ts" });
  });
});
