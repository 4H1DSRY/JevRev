import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must use lowercase letters, digits, _ or -");

const shortText = z.string().trim().min(1).max(300);

const criterionSchema = z
  .object({
    id,
    text: z.string().trim().min(1).max(500),
  })
  .strict();

const constraintSchema = criterionSchema
  .extend({
    kind: z.enum(["hard", "soft"]),
  })
  .strict();

export const candidateSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(600),
    mechanism: z.string().trim().min(1).max(1_500),
    assumptions: z.array(shortText).min(1).max(8),
    risks: z.array(shortText).min(1).max(8),
    validation: z.array(shortText).min(1).max(8),
    effort: z.enum(["small", "medium", "large"]),
  })
  .strict();

export const rankRequestSchema = z
  .object({
    version: z.literal("1"),
    task: z
      .object({
        goal: z.string().trim().min(1).max(1_000),
        context: z.string().trim().max(4_000).optional(),
        constraints: z.array(constraintSchema).max(12),
        success: z.array(criterionSchema).min(1).max(12),
      })
      .strict(),
    budget: z
      .object({
        max_survivors: z.number().int().min(1).max(5),
      })
      .strict(),
    candidates: z.array(candidateSchema).min(2).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    const candidateIds = value.candidates.map((candidate) => candidate.id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "candidate IDs must be unique",
      });
    }

    const criterionIds = [
      ...value.task.constraints.map((criterion) => criterion.id),
      ...value.task.success.map((criterion) => criterion.id),
    ];
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["task"],
        message: "constraint and success IDs must be unique",
      });
    }

    if (value.budget.max_survivors > value.candidates.length) {
      context.addIssue({
        code: "custom",
        path: ["budget", "max_survivors"],
        message: "cannot exceed the number of candidates",
      });
    }

    if (JSON.stringify(value).length > 32_000) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "serialized request must not exceed 32,000 characters",
      });
    }
  });

export const noulAnswerSchema = z
  .object({
    type: z.literal("noul"),
    noul: z.number().min(0).max(1),
  })
  .strict();

export const scoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.number().min(0),
    confidence: z.number().min(0).max(1),
    legend: z.record(z.string(), z.unknown()),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
  })
  .strict();

export const judgeAnswerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  scoreAnswerSchema,
]);

export const judgeResponseSchema = z
  .object({
    model: z.string().min(1),
    answers: z.record(z.string(), judgeAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const reasonSchema = z
  .object({
    code: z.enum([
      "GOAL_MISMATCH",
      "CONSTRAINT_RISK",
      "LOW_FEASIBILITY",
      "WEAK_VALIDATION",
      "LOW_EXECUTION_VALUE",
      "LOW_CONFIDENCE",
      "DUPLICATE_CANDIDATE",
      "BUDGET_CUTOFF",
    ]),
    related_candidate_id: id.optional(),
  })
  .strict();

export const rankResultSchema = z
  .object({
    version: z.literal("1"),
    // `spj_` is accepted so captured SpecJev v0.1 responses remain readable;
    // new runs use the JevRev prefix.
    run_id: z.union([z.string().startsWith("jvr_"), z.string().startsWith("spj_")]),
    model: z.string().min(1),
    policy: z
      .object({
        name: z.literal("default-v1"),
        max_survivors: z.number().int().min(1),
        thresholds: z.record(z.string(), z.number()),
        weights: z.record(z.string(), z.number()),
        effort_multipliers: z.record(z.string(), z.number()),
      })
      .strict(),
    summary: z
      .object({
        evaluated: z.number().int().nonnegative(),
        kept: z.number().int().nonnegative(),
        shortlisted: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
      })
      .strict(),
    selected: z.array(id),
    shortlist: z.array(id),
    decisions: z.array(
      z
        .object({
          candidate_id: id,
          title: z.string().min(1),
          status: z.enum(["keep", "review", "reject"]),
          rank: z.number().int().positive(),
          score: z.number().min(0).max(1),
          confidence: z.number().min(0).max(1),
          signals: z
            .object({
              goal_fit: z.number().min(0).max(1),
              constraint_fit: z.number().min(0).max(1),
              feasibility: z.number().min(0).max(1),
              validation_quality: z.number().min(0).max(1),
              execution_value: z.number().min(0).max(1),
            })
            .strict(),
          reasons: z.array(reasonSchema),
        })
        .strict(),
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type RankRequest = z.infer<typeof rankRequestSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type JudgeAnswer = z.infer<typeof judgeAnswerSchema>;
export type JudgeResponse = z.infer<typeof judgeResponseSchema>;
export type RankResult = z.infer<typeof rankResultSchema>;
export type DecisionReason = z.infer<typeof reasonSchema>;
