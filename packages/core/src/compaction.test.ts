import { describe, expect, it } from "vitest";

import {
  defaultContextCompactor,
  defaultRuntimeLimits,
  type ContextSnapshot,
} from "./index.js";

const snapshot: ContextSnapshot = {
  instructions: "Stay deterministic.",
  messages: [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
  ],
  estimatedTokens: 120_000,
};

describe("defaultContextCompactor", () => {
  it("compacts deterministically only over the input-token hard limit", async () => {
    expect(
      defaultContextCompactor.shouldCompact(snapshot, defaultRuntimeLimits),
    ).toBe(true);
    expect(
      defaultContextCompactor.shouldCompact(
        { ...snapshot, estimatedTokens: 100_000 },
        defaultRuntimeLimits,
      ),
    ).toBe(false);

    const first = await defaultContextCompactor.compact(snapshot);
    const second = await defaultContextCompactor.compact(snapshot);
    expect(first).toEqual(second);
    expect(first.summary).toEqual({
      kind: "deterministic_truncation",
      removedMessages: 2,
      sourceEstimatedTokens: 120_000,
    });
    expect(first.messages).toEqual([
      { role: "system", content: first.summary },
      { role: "user", content: "three" },
      { role: "assistant", content: "four" },
    ]);
  });
});
