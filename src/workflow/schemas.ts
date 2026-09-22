import { z } from "zod";
import { candidateSchema, rankRequestSchema, rankResultSchema } from "../domain/schemas.js";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must use lowercase letters, digits, _ or -");

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");
const boundedText = z.string().trim().min(1).max(2_000);
const repositoryPath = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value), "must be repository-relative")
  .refine(
    (value) => !value.split(/[\\/]+/).includes(".."),
    "must not escape the repository",
  );

export const probeBudgetSchema = z
  .object({
    max_wall_ms: z.number().int().positive().max(86_400_000),
    max_changed_files: z.number().int().positive().max(1_000),
  })
  .strict();

export const workOrderSchema = z
  .object({
    candidate_id: id,
    candidate_sha256: sha256,
    hypothesis: boundedText,
    probe_instruction: boundedText,
    required_evidence: z
      .array(
        z.object({ id, description: boundedText }).strict(),
      )
      .min(1)
      .max(12),
    budget: probeBudgetSchema,
    stop_conditions: z.array(boundedText).min(1).max(12),
  })
  .strict();

export const campaignSchema = z
  .object({
    kind: z.literal("jevrev.campaign"),
    schema_version: z.literal("1"),
    campaign_id: z.string().regex(/^jvc_[a-f0-9]{12}$/),
    request: rankRequestSchema,
    sift: rankResultSchema,
    work_orders: z.array(workOrderSchema).max(5),
    review_work_orders: z.array(workOrderSchema).max(5).default([]),
  })
  .strict()
  .superRefine((campaign, context) => {
    const candidates = new Map(
      campaign.request.candidates.map((candidate) => [candidate.id, candidate]),
    );
    const workOrderIds = campaign.work_orders.map((workOrder) => workOrder.candidate_id);
    const reviewWorkOrderIds = campaign.review_work_orders.map((workOrder) => workOrder.candidate_id);
    if (new Set(workOrderIds).size !== workOrderIds.length) {
      context.addIssue({
        code: "custom",
        path: ["work_orders"],
        message: "work-order candidate IDs must be unique",
      });
    }
    if (new Set(reviewWorkOrderIds).size !== reviewWorkOrderIds.length || reviewWorkOrderIds.some((id) => workOrderIds.includes(id))) {
      context.addIssue({ code: "custom", path: ["review_work_orders"], message: "review work-order candidate IDs must be unique and separate from strict work orders" });
    }
    if (workOrderIds.length + reviewWorkOrderIds.length > 5) {
      context.addIssue({ code: "custom", path: ["review_work_orders"], message: "combined probe work orders cannot exceed five" });
    }
    if (
      campaign.sift.selected.length !== workOrderIds.length ||
      campaign.sift.selected.some((candidateId, index) => candidateId !== workOrderIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["work_orders"],
        message: "work orders must match sift.selected in order",
      });
    }
    for (const [index, workOrder] of campaign.work_orders.entries()) {
      if (!candidates.has(workOrder.candidate_id)) {
        context.addIssue({
          code: "custom",
          path: ["work_orders", index, "candidate_id"],
          message: "must reference a request candidate",
        });
      }
    }
    for (const [index, workOrder] of campaign.review_work_orders.entries()) {
      const candidate = candidates.get(workOrder.candidate_id);
      const siftDecision = campaign.sift.decisions.find((decision) => decision.candidate_id === workOrder.candidate_id);
      if (candidate === undefined) {
        context.addIssue({ code: "custom", path: ["review_work_orders", index, "candidate_id"], message: "must reference a request candidate" });
      } else if (siftDecision?.status !== "review") {
        context.addIssue({ code: "custom", path: ["review_work_orders", index, "candidate_id"], message: "must reference a Sift review candidate" });
      }
    }
  });

export const commandObservationSchema = z
  .object({
    id,
    kind: z.literal("command"),
    cwd: repositoryPath.optional(),
    argv: z
      .array(z.string().max(1_000))
      .min(1)
      .max(64)
      .refine((argv) => argv[0] !== undefined && argv[0].length > 0, "executable cannot be empty"),
    exit_code: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    required: z.boolean(),
    stdout_sha256: sha256.optional(),
    stderr_sha256: sha256.optional(),
    termination: z.enum(["exited", "timed_out", "spawn_error", "buffer_exceeded"]).optional(),
    signal: z.string().min(1).max(64).optional(),
    stdout_bytes: z.number().int().nonnegative().optional(),
    stderr_bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const metricObservationSchema = z
  .object({
    id,
    kind: z.literal("metric"),
    criterion_id: id,
    unit: z.string().trim().min(1).max(64),
    direction: z.enum(["higher", "lower"]),
    baseline_samples: z.array(z.number().finite()).min(2).max(1_000),
    candidate_samples: z.array(z.number().finite()).min(2).max(1_000),
  })
  .strict();

export const artifactSchema = z
  .object({
    id,
    path: repositoryPath,
    media_type: z.string().trim().min(1).max(128),
    sha256,
    size_bytes: z.number().int().nonnegative(),
    content_excerpt: z.string().max(4_000).optional(),
  })
  .strict();

export const artifactEvaluationSchema = z
  .object({
    id,
    source: z.literal("imported"),
    evaluator: z.string().trim().min(1).max(256),
    artifact_ids: z.array(id).min(1).max(32),
    criterion_id: id.optional(),
    status: z.enum(["pass", "fail", "unknown"]),
    score: z.number().min(0).max(1).optional(),
    summary: z.string().trim().min(1).max(2_000),
    output_sha256: sha256.optional(),
  })
  .strict();

export const requirementResultSchema = z
  .object({
    criterion_id: id,
    kind: z.enum(["success", "constraint"]),
    status: z.enum(["pass", "fail", "unknown"]),
    observation_ids: z.array(id).max(64),
    metric_ids: z.array(id).max(64),
    artifact_evaluation_ids: z.array(id).max(64).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.status === "pass" &&
      result.observation_ids.length === 0 &&
      result.metric_ids.length === 0 &&
      (result.artifact_evaluation_ids?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "a passing requirement must cite an observation or metric",
      });
    }
  });

export const probeResultSchema = z
  .object({
    evidence_id: id,
    status: z.enum(["pass", "fail", "unknown"]),
    observation_ids: z.array(id).max(64),
    metric_ids: z.array(id).max(64),
    artifact_evaluation_ids: z.array(id).max(64).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.status === "pass" &&
      result.observation_ids.length === 0 &&
      result.metric_ids.length === 0 &&
      (result.artifact_evaluation_ids?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "passing probe evidence must cite an observation or metric",
      });
    }
  });

export const evidencePacketSchema = z
  .object({
    kind: z.literal("jevrev.evidence-packet"),
    schema_version: z.literal("1"),
    campaign_id: z.string().regex(/^jvc_[a-f0-9]{12}$/),
    candidate_id: id,
    candidate_sha256: sha256,
    revision: z
      .object({
        base_commit: z.string().trim().min(1).max(256),
        head_commit: z.string().trim().min(1).max(256).optional(),
        diff_sha256: sha256.optional(),
      })
      .strict(),
    development: z
      .object({
        status: z.enum(["not_started", "completed", "failed", "stopped"]),
        wall_ms: z.number().int().nonnegative(),
        tokens: z.number().int().nonnegative().optional(),
        cost_usd: z.number().nonnegative().optional(),
      })
      .strict(),
    observations: z.array(commandObservationSchema).max(128),
    metrics: z.array(metricObservationSchema).max(64),
    requirement_results: z.array(requirementResultSchema).max(64),
    probe_results: z.array(probeResultSchema).max(64),
    artifacts: z.array(artifactSchema).max(64).optional(),
    artifact_evaluations: z.array(artifactEvaluationSchema).max(64).optional(),
    changed_files: z.array(repositoryPath).max(1_000),
    known_failures: z.array(boundedText).max(64),
    builder_notes: z.string().trim().max(8_000).optional(),
  })
  .strict()
  .superRefine((packet, context) => {
    const observationIds = packet.observations.map((observation) => observation.id);
    const metricIds = packet.metrics.map((metric) => metric.id);
    const requirementIds = packet.requirement_results.map(
      (requirement) => `${requirement.kind}:${requirement.criterion_id}`,
    );
    const probeIds = packet.probe_results.map((result) => result.evidence_id);
    const artifactIds = (packet.artifacts ?? []).map((artifact) => artifact.id);
    const artifactEvaluationIds = (packet.artifact_evaluations ?? []).map(
      (evaluation) => evaluation.id,
    );
    if (new Set(observationIds).size !== observationIds.length) {
      context.addIssue({
        code: "custom",
        path: ["observations"],
        message: "observation IDs must be unique",
      });
    }
    if (new Set(metricIds).size !== metricIds.length) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "metric IDs must be unique",
      });
    }
    if (new Set(requirementIds).size !== requirementIds.length) {
      context.addIssue({
        code: "custom",
        path: ["requirement_results"],
        message: "requirement results must be unique by kind and criterion",
      });
    }
    if (new Set(probeIds).size !== probeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["probe_results"],
        message: "probe results must have unique evidence IDs",
      });
    }
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "artifact IDs must be unique",
      });
    }
    if (new Set(artifactEvaluationIds).size !== artifactEvaluationIds.length) {
      context.addIssue({
        code: "custom",
        path: ["artifact_evaluations"],
        message: "artifact evaluation IDs must be unique",
      });
    }

    const knownObservations = new Set(observationIds);
    const knownMetrics = new Set(metricIds);
    const knownArtifactEvaluations = new Set(artifactEvaluationIds);
    packet.requirement_results.forEach((result, index) => {
      result.observation_ids.forEach((reference) => {
        if (!knownObservations.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["requirement_results", index, "observation_ids"],
            message: `unknown observation ID: ${reference}`,
          });
        }
      });
      result.metric_ids.forEach((reference) => {
        if (!knownMetrics.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["requirement_results", index, "metric_ids"],
            message: `unknown metric ID: ${reference}`,
          });
        }
      });
      (result.artifact_evaluation_ids ?? []).forEach((reference) => {
        if (!knownArtifactEvaluations.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["requirement_results", index, "artifact_evaluation_ids"],
            message: `unknown artifact evaluation ID: ${reference}`,
          });
        }
      });
    });
    packet.probe_results.forEach((result, index) => {
      result.observation_ids.forEach((reference) => {
        if (!knownObservations.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["probe_results", index, "observation_ids"],
            message: `unknown observation ID: ${reference}`,
          });
        }
      });
      result.metric_ids.forEach((reference) => {
        if (!knownMetrics.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["probe_results", index, "metric_ids"],
            message: `unknown metric ID: ${reference}`,
          });
        }
      });
      (result.artifact_evaluation_ids ?? []).forEach((reference) => {
        if (!knownArtifactEvaluations.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["probe_results", index, "artifact_evaluation_ids"],
            message: `unknown artifact evaluation ID: ${reference}`,
          });
        }
      });
    });
    const knownArtifacts = new Set(artifactIds);
    (packet.artifact_evaluations ?? []).forEach((evaluation, index) => {
      evaluation.artifact_ids.forEach((reference) => {
        if (!knownArtifacts.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["artifact_evaluations", index, "artifact_ids"],
            message: `unknown artifact ID: ${reference}`,
          });
        }
      });
    });
  });

export const evidenceBundleSchema = z
  .object({
    kind: z.literal("jevrev.evidence-bundle"),
    schema_version: z.literal("1"),
    campaign_id: z.string().regex(/^jvc_[a-f0-9]{12}$/),
    packets: z.array(evidencePacketSchema).max(5),
  })
  .strict()
  .superRefine((bundle, context) => {
    const candidateIds = bundle.packets.map((packet) => packet.candidate_id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        path: ["packets"],
        message: "evidence packets must have unique candidate IDs",
      });
    }
    bundle.packets.forEach((packet, index) => {
      if (packet.campaign_id !== bundle.campaign_id) {
        context.addIssue({
          code: "custom",
          path: ["packets", index, "campaign_id"],
          message: "must match bundle campaign_id",
        });
      }
    });
  });

export const decideReasonCodeSchema = z.enum([
  "MISSING_EVIDENCE",
  "DEVELOPMENT_FAILED",
  "DEVELOPMENT_STOPPED",
  "DEVELOPMENT_NOT_STARTED",
  "MISSING_REQUIRED_COMMAND",
  "REQUIRED_COMMAND_FAILED",
  "MISSING_REQUIREMENT",
  "REQUIREMENT_FAILED",
  "MISSING_PROBE_EVIDENCE",
  "PROBE_EVIDENCE_FAILED",
  "MISSING_ARTIFACT_EVALUATION",
  "ARTIFACT_EVALUATION_FAILED",
  "WALL_BUDGET_EXCEEDED",
  "FILE_BUDGET_EXCEEDED",
  "LOW_EVIDENCE_SUPPORT",
  "LOW_REPRODUCIBILITY",
  "HIGH_RESIDUAL_RISK",
  "LOW_SHIPPING_VALUE",
  "LOW_CONFIDENCE",
  "CLOSE_RESULT",
  "OBJECTIVELY_DOMINATED",
]);

export const metricSummarySchema = z
  .object({
    metric_id: id,
    criterion_id: id,
    unit: z.string().min(1),
    direction: z.enum(["higher", "lower"]),
    sample_count: z.object({ baseline: z.number().int().min(2), candidate: z.number().int().min(2) }).strict(),
    baseline_mean: z.number().finite(),
    candidate_mean: z.number().finite(),
    baseline_sample_sd: z.number().finite().nonnegative(),
    candidate_sample_sd: z.number().finite().nonnegative(),
    relative_improvement: z.number().finite().nullable(),
  })
  .strict();

export const decideResultSchema = z
  .object({
    kind: z.literal("jevrev.decide-result"),
    schema_version: z.literal("1"),
    campaign_id: z.string().regex(/^jvc_[a-f0-9]{12}$/),
    decision: z.enum(["winner", "merge", "probe_more", "no_winner", "human_review"]),
    winner: id.nullable(),
    merge_candidates: z.array(id).max(2),
    eligible: z.array(id),
    evaluations: z.array(
      z
        .object({
          candidate_id: id,
          status: z.enum(["eligible", "rejected", "incomplete", "review"]),
          score: z.number().min(0).max(1).nullable(),
          confidence: z.number().min(0).max(1).nullable(),
          reasons: z.array(decideReasonCodeSchema),
          objective: z
            .object({
              required_commands_passed: z.boolean(),
              requirements_complete: z.boolean(),
              within_budget: z.boolean(),
              metrics: z.array(metricSummarySchema),
            })
            .strict(),
          semantic: z
            .object({
              evidence_support: z.number().min(0).max(1),
              reproducibility: z.number().min(0).max(1),
              residual_risk_acceptance: z.number().min(0).max(1),
              shipping_value: z.number().min(0).max(1),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    next_action: z
      .object({
        type: z.enum([
          "integrate_winner",
          "probe_combination",
          "collect_evidence",
          "revise_ideas",
          "ask_human",
        ]),
        candidate_ids: z.array(id),
      })
      .strict(),
    audit: z
      .object({
        policy: z.literal("decide-v1"),
        provider_profile: z.string().min(1),
        campaign_sha256: sha256,
        evidence_sha256: sha256,
        usage: z
          .object({
            input_tokens: z.number().int().nonnegative(),
            output_tokens: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    const issue = (message: string): void => {
      context.addIssue({ code: "custom", path: ["decision"], message });
    };
    if (result.decision === "winner") {
      if (
        result.winner === null ||
        result.merge_candidates.length !== 0 ||
        result.next_action.type !== "integrate_winner" ||
        result.next_action.candidate_ids.length !== 1 ||
        result.next_action.candidate_ids[0] !== result.winner
      ) {
        issue("winner must name exactly one matching integrate_winner candidate");
      }
    } else if (result.decision === "merge") {
      if (
        result.winner !== null ||
        result.merge_candidates.length !== 2 ||
        result.next_action.type !== "probe_combination" ||
        result.next_action.candidate_ids.join("\0") !== result.merge_candidates.join("\0")
      ) {
        issue("merge must name exactly two matching probe_combination candidates");
      }
    } else {
      if (result.winner !== null || result.merge_candidates.length !== 0) {
        issue(`${result.decision} cannot name a winner or merge candidates`);
      }
      const expected = result.decision === "probe_more"
        ? "collect_evidence"
        : result.decision === "no_winner"
          ? "revise_ideas"
          : "ask_human";
      if (result.next_action.type !== expected) {
        issue(`${result.decision} requires next_action ${expected}`);
      }
    }
  });

export type Campaign = z.infer<typeof campaignSchema>;
export type WorkOrder = z.infer<typeof workOrderSchema>;
export type EvidencePacket = z.infer<typeof evidencePacketSchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type MetricObservation = z.infer<typeof metricObservationSchema>;
export type RequirementResult = z.infer<typeof requirementResultSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;
export type DecideResult = z.infer<typeof decideResultSchema>;
export type DecideReasonCode = z.infer<typeof decideReasonCodeSchema>;
export type MetricSummary = z.infer<typeof metricSummarySchema>;
