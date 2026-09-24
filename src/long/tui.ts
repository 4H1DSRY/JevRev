import type { LongAlert } from "./schemas.js";
import type { SignalResult } from "./signals.js";

export interface LongDashboard {
  sessionId: string;
  sequence: number;
  activity: SignalResult["activity"];
  progress: number | "unknown";
  signals: Pick<SignalResult, "stall_score" | "failure_score" | "drift_score" | "budget_risk">;
  openToolCalls: number;
  cost: SignalResult["cost"];
  alerts: readonly LongAlert[];
  lastEventAt: string | null;
}

export interface TuiOptions { width?: number; color?: boolean; timeline?: readonly string[] }

const ANSI = { reset: "\x1b[0m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", blue: "\x1b[34m", dim: "\x1b[2m" } as const;
function paint(text: string, color: keyof typeof ANSI, enabled: boolean): string { return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text; }
function bar(value: number | "unknown", width: number): string {
  if (value === "unknown") return `[${"?".repeat(Math.max(1, width - 2))}]`;
  const inner = Math.max(1, width - 2); const filled = Math.round(Math.max(0, Math.min(1, value)) * inner);
  return `[${"█".repeat(filled)}${"░".repeat(inner - filled)}]`;
}
function risk(value: number, color: boolean): string {
  const label = value >= 0.8 ? "HIGH" : value >= 0.45 ? "MED" : "LOW";
  return paint(`${label} ${value.toFixed(2)}`, value >= 0.8 ? "red" : value >= 0.45 ? "yellow" : "green", color);
}
const ANSI_CODES = /\x1b\[[0-9;]*m/g;
function pad(text: string, width: number): string {
  const visible = text.replace(ANSI_CODES, "");
  if (visible.length >= width) return visible.slice(0, width);
  return text + " ".repeat(width - visible.length);
}
function box(title: string, body: readonly string[], width: number): string[] {
  const inner = Math.max(10, width - 2); const line = `┌${"─".repeat(inner)}┐`;
  return [line, `│${pad(` ${title}`, inner)}│`, ...body.map((item) => `│${pad(` ${item}`, inner)}│`), `└${"─".repeat(inner)}┘`];
}

export function dashboardFromStatus(status: { store: { spec: { session_id: string }; snapshot: { sequence: number; last_event_at: string | null } }; signals: SignalResult; policy: { alerts: readonly LongAlert[] } }): LongDashboard {
  return { sessionId: status.store.spec.session_id, sequence: status.store.snapshot.sequence, activity: status.signals.activity, progress: status.signals.progress_index, signals: { stall_score: status.signals.stall_score, failure_score: status.signals.failure_score, drift_score: status.signals.drift_score, budget_risk: status.signals.budget_risk }, openToolCalls: status.signals.open_tool_calls, cost: status.signals.cost, alerts: status.policy.alerts, lastEventAt: status.store.snapshot.last_event_at };
}

export function renderLongWatchSummary(dashboard: LongDashboard): string {
  const open = dashboard.alerts.filter((alert) => alert.status === "open" || alert.status === "acknowledged");
  const progress = dashboard.progress === "unknown" ? "unknown" : `${Math.round(dashboard.progress * 100)}%`;
  const lines = [
    `JevLong ${dashboard.sessionId} seq=${dashboard.sequence} ${dashboard.activity} progress=${progress} alerts=${open.length} tools=${dashboard.openToolCalls} tokens=${dashboard.cost.provider_tokens}`,
    `risk stall=${dashboard.signals.stall_score.toFixed(2)} failure=${dashboard.signals.failure_score.toFixed(2)} drift=${dashboard.signals.drift_score.toFixed(2)} budget=${dashboard.signals.budget_risk.toFixed(2)}`,
  ];
  for (const alert of open.slice(0, 2)) {
    lines.push(`${alert.severity} ${alert.kind}: ${alert.message.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  if (open.length > 2) lines.push(`+${open.length - 2} more alerts`);
  return `${lines.join("\n")}\n`;
}

export function renderLongDashboard(dashboard: LongDashboard, options: TuiOptions = {}): string {
  const width = Math.max(64, options.width ?? 100); const color = options.color ?? false;
  const open = dashboard.alerts.filter((alert) => alert.status === "open" || alert.status === "acknowledged");
  const alertLines = open.length === 0 ? [paint("✓ no open alerts", "green", color)] : open.slice(0, 5).map((alert) => `${paint(alert.severity.toUpperCase().padEnd(8), alert.severity === "critical" ? "red" : alert.severity === "high" ? "yellow" : "blue", color)} ${alert.message} ×${alert.occurrence_count}`);
  const riskLines = [
    `STALL    ${risk(dashboard.signals.stall_score, color)}`,
    `FAILURE  ${risk(dashboard.signals.failure_score, color)}`,
    `DRIFT    ${risk(dashboard.signals.drift_score, color)}`,
    `BUDGET   ${risk(dashboard.signals.budget_risk, color)}`,
  ];
  const timeline = (options.timeline ?? []).slice(-5).map((line) => `• ${line}`);
  const lines = [
    `╔${"═".repeat(width - 2)}╗`,
    `║ ${pad(`JEVLONG  ${dashboard.activity.toUpperCase()}  ·  ${dashboard.sessionId}  ·  seq ${dashboard.sequence}`, width - 3)}║`,
    `╠${"═".repeat(width - 2)}╣`,
    ...box("RISK", riskLines, width),
    ...box("PROGRESS", [`${bar(dashboard.progress, Math.max(20, width - 20))}  ${dashboard.progress === "unknown" ? "UNKNOWN" : `${Math.round(dashboard.progress * 100)}%`}`], width),
    `╠${"═".repeat(width - 2)}╣`,
    `║ ${pad(`ALERTS  ${open.length} open   TOOLS  ${dashboard.openToolCalls} open   TOKENS  ${dashboard.cost.provider_tokens}`, width - 3)}║`,
    `╠${"═".repeat(width - 2)}╣`,
    `║ ${pad("ATTENTION", width - 3)}║`,
    ...alertLines.map((line) => `║ ${pad(line, width - 3)}║`),
    `╠${"═".repeat(width - 2)}╣`,
    `║ ${pad("RECENT EVENTS", width - 3)}║`,
    ...(timeline.length ? timeline.map((line) => `║ ${pad(line, width - 3)}║`) : [`║ ${pad("• no timeline events supplied", width - 3)}║`]),
    `╚${"═".repeat(width - 2)}╝`,
    paint("watching · Ctrl-C to exit", "dim", color),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The interactive view is deliberately a viewport, not a log. Every row is
 * clipped/padded to the terminal width and the caller replaces the alternate
 * screen in place. This prevents long-running sessions from growing a scroll
 * buffer or wrapping a card into a second line.
 */
export type LongTuiTab = "overview" | "activity" | "alerts" | "evidence";
export type LongTuiFocus = "sessions" | "main" | "attention";

export interface LongTuiSession {
  directory: string;
  title: string;
  sessionId: string;
  activity: LongDashboard["activity"];
  progress: LongDashboard["progress"];
  openAlerts: number;
  lastEventAt: string | null;
}

export interface LongTuiEvent {
  sequence: number;
  at: string;
  type: string;
  summary: string;
  source: string;
}

export interface LongTuiModel {
  title: string;
  goal: string;
  dashboard: LongDashboard;
  sessions: readonly LongTuiSession[];
  events: readonly LongTuiEvent[];
  alerts: readonly LongAlert[];
  evidence: readonly string[];
  tab: LongTuiTab;
  focus: LongTuiFocus;
  selectedSession: number;
  selectedItem: number;
}

export interface LongTuiRenderOptions {
  width?: number;
  height?: number;
  color?: boolean;
}

const SOFT_ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", blue: "\x1b[34m",
  magenta: "\x1b[35m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", gray: "\x1b[90m",
} as const;
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

function softPaint(text: string, tone: keyof typeof SOFT_ANSI, enabled: boolean): string {
  return enabled ? `${SOFT_ANSI[tone]}${text}${SOFT_ANSI.reset}` : text;
}

function visibleText(text: string): string { return text.replace(ANSI_SEQUENCE, ""); }

function viewportText(text: string, width: number): string {
  const visible = visibleText(text);
  if (visible.length >= width) return visible.slice(0, width);
  return `${text}${" ".repeat(width - visible.length)}`;
}

function separator(width: number, color: boolean): string {
  return softPaint("─".repeat(width), "gray", color);
}

function percent(value: number | "unknown"): string {
  return value === "unknown" ? "??" : `${Math.round(value * 100)}%`;
}

function slimBar(value: number | "unknown", width: number, color: boolean): string {
  const inner = Math.max(4, width - 2);
  if (value === "unknown") return softPaint(`[${"·".repeat(inner)}]`, "gray", color);
  const filled = Math.round(Math.max(0, Math.min(1, value)) * inner);
  return `${softPaint("[", "gray", color)}${softPaint("━".repeat(filled), "cyan", color)}${softPaint("─".repeat(inner - filled), "gray", color)}${softPaint("]", "gray", color)}`;
}

function activityTone(activity: LongDashboard["activity"]): keyof typeof SOFT_ANSI {
  return activity === "active" ? "green" : activity === "quiet" ? "yellow" : "gray";
}

function severityTone(severity: LongAlert["severity"]): keyof typeof SOFT_ANSI {
  return severity === "critical" ? "red" : severity === "high" ? "yellow" : severity === "notice" ? "magenta" : "cyan";
}

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 19) : date.toISOString().slice(11, 19);
}

function columnWidths(width: number): [number, number, number] {
  const gaps = 4;
  const usable = Math.max(36, width - gaps);
  const left = Math.max(18, Math.floor(usable * 0.23));
  const right = Math.max(20, Math.floor(usable * 0.25));
  return [left, Math.max(10, usable - left - right), right];
}

function columns(left: string, center: string, right: string, widths: [number, number, number], color: boolean): string {
  return `${viewportText(left, widths[0])}  ${viewportText(center, widths[1])}  ${viewportText(right, widths[2])}`;
}

function tabLabel(tab: LongTuiTab, active: LongTuiTab, color: boolean): string {
  const labels: Record<LongTuiTab, string> = { overview: "1 Overview", activity: "2 Activity", alerts: "3 Alerts", evidence: "4 Evidence" };
  return softPaint(labels[tab], tab === active ? "cyan" : "gray", color);
}

function mainRows(model: LongTuiModel, width: number, color: boolean): string[] {
  const rows: string[] = [];
  if (model.tab === "overview") {
    rows.push(softPaint("OVERVIEW", "bold", color));
    rows.push(`goal       ${model.goal}`);
    rows.push(`progress   ${slimBar(model.dashboard.progress, Math.max(18, width - 18), color)} ${percent(model.dashboard.progress)}`);
    rows.push(`activity   ${softPaint(`● ${model.dashboard.activity}`, activityTone(model.dashboard.activity), color)}`);
    rows.push(`stall      ${model.dashboard.signals.stall_score.toFixed(2)}    failure ${model.dashboard.signals.failure_score.toFixed(2)}`);
    rows.push(`drift      ${model.dashboard.signals.drift_score.toFixed(2)}    budget  ${model.dashboard.signals.budget_risk.toFixed(2)}`);
    rows.push(`tools      ${model.dashboard.openToolCalls} open`);
  } else if (model.tab === "activity") {
    rows.push(softPaint("ACTIVITY", "bold", color));
    if (model.events.length === 0) rows.push(softPaint("No events yet", "gray", color));
    for (const [index, event] of model.events.entries()) {
      const marker = index === model.selectedItem && model.focus === "main" ? softPaint("›", "cyan", color) : " ";
      rows.push(`${marker} ${String(event.sequence).padStart(3, " ")} ${shortTime(event.at)} ${event.type.padEnd(18, " ")} ${event.summary}`);
    }
  } else if (model.tab === "alerts") {
    rows.push(softPaint("ALERTS", "bold", color));
    if (model.alerts.length === 0) rows.push(softPaint("✓ No open alerts", "green", color));
    for (const [index, alert] of model.alerts.entries()) {
      const marker = index === model.selectedItem && model.focus === "main" ? softPaint("›", "cyan", color) : " ";
      rows.push(`${marker} ${softPaint(alert.severity.toUpperCase().padEnd(8), severityTone(alert.severity), color)} ${alert.message}`);
    }
  } else {
    rows.push(softPaint("EVIDENCE", "bold", color));
    if (model.evidence.length === 0) rows.push(softPaint("No evidence recorded", "gray", color));
    for (const [index, item] of model.evidence.entries()) {
      const marker = index === model.selectedItem && model.focus === "main" ? softPaint("›", "cyan", color) : " ";
      rows.push(`${marker} ${item}`);
    }
  }
  return rows;
}

function attentionRows(model: LongTuiModel, color: boolean): string[] {
  const rows = [softPaint("ATTENTION", "bold", color), `${model.alerts.length} open alert${model.alerts.length === 1 ? "" : "s"}`];
  for (const alert of model.alerts.slice(0, 4)) rows.push(`${softPaint("●", severityTone(alert.severity), color)} ${alert.message}`);
  if (model.alerts.length === 0) rows.push(softPaint("quiet · no action needed", "green", color));
  return rows;
}

function eventRows(model: LongTuiModel, color: boolean): string[] {
  const rows = [softPaint("RECENT", "bold", color)];
  for (const event of model.events.slice(-4)) rows.push(`${shortTime(event.at)}  ${event.type}`);
  return rows;
}

/** Render a complete fixed-size viewport. It never emits a trailing newline. */
export function renderLongTui(model: LongTuiModel, options: LongTuiRenderOptions = {}): string {
  const width = Math.max(40, options.width ?? 100);
  const height = Math.max(12, options.height ?? 24);
  const color = options.color ?? false;
  const [leftWidth, centerWidth, rightWidth] = columnWidths(width);
  const lines: string[] = [];
  const session = model.sessions[model.selectedSession] ?? model.sessions[0];
  const activeTitle = session?.title ?? model.title;
  lines.push(viewportText(`${softPaint("JEVREV", "cyan", color)}  ${softPaint("LONG", "magenta", color)}   ${softPaint("●", activityTone(model.dashboard.activity), color)} ${model.dashboard.activity.toUpperCase()}   ${activeTitle}`, width));
  lines.push(viewportText(`${softPaint("session", "gray", color)} ${model.dashboard.sessionId}   ${softPaint("events", "gray", color)} ${model.dashboard.sequence}   ${softPaint("goal", "gray", color)} ${model.goal}`, width));
  lines.push(separator(width, color));
  lines.push(viewportText(`${tabLabel("overview", model.tab, color)}    ${tabLabel("activity", model.tab, color)}    ${tabLabel("alerts", model.tab, color)}    ${tabLabel("evidence", model.tab, color)}`, width));
  lines.push(separator(width, color));

  const leftRows: string[] = [softPaint(`SESSIONS  ${model.sessions.length}`, "bold", color)];
  for (const [index, item] of model.sessions.entries()) {
    const marker = index === model.selectedSession && model.focus === "sessions" ? softPaint("›", "cyan", color) : " ";
    leftRows.push(`${marker} ${softPaint("●", activityTone(item.activity), color)} ${item.title}`);
    leftRows.push(`   ${item.activity} · ${item.openAlerts} alert${item.openAlerts === 1 ? "" : "s"}`);
  }
  const centerRows = mainRows(model, centerWidth, color);
  const rightRows = [...attentionRows(model, color), "", ...eventRows(model, color)];
  const bodyRows = Math.max(4, height - 9);
  for (let index = 0; index < bodyRows; index += 1) {
    lines.push(columns(leftRows[index] ?? "", centerRows[index] ?? "", rightRows[index] ?? "", [leftWidth, centerWidth, rightWidth], color));
  }
  lines.push(separator(width, color));
  lines.push(viewportText(`${softPaint("↑↓ / j k", "cyan", color)} select   ${softPaint("Tab", "cyan", color)} pane   ${softPaint("1–4", "cyan", color)} view   ${softPaint("r", "cyan", color)} refresh   ${softPaint("q", "cyan", color)} quit`, width));
  while (lines.length < height) lines.push(" ".repeat(width));
  return lines.slice(0, height).map((line) => viewportText(line, width)).join("\r\n");
}

export function longEventSummary(event: { event_type: string; payload: { data?: Record<string, unknown> | undefined }; source: string; sequence: number; received_at: string }): LongTuiEvent {
  const data = event.payload.data ?? {};
  const value = (key: string): string => typeof data[key] === "string" ? data[key] as string : "";
  let summary = event.event_type.replace(/_/g, " ");
  if (event.event_type === "tool_started") summary = `${value("tool") || "tool"} started`;
  else if (event.event_type === "tool_finished") summary = `${value("tool") || "tool"} finished`;
  else if (event.event_type === "test_result") summary = `${value("command_id") || "test"} ${value("status") || "reported"}`;
  else if (event.event_type === "file_change") summary = `${value("operation") || "changed"} ${value("path") || "file"}`;
  else if (event.event_type === "milestone") summary = `${value("milestone_id") || "milestone"} ${value("status") || "reported"}`;
  else if (event.event_type === "metric") summary = `${value("name") || "metric"} reported`;
  return { sequence: event.sequence, at: event.received_at, type: event.event_type, summary, source: event.source };
}
