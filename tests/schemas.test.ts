import { describe, expect, it } from "vitest";
import { rankRequestSchema } from "../src/domain/schemas.js";
import { minimalRequest } from "./fixtures.js";

describe("rankRequestSchema", () => {
  it("accepts the smallest useful request", () => {
    expect(rankRequestSchema.parse(minimalRequest)).toEqual(minimalRequest);
  });

  it("rejects duplicate candidate IDs", () => {
    const invalid = structuredClone(minimalRequest);
    invalid.candidates[1]!.id = invalid.candidates[0]!.id;

    expect(() => rankRequestSchema.parse(invalid)).toThrow(/unique/);
  });

  it("rejects a survivor budget larger than the candidate set", () => {
    const invalid = structuredClone(minimalRequest);
    invalid.budget.max_survivors = 3;

    expect(() => rankRequestSchema.parse(invalid)).toThrow(/cannot exceed/);
  });

  it("rejects candidates without a falsifiable validation plan", () => {
    const invalid = structuredClone(minimalRequest) as unknown as Record<string, unknown>;
    const candidates = invalid.candidates as Array<Record<string, unknown>>;
    candidates[0]!.validation = [];

    expect(() => rankRequestSchema.parse(invalid)).toThrow();
  });
});
