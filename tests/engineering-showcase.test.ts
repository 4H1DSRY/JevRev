import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { loadLoop } from "../src/loop/store.js";
import { loadLongStore } from "../src/long/store.js";

const root = resolve(import.meta.dirname, "..");

it("audits a real repair, fresh completion, and verified read-only observation", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "jevrev-engineering-case-"));
  try {
    const run = spawnSync(process.execPath, [join(root, "scripts", "run-engineering-showcase.mjs"), "--output-dir", outputDir], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const trace = JSON.parse(readFileSync(join(outputDir, "trace.json"), "utf8"));
    expect(trace.rounds.map(({ outcome }: { outcome: string }) => outcome)).toEqual(["fix_regression", "verify", "completed"]);
    expect(trace.rounds[0].checks.map(({ passed }: { passed: boolean }) => passed)).toEqual([false, false, true]);
    expect(trace.rounds[1].checks.every(({ passed }: { passed: boolean }) => passed)).toBe(true);
    expect(trace.rounds[2].checks.every(({ passed }: { passed: boolean }) => passed)).toBe(true);
    expect(trace.rounds[0].source_revision).not.toBe(trace.rounds[1].source_revision);
    expect(trace.rounds[1].source_revision).toBe(trace.rounds[2].source_revision);
    expect(trace.tampered_bridge_rejected).toBe(true);
    expect(trace.duplicate_bridge_suppressed).toBe(true);

    for (const round of [1, 2, 3]) {
      const evidence = JSON.parse(readFileSync(join(outputDir, `evidence-${round}.json`), "utf8"));
      expect(evidence.observations).toHaveLength(3);
      expect(evidence.observations.every(({ source, stdout_sha256 }: { source: string; stdout_sha256: string }) => source === "recorded" && /^[a-f0-9]{64}$/.test(stdout_sha256))).toBe(true);
      expect(evidence.criterion_results.every(({ source_round, freshness }: { source_round: number; freshness: string }) => source_round === round && freshness === "fresh")).toBe(true);
    }
    const loopEvents = readFileSync(join(outputDir, "loop", "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const longEvents = readFileSync(join(outputDir, "long", "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(loopEvents).toHaveLength(7);
    expect(longEvents).toHaveLength(3);
    expect(longEvents.map(({ payload }) => payload.payload.data.audit_outcome)).toEqual(["fix_regression", "verify", "completed"]);
    expect(loopEvents.at(-1).event_sha256).toBe(trace.loop_event_head_sha256);
    expect(longEvents.at(-1).event_sha256).toBe(trace.long_event_head_sha256);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 35_000);

it("serves live developer replays backed by the same source as the captured audit", async () => {
  const server = spawn(process.execPath, [join(root, "scripts", "serve-engineering-showcase.mjs")], {
    cwd: root, env: { ...process.env, JEVREV_ENGINEERING_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error("Workbench server did not start")), 10_000);
      server.stdout?.on("data", (chunk: Buffer) => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) { clearTimeout(timer); resolveUrl(match[0]); }
      });
      server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Workbench exited: ${code}`)); });
    });
    const response = await fetch(`${url}api/replay`);
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      source_sha256: Record<string, string>;
      scenarios: Record<string, Record<string, { passed: boolean; calls?: number; deliveries?: { observed: string }[] }>>;
      audit: { outcomes: string[]; long_events: number; tamper_rejected: boolean; replay_deduplicated: boolean };
    };
    expect(payload.scenarios.baseline?.tenant?.deliveries?.[1]?.observed).toBe("north:accepted");
    expect(payload.scenarios.repaired?.tenant?.deliveries?.[1]?.observed).toBe("south:accepted");
    expect(payload.scenarios.baseline?.race?.calls).toBe(2);
    expect(payload.scenarios.repaired?.race?.calls).toBe(1);
    expect(payload.scenarios.baseline?.retry?.passed).toBe(true);
    expect(payload.audit.outcomes).toEqual(["fix_regression", "verify", "completed"]);
    expect(payload.audit.long_events).toBe(3);
    expect(payload.audit.tamper_rejected && payload.audit.replay_deduplicated).toBe(true);
    const capture = JSON.parse(readFileSync(join(root, "benchmarks", "engineering-showcase", "capture", "trace.json"), "utf8"));
    const captureDirectory = join(root, "benchmarks", "engineering-showcase", "capture");
    const archivedLoop = await loadLoop(join(captureDirectory, "loop"));
    const archivedLong = await loadLongStore(join(captureDirectory, "long"));
    expect(archivedLoop.state.status).toBe("completed");
    expect(archivedLoop.events.at(-1)?.event_sha256).toBe(capture.loop_event_head_sha256);
    expect(archivedLong.snapshot.last_event_sha256).toBe(capture.long_event_head_sha256);
    expect(archivedLong.events).toHaveLength(3);
    const hash = (filename: string) => createHash("sha256").update(readFileSync(join(root, "benchmarks", "engineering-showcase", filename))).digest("hex");
    expect(payload.source_sha256.baseline).toBe(hash("baseline.mjs"));
    expect(payload.source_sha256.repaired).toBe(hash("repaired.mjs"));
    expect(capture.baseline_revision).toBe(`sha256:${payload.source_sha256.baseline}`);
    expect(capture.rounds[2].source_revision).toBe(`sha256:${payload.source_sha256.repaired}`);
    expect((await fetch(url)).status).toBe(200);
  } finally {
    server.kill();
  }
}, 15_000);
