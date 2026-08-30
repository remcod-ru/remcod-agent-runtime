import { describe, expect, it } from "vitest";

import {
  RuntimeErrorSchema,
  SessionSchema,
  StepSchema,
  TurnSchema,
  createId,
} from "../src/index.js";

const createdAt = "2026-08-30T09:00:00.000Z";

describe("protocol records", () => {
  it("validates IDs, UTC time, versions, records and typed errors fail closed", () => {
    const agentId = createId("AgentId", "agent-1");
    const sessionId = createId("SessionId", "session-1");
    const turnId = createId("TurnId", "turn-1");

    expect(
      SessionSchema.parse({
        id: sessionId,
        protocolVersion: "1",
        agentId,
        status: "idle",
        createdAt,
        updatedAt: createdAt,
        version: 0,
        lastEventCursor: 0,
      }).id,
    ).toBe(sessionId);
    expect(
      TurnSchema.safeParse({
        id: turnId,
        sessionId,
        status: "queued",
        input: { prompt: "hello" },
        createdAt,
        updatedAt: createdAt,
      }).success,
    ).toBe(true);
    expect(
      StepSchema.safeParse({
        id: createId("StepId", "step-1"),
        sessionId,
        turnId,
        index: 0,
        kind: "model",
        status: "failed",
        error: {
          code: "PROVIDER_FAILED",
          message: "provider unavailable",
          retryable: true,
        },
      }).success,
    ).toBe(true);

    expect(() => createId("SessionId", " ")).toThrow();
    expect(
      SessionSchema.safeParse({
        id: "",
        protocolVersion: "2",
        agentId,
        status: "idle",
        createdAt: "2026-08-30T14:00:00+05:00",
        updatedAt: createdAt,
        version: -1,
        lastEventCursor: -1,
      }).success,
    ).toBe(false);
    expect(
      RuntimeErrorSchema.safeParse({
        code: "UNKNOWN",
        message: "not closed",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});
