import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCampaign } from "../src/workflow/campaign.js";
import { evidenceBundleSchema } from "../src/workflow/schemas.js";
import { prepareDecision } from "../src/workflow/evidence.js";
import { decideCampaign } from "../src/workflow/decide.js";
import { buildQuestionPlan } from "../src/questions.js";
import { rankCandidates } from "../src/policy.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts", "create-evidence-template.mjs");

describe("evidence template handoff", () => {
  it("creates a schema-valid but explicitly incomplete bundle", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    const plan = buildQuestionPlan(request);
    const campaign = buildCampaign(request, rankCandidates(request, makeResponse(plan)));
    const campaignPath = resolve(root, "tests", "tmp-template-campaign.json");
    writeFileSync(campaignPath, `${JSON.stringify(campaign)}\n`, "utf8");

    try {
      const result = spawnSync(process.execPath, [
        script,
        "--campaign", campaignPath,
        "--base-commit", "abc123",
      ], { cwd: root, encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const bundle = evidenceBundleSchema.parse(JSON.parse(result.stdout));
      expect(bundle.packets).toHaveLength(campaign.work_orders.length);
      expect(bundle.packets.every((packet) => packet.development.status === "not_started")).toBe(true);
      expect(bundle.packets.every((packet) => packet.observations.length === 0)).toBe(true);
      expect(bundle.packets.flatMap((packet) => packet.probe_results)
        .every((probe) => probe.status === "unknown")).toBe(true);
      expect(bundle.packets.flatMap((packet) => packet.known_failures).join(" "))
        .toContain("TEMPLATE");
      const decision = decideCampaign(prepareDecision(campaign, bundle), undefined);
      expect(decision.decision).toBe("probe_more");
      expect(decision.next_action.type).toBe("collect_evidence");
    } finally {
      rmSync(campaignPath, { force: true });
    }
  });
});
