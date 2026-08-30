import { describe, expect, it } from "vitest";

import { runBasicAgent } from "./index.js";

describe("basic external SDK consumer", () => {
  it("runs a scripted model to a tool result and terminal message", async () => {
    const result = await runBasicAgent();

    expect(result.output).toEqual({ answer: 42 });
    expect(result.modelRequestCount).toBe(2);
    expect(result.secondRequestMessages).toContainEqual({
      role: "tool",
      toolCallId: "call-add",
      content: 42,
    });
    expect(result.eventTypes).toContain("tool.completed");
    expect(result.eventTypes.at(-1)).toBe("session.completed");
  });
});
