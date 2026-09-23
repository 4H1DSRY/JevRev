import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const cli = resolve(root, "src", "cli.ts");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const spec = {
  kind: "jevrev.long-spec", schema_version: "1", revision: 1, session_id: "jvlng_5555555555555555", title: "CLI", goal: "Observe", workspace: ".", allowed_scope: ["src"], protected_surfaces: [], milestones: [],
  budget: { max_wall_ms: 10000, max_provider_tokens: 100, max_tool_calls: 10 }, thresholds: { stall_after_ms: 1000, heartbeat_after_ms: 100, repeated_failure_window: 1000, repeated_failure_count: 2, drift_warning_score: 0.5, budget_warning_fraction: 0.8, max_clock_skew_ms: 1000 }, alert_policy: { cooldown_ms: 100, max_open_alerts: 4, max_alert_history: 20, severity_escalation_window: 1000 }, observer_budget: { provider: "none", max_calls: 0, max_tokens: 0, max_wall_ms: 0, timeout_ms: 1000, min_interval_ms: 100, max_context_bytes: 1000 },
};

function run(args: string[]) { return spawnSync(process.execPath, [tsx, cli, ...args], { cwd: root, encoding: "utf8" }); }

describe("JevLong CLI", () => {
  it("creates and reports a deterministic observer session", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jevrev-long-cli-")); roots.push(rootDir);
    const specPath = join(rootDir, "spec.json"); const directory = join(rootDir, "long"); writeFileSync(specPath, JSON.stringify(spec));
    const created = run(["long", "create", "--directory", directory, "--spec", specPath, "--format", "json"]);
    expect(created.status).toBe(0);
    const status = run(["long", "status", "--directory", directory, "--format", "json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ snapshot: { sequence: 0 }, signals: { progress_index: "unknown" } });
    const invalidWatch = run(["long", "watch", "--directory", directory, "--iterations", "0", "--no-clear"]);
    expect(invalidWatch.status).toBe(2);
    expect(invalidWatch.stderr).toContain("must be a positive integer");
  }, 20_000);
});
