import type { RuntimeEvent } from "../src/index.js";
import { createId } from "../src/index.js";

const baseEvent = {
  protocolVersion: "1",
  id: createId("EventId", "event-1"),
  cursor: 1,
  sessionId: createId("SessionId", "session-1"),
  turnId: createId("TurnId", "turn-1"),
  stepId: createId("StepId", "step-1"),
  correlationId: "correlation-1",
  occurredAt: "2026-08-30T09:00:00.000Z",
} as const;

const cancelledEvent: RuntimeEvent<"step.cancelled"> = {
  ...baseEvent,
  type: "step.cancelled",
  data: { reason: "cancelled by caller" },
};

const invalidEvent: RuntimeEvent<"step.completed"> = {
  ...baseEvent,
  type: "step.completed",
  data: {
    // @ts-expect-error event data is closed over its matching type
    error: {
      code: "PROVIDER_FAILED",
      message: "wrong event data",
      retryable: true,
    },
  },
};

const error = {
  code: "PROVIDER_FAILED",
  message: "provider unavailable",
  retryable: true,
} as const;
const completedWithError = { error } as const;
const failedWithoutError = {} as const;
const cancelledWithOutput = { output: "not allowed" } as const;

const invalidCompleted: RuntimeEvent<"session.completed"> = {
  ...baseEvent,
  type: "session.completed",
  // @ts-expect-error completed sessions only carry output
  data: completedWithError,
};
const invalidFailed: RuntimeEvent<"session.failed"> = {
  ...baseEvent,
  type: "session.failed",
  // @ts-expect-error failed sessions require RuntimeError
  data: failedWithoutError,
};
const invalidCancelled: RuntimeEvent<"session.cancelled"> = {
  ...baseEvent,
  type: "session.cancelled",
  // @ts-expect-error cancelled sessions only carry a reason
  data: cancelledWithOutput,
};

void cancelledEvent;
void invalidCancelled;
void invalidCompleted;
void invalidEvent;
void invalidFailed;
