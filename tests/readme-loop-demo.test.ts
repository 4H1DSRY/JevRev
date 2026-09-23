import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

it("records the README Loop trace and completes only after fresh verification", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "jevrev-readme-loop-"));
  try {
    const run = spawnSync(process.execPath, [join(root, "scripts", "run-loop-demo.mjs"), "--output-dir", outputDir], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const { head_revision, trace } = JSON.parse(readFileSync(join(outputDir, "trace.json"), "utf8"));
    expect(head_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(trace.map(({ outcome }: { outcome: string }) => outcome)).toEqual(["continue", "verify", "completed"]);
    expect(trace.map(({ status }: { status: string }) => status)).toEqual(["ready", "completion_pending", "completed"]);
    expect(trace[0].recorded_commands.map(({ id }: { id: string }) => id)).toEqual(["correctness"]);
    expect(trace[2].mode).toBe("completion");

    for (const round of [1, 2, 3]) {
      const evidence = JSON.parse(readFileSync(join(outputDir, `evidence-${round}.json`), "utf8"));
      expect(evidence.head_revision).toBe(head_revision);
      expect(evidence.observations.every(({ source, exit_code }: { source: string; exit_code: number }) => source === "recorded" && exit_code === 0)).toBe(true);
      expect(evidence.observations.every(({ stdout_sha256 }: { stdout_sha256: string }) => /^[a-f0-9]{64}$/.test(stdout_sha256))).toBe(true);
      if (round === 3) {
        expect(evidence.observations).toHaveLength(2);
        expect(evidence.criterion_results.every(({ status, freshness, source_round }: { status: string; freshness: string; source_round: number }) => status === "pass" && freshness === "fresh" && source_round === 3)).toBe(true);
      }
    }
    const events = readFileSync(join(outputDir, "loop", "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter(({ payload }: { payload: { type: string } }) => payload.type === "ROUND_AUDITED").map(({ payload }: { payload: { result: { outcome: string } } }) => payload.result.outcome)).toEqual(["continue", "verify", "completed"]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 25_000);
