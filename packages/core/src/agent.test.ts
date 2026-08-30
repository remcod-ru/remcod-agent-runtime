import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";

import { defineTool } from "@remcod/tools";

import {
  InvalidRuntimeLimitError,
  defineAgent,
  type AgentDefinition,
  type RuntimeLimits,
} from "./index.js";

describe("defineAgent", () => {
  it("preserves structured-output inference, runtime schema, and every hard limit", () => {
    const outputSchema = z.object({ answer: z.string() });
    const tool = defineTool({
      name: "lookup",
      description: "Looks up an integer",
      inputSchema: z.object({ id: z.number().int() }),
      outputSchema: z.object({ found: z.boolean() }),
      risk: "read",
      timeoutMs: 1_000,
      execute: async () => ({ found: true }),
    });
    const agent = defineAgent({
      id: "answerer",
      name: "Answerer",
      instructions: "Answer with JSON.",
      model: { providerId: "scripted", model: "test-model" },
      tools: [tool],
      outputSchema,
      limits: {
        maxSteps: 6,
        maxModelCalls: 5,
        maxToolCalls: 4,
        maxInputTokens: 3_000,
        maxOutputTokens: 2_000,
      },
    });

    expectTypeOf(agent).toMatchTypeOf<AgentDefinition<{ answer: string }>>();
    expect(agent.outputSchema).toBe(outputSchema);
    expect(agent.limits).toEqual({
      maxSteps: 6,
      maxModelCalls: 5,
      maxToolCalls: 4,
      maxInputTokens: 3_000,
      maxOutputTokens: 2_000,
    });
  });

  it("normalizes supplied limits and rejects every invalid value publicly", () => {
    const validLimits: RuntimeLimits = {
      maxSteps: 5,
      maxModelCalls: 4,
      maxToolCalls: 3,
      maxInputTokens: 2_000,
      maxOutputTokens: 1_000,
    };
    const valid = defineAgent({
      id: "bounded",
      name: "Bounded agent",
      instructions: "Stay within limits.",
      model: { providerId: "scripted", model: "test-model" },
      limits: validLimits,
    });

    expect(valid.limits).not.toBe(validLimits);
    expect(Object.isFrozen(valid.limits)).toBe(true);

    for (const [name, value] of [
      ["maxSteps", -1],
      ["maxModelCalls", 1.5],
      ["maxToolCalls", Number.NaN],
      ["maxInputTokens", Number.POSITIVE_INFINITY],
      ["maxOutputTokens", -2],
    ] as const) {
      expect(() =>
        defineAgent({
          id: "invalid-bounds",
          name: "Invalid bounds",
          instructions: "Fixture.",
          model: { providerId: "scripted", model: "test-model" },
          limits: { ...validLimits, [name]: value },
        }),
      ).toThrow(InvalidRuntimeLimitError);
    }
  });
});
