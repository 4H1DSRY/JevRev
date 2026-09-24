import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCommand, recordCommand } from "../src/evidence/recorder.js";
import { buildCampaign } from "../src/workflow/campaign.js";
import { evidenceBundleSchema, type EvidenceBundle } from "../src/workflow/schemas.js";
import { buildQuestionPlan } from "../src/questions.js";
import { rankCandidates } from "../src/policy.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

const root = resolve(import.meta.dirname, "..");
const temporaryFiles: string[] = [];

afterEach(() => {
  for (const path of temporaryFiles.splice(0)) rmSync(path, { force: true });
});

function fixture() {
  const request = structuredClone(minimalRequest);
  const plan = buildQuestionPlan(request);
  const campaign = buildCampaign(request, rankCandidates(request, makeResponse(plan)));
  const workOrder = campaign.work_orders[0]!;
  const bundle: EvidenceBundle = {
    kind: "jevrev.evidence-bundle",
    schema_version: "1",
    campaign_id: campaign.campaign_id,
    packets: [{
      kind: "jevrev.evidence-packet",
      schema_version: "1",
      campaign_id: campaign.campaign_id,
      candidate_id: workOrder.candidate_id,
      candidate_sha256: workOrder.candidate_sha256,
      revision: { base_commit: "base" },
      development: { status: "not_started", wall_ms: 0 },
      observations: [],
      metrics: [],
      requirement_results: [
        { criterion_id: "speed", kind: "success", status: "unknown", observation_ids: [], metric_ids: [] },
        { criterion_id: "api", kind: "constraint", status: "unknown", observation_ids: [], metric_ids: [] },
      ],
      probe_results: workOrder.required_evidence.map((evidence) => ({
        evidence_id: evidence.id,
        status: "unknown",
        observation_ids: [],
        metric_ids: [],
      })),
      artifacts: [],
      artifact_evaluations: [],
      changed_files: [],
      known_failures: ["TEMPLATE: replace with evidence"],
    }],
  };
  const path = resolve(root, "tests", `tmp-recorder-${Math.random().toString(16).slice(2)}.json`);
  temporaryFiles.push(path);
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { campaign, workOrder, path };
}

describe("trusted evidence command recorder", () => {
  it("records direct argv, hashes output, and links real exit status", async () => {
    const { workOrder, path } = fixture();
    const recorded = await recordCommand({
      evidencePath: path,
      candidateId: workOrder.candidate_id,
      observationId: "tests",
      argv: [process.execPath, "-e", "process.stdout.write('ok')"],
      workspace: root,
      cwd: ".",
      probeIds: ["probe-1"],
      requirementRefs: ["success:speed", "constraint:api"],
      complete: true,
      echo: false,
    });
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const packet = bundle.packets[0]!;
    const observation = packet.observations[0]!;

    expect(recorded.exit_code).toBe(0);
    expect(recorded.termination).toBe("exited");
    expect(observation.argv).toEqual([process.execPath, "-e", "process.stdout.write('ok')"]);
    expect(observation.cwd).toBe(".");
    expect(observation.stdout_sha256).toBe(createHash("sha256").update("ok").digest("hex"));
    expect(observation.stdout_bytes).toBe(2);
    expect(packet.development.status).toBe("completed");
    expect(packet.requirement_results.every((result) => result.status === "pass")).toBe(true);
    expect(packet.probe_results[0]?.status).toBe("pass");
    expect(packet.known_failures).toEqual([]);
  });

  it("records a failing command as failed linked evidence without failing the recorder", async () => {
    const { workOrder, path } = fixture();
    const recorded = await recordCommand({
      evidencePath: path,
      candidateId: workOrder.candidate_id,
      observationId: "tests",
      argv: [process.execPath, "-e", "process.exit(7)"],
      workspace: root,
      probeIds: ["probe-1"],
      requirementRefs: ["constraint:api"],
      echo: false,
    });
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")));

    expect(recorded.exit_code).toBe(7);
    expect(bundle.packets[0]?.probe_results[0]?.status).toBe("fail");
    expect(bundle.packets[0]?.requirement_results.find((item) => item.criterion_id === "api")?.status)
      .toBe("fail");
  });

  it("does not pass Jev credentials to recorded commands", async () => {
    const { workOrder, path } = fixture();
    const previous = process.env.JEVREV_JEV_API_KEY;
    process.env.JEVREV_JEV_API_KEY = "must-not-reach-child";
    try {
      const recorded = await recordCommand({
        evidencePath: path,
        candidateId: workOrder.candidate_id,
        observationId: "env-check",
        argv: [process.execPath, "-e", "process.exit(process.env.JEVREV_JEV_API_KEY ? 9 : 0)"],
        workspace: root,
        echo: false,
      });
      expect(recorded.exit_code).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.JEVREV_JEV_API_KEY;
      else process.env.JEVREV_JEV_API_KEY = previous;
    }
  });

  it("keeps child output quiet unless echo is explicitly enabled", async () => {
    const { workOrder, path } = fixture();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await recordCommand({
        evidencePath: path,
        candidateId: workOrder.candidate_id,
        observationId: "quiet-default",
        argv: [process.execPath, "-e", "process.stdout.write('secret-value')"],
        workspace: root,
      });
      expect(writeSpy).not.toHaveBeenCalledWith(expect.stringContaining("secret-value"));
      await recordCommand({
        evidencePath: path,
        candidateId: workOrder.candidate_id,
        observationId: "explicit-echo",
        argv: [process.execPath, "-e", "process.stdout.write('debug-value')"],
        workspace: root,
        echo: true,
      });
      expect(writeSpy.mock.calls.some(([value]) => Buffer.isBuffer(value) && value.toString("utf8") === "debug-value")).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("refuses duplicate observation IDs and cwd escapes", async () => {
    const { workOrder, path } = fixture();
    const options = {
      evidencePath: path,
      candidateId: workOrder.candidate_id,
      observationId: "same-id",
      argv: [process.execPath, "-e", ""],
      workspace: root,
      echo: false,
    };
    await recordCommand(options);
    await expect(recordCommand(options)).rejects.toThrow("Observation already exists");
    await expect(recordCommand({ ...options, observationId: "escape", cwd: ".." }))
      .rejects.toThrow("escapes workspace");
  });

  it("replaces command wall time by delta instead of double-counting", async () => {
    const { workOrder, path } = fixture();
    const options = {
      evidencePath: path, candidateId: workOrder.candidate_id, observationId: "replace-me",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 25)"], workspace: root, echo: false,
    };
    const first = await recordCommand(options);
    const second = await recordCommand({ ...options, argv: [process.execPath, "-e", "process.exit(0)"], replace: true });
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(bundle.packets[0]?.development.wall_ms).toBe(second.duration_ms);
    expect(first.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("runs the npm PowerShell shim on Windows without enabling shell parsing", async () => {
    if (process.platform !== "win32") return;
    const recorded = await executeCommand({ argv: ["npm", "--version"], workspace: root, echo: false });
    expect(recorded.argv[0]).toMatch(/powershell\.exe$/i);
    expect(recorded.termination).toBe("exited");
    expect(recorded.exit_code).toBe(0);
    expect(recorded.stdout_bytes).toBeGreaterThan(0);
  });

  it("preserves an explicit executable path in the recorded invocation", async () => {
    const command = process.platform === "win32" ? "C:\\missing\\npm.cmd" : "/missing/npm";
    const recorded = await executeCommand({ argv: [command, "--version"], workspace: root, echo: false });
    expect(recorded.argv[0]).toBe(command);
    expect(recorded.termination).toBe("spawn_error");
  });

  it("serializes concurrent command updates without losing observations", async () => {
    const { workOrder, path } = fixture();
    await Promise.all([
      recordCommand({ evidencePath: path, candidateId: workOrder.candidate_id, observationId: "parallel-a", argv: [process.execPath, "-e", "setTimeout(() => {}, 30)"], workspace: root }),
      recordCommand({ evidencePath: path, candidateId: workOrder.candidate_id, observationId: "parallel-b", argv: [process.execPath, "-e", "setTimeout(() => {}, 30)"], workspace: root }),
    ]);
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(bundle.packets[0]?.observations.map((item) => item.id)).toEqual(expect.arrayContaining(["parallel-a", "parallel-b"]));
  });
});
