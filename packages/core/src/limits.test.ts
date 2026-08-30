import { describe, expect, it } from "vitest";

import {
  InvalidRuntimeLimitError,
  defaultRuntimeLimits,
  resolveRuntimeLimits,
} from "./index.js";

describe("runtime limits", () => {
  it("provides immutable defaults and rejects every invalid hard-limit override", () => {
    expect(defaultRuntimeLimits).toEqual({
      maxSteps: 32,
      maxModelCalls: 16,
      maxToolCalls: 64,
      maxInputTokens: 100_000,
      maxOutputTokens: 16_000,
    });
    expect(Object.isFrozen(defaultRuntimeLimits)).toBe(true);
    expect(resolveRuntimeLimits({ maxSteps: 0 })).toEqual({
      ...defaultRuntimeLimits,
      maxSteps: 0,
    });

    for (const [name, value] of [
      ["maxSteps", -1],
      ["maxModelCalls", 1.5],
      ["maxToolCalls", Number.NaN],
      ["maxInputTokens", Number.POSITIVE_INFINITY],
      ["maxOutputTokens", -2],
    ] as const) {
      expect(() => resolveRuntimeLimits({ [name]: value })).toThrow(
        InvalidRuntimeLimitError,
      );
    }
  });
});
