import { describe, expect, it } from "vitest";

import { EventTypeSchema, RuntimeEventSchema, createId } from "../src/index.js";

const occurredAt = "2026-08-30T09:00:00.000Z";
const sessionId = createId("SessionId", "session-1");
const turnId = createId("TurnId", "turn-1");
const stepId = createId("StepId", "step-1");
const toolCallId = createId("ToolCallId", "call-1");
const runtimeError = {
  code: "PROVIDER_FAILED",
  message: "provider unavailable",
  retryable: true,
} as const;
const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
const session = {
  id: sessionId,
  protocolVersion: "1",
  agentId: createId("AgentId", "agent-1"),
  status: "running",
  createdAt: occurredAt,
  updatedAt: occurredAt,
  version: 1,
  lastEventCursor: 0,
} as const;
const turn = {
  id: turnId,
  sessionId,
  status: "running",
  input: "hello",
  createdAt: occurredAt,
  updatedAt: occurredAt,
} as const;
const step = {
  id: stepId,
  sessionId,
  turnId,
  index: 0,
  kind: "model",
  status: "running",
} as const;

const dataByType = {
  "session.created": { session },
  "session.status_changed": { from: "idle", to: "running" },
  "turn.created": { turn },
  "turn.status_changed": { from: "queued", to: "running" },
  "step.started": { step },
  "step.completed": { output: "done", usage },
  "step.failed": { error: runtimeError },
  "step.cancelled": { reason: "cancelled by caller" },
  "model.requested": { providerId: "scripted", model: "test", attempt: 1 },
  "model.completed": { responseKind: "message", usage },
  "model.failed": { error: runtimeError, attempt: 1 },
  "tool.requested": {
    call: { id: toolCallId, name: "lookup", input: { key: "value" } },
    idempotencyKey: "session-1/turn-1/call-1",
  },
  "tool.started": { toolCallId, toolName: "lookup" },
  "tool.completed": { toolCallId, output: { found: true } },
  "tool.failed": { toolCallId, error: runtimeError },
  "context.compacted": {
    beforeTokens: 100,
    afterTokens: 25,
    summary: "summary",
  },
  "input.requested": { requestId: "input-1", prompt: "Continue?" },
  "input.received": { requestId: "input-1", value: true },
  "session.completed": { output: "done" },
  "session.failed": { error: runtimeError },
  "session.cancelled": { reason: "cancelled by caller" },
} as const;

describe("runtime event union", () => {
  it("accepts every v1 event and rejects unknown or mismatched type/data", () => {
    expect(Object.keys(dataByType).sort()).toEqual(
      [...EventTypeSchema.options].sort(),
    );

    let cursor = 1;
    for (const [type, data] of Object.entries(dataByType)) {
      expect(
        RuntimeEventSchema.safeParse({
          protocolVersion: "1",
          id: createId("EventId", `event-${cursor}`),
          cursor,
          type,
          sessionId,
          turnId,
          stepId,
          correlationId: "correlation-1",
          occurredAt,
          data,
        }).success,
        type,
      ).toBe(true);
      cursor += 1;
    }

    const envelope = {
      protocolVersion: "1",
      id: createId("EventId", "event-invalid"),
      cursor: 1,
      sessionId,
      correlationId: "correlation-1",
      occurredAt,
    };
    expect(
      RuntimeEventSchema.safeParse({
        ...envelope,
        type: "step.completed",
        data: { error: runtimeError },
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventSchema.safeParse({
        ...envelope,
        type: "future.event",
        data: {},
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventSchema.safeParse({
        ...envelope,
        type: "session.status_changed",
        data: { from: "completed", to: "running" },
      }).success,
    ).toBe(false);
  });

  it("requires a concrete turn and step for step cancellation", () => {
    const cancelled = {
      protocolVersion: "1",
      id: createId("EventId", "event-cancelled"),
      cursor: 1,
      type: "step.cancelled",
      sessionId,
      turnId,
      stepId,
      correlationId: "correlation-1",
      occurredAt,
      data: { reason: "cancelled by caller" },
    };

    expect(RuntimeEventSchema.safeParse(cancelled).success).toBe(true);
    expect(
      RuntimeEventSchema.safeParse({ ...cancelled, stepId: undefined }).success,
    ).toBe(false);
    expect(
      RuntimeEventSchema.safeParse({ ...cancelled, turnId: undefined }).success,
    ).toBe(false);
  });

  it("keeps terminal session payloads event-specific and strict", () => {
    const terminalEnvelope = {
      protocolVersion: "1",
      id: createId("EventId", "event-terminal"),
      cursor: 1,
      sessionId,
      correlationId: "correlation-1",
      occurredAt,
    };

    expect(
      RuntimeEventSchema.safeParse({
        ...terminalEnvelope,
        type: "session.completed",
        data: { error: runtimeError },
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventSchema.safeParse({
        ...terminalEnvelope,
        type: "session.failed",
        data: {},
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventSchema.safeParse({
        ...terminalEnvelope,
        type: "session.cancelled",
        data: { output: "not allowed" },
      }).success,
    ).toBe(false);
  });
});
