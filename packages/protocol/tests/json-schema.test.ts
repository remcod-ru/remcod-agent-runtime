import { describe, expect, it } from "vitest";
import { z } from "zod";

import canonicalSchemas from "./fixtures/protocol-v1.json" with { type: "json" };
import {
  RuntimeEventSchema,
  SessionSchema,
  SessionStatusSchema,
  TurnStatusSchema,
  canTransitionSession,
  canTransitionTurn,
  createId,
  generateProtocolJsonSchemas,
} from "../src/index.js";

const occurredAt = "2026-08-30T09:00:00.000Z";
const sessionId = createId("SessionId", "session-1");
const turnId = createId("TurnId", "turn-1");
const stepId = createId("StepId", "step-1");

const sessionFixture = {
  id: sessionId,
  protocolVersion: "1",
  agentId: createId("AgentId", "agent-1"),
  status: "running",
  createdAt: occurredAt,
  updatedAt: occurredAt,
  version: 1,
  lastEventCursor: 0,
};

const cancelledEventFixture = {
  protocolVersion: "1",
  id: createId("EventId", "event-1"),
  cursor: 1,
  type: "step.cancelled",
  sessionId,
  turnId,
  stepId,
  correlationId: "correlation-1",
  occurredAt,
  data: { reason: "cancelled by caller" },
};

describe("protocol JSON Schema", () => {
  it("matches the full canonical snapshot and round-trips fixtures", () => {
    expect(generateProtocolJsonSchemas()).toEqual(canonicalSchemas);

    const sessionFromJsonSchema = z.fromJSONSchema(
      canonicalSchemas.session as unknown as z.core.JSONSchema.JSONSchema,
    );
    const eventFromJsonSchema = z.fromJSONSchema(
      canonicalSchemas.runtimeEvent as unknown as z.core.JSONSchema.JSONSchema,
    );

    const sessionValidators = [SessionSchema, sessionFromJsonSchema] as const;
    for (const validator of sessionValidators) {
      expect(validator.safeParse(sessionFixture).success).toBe(true);
      for (const [label, invalidSession] of [
        ["id", { ...sessionFixture, id: "" }],
        ["protocol", { ...sessionFixture, protocolVersion: "2" }],
        [
          "UTC time",
          { ...sessionFixture, createdAt: "2026-08-30T14:00:00+05:00" },
        ],
        ["version", { ...sessionFixture, version: -1 }],
        ["cursor", { ...sessionFixture, lastEventCursor: -1 }],
      ] as const) {
        expect(validator.safeParse(invalidSession).success, label).toBe(false);
      }
    }
    expect(eventFromJsonSchema.safeParse(cancelledEventFixture).success).toBe(
      true,
    );
    expect(
      eventFromJsonSchema.safeParse({
        ...cancelledEventFixture,
        stepId: undefined,
      }).success,
    ).toBe(false);
    expect(
      eventFromJsonSchema.safeParse({
        ...cancelledEventFixture,
        data: { error: { code: "UNKNOWN" } },
      }).success,
    ).toBe(false);
  });

  it("preserves transition and terminal semantics structurally", () => {
    const eventFromJsonSchema = z.fromJSONSchema(
      canonicalSchemas.runtimeEvent as unknown as z.core.JSONSchema.JSONSchema,
    );
    const envelope = {
      protocolVersion: "1",
      id: createId("EventId", "event-transition"),
      cursor: 1,
      sessionId,
      turnId,
      correlationId: "correlation-1",
      occurredAt,
    };
    const validators = [RuntimeEventSchema, eventFromJsonSchema] as const;

    for (const [states, type, canTransition] of [
      [
        SessionStatusSchema.options,
        "session.status_changed",
        canTransitionSession,
      ],
      [TurnStatusSchema.options, "turn.status_changed", canTransitionTurn],
    ] as const) {
      for (const from of states) {
        for (const to of states) {
          const expected = canTransition(from as never, to as never);
          for (const validator of validators) {
            expect(
              validator.safeParse({
                ...envelope,
                type,
                data: { from, to },
              }).success,
              `${type}:${from}->${to}`,
            ).toBe(expected);
          }
        }
      }
    }

    const terminalCases = [
      ["session.completed", { output: "done" }, true],
      [
        "session.completed",
        {
          error: {
            code: "CANCELLED",
            message: "cancelled",
            retryable: false,
          },
        },
        false,
      ],
      [
        "session.failed",
        {
          error: {
            code: "PROVIDER_FAILED",
            message: "provider unavailable",
            retryable: true,
          },
        },
        true,
      ],
      ["session.failed", {}, false],
      ["session.cancelled", { reason: "cancelled" }, true],
      ["session.cancelled", { output: "not allowed" }, false],
    ] as const;
    for (const [type, data, expected] of terminalCases) {
      for (const validator of validators) {
        expect(
          validator.safeParse({ ...envelope, type, data }).success,
          `${type}:${JSON.stringify(data)}`,
        ).toBe(expected);
      }
    }
  });
});
