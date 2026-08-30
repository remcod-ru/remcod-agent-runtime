import { z } from "zod";

import { RuntimeErrorSchema } from "./errors.js";
import {
  EventIdSchema,
  SessionIdSchema,
  StepIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from "./ids.js";
import {
  JsonValueSchema,
  ProtocolVersionSchema,
  UtcDateTimeSchema,
} from "./json.js";
import { SessionSchema, StepSchema, TurnSchema } from "./records.js";

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const nonEmptyString = z.string().min(1);

export const UsageSchema = z
  .object({
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    totalTokens: nonNegativeInteger,
  })
  .strict();

export type Usage = z.infer<typeof UsageSchema>;

export const ToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: nonEmptyString,
    input: JsonValueSchema,
  })
  .strict();

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const SessionCreatedDataSchema = z
  .object({ session: SessionSchema })
  .strict();

function transitionData<const From extends string, const To extends string>(
  from: From,
  to: To,
) {
  return z
    .object({
      from: z.literal(from),
      to: z.literal(to),
      reason: nonEmptyString.optional(),
    })
    .strict();
}

export const SessionStatusChangedDataSchema = z.union([
  transitionData("idle", "running"),
  transitionData("idle", "cancelled"),
  transitionData("running", "waiting_input"),
  transitionData("running", "waiting_event"),
  transitionData("running", "waiting_schedule"),
  transitionData("running", "waiting_next_turn"),
  transitionData("running", "completed"),
  transitionData("running", "failed"),
  transitionData("running", "cancelled"),
  transitionData("waiting_input", "running"),
  transitionData("waiting_input", "cancelled"),
  transitionData("waiting_event", "running"),
  transitionData("waiting_event", "cancelled"),
  transitionData("waiting_schedule", "running"),
  transitionData("waiting_schedule", "cancelled"),
  transitionData("waiting_next_turn", "running"),
  transitionData("waiting_next_turn", "completed"),
  transitionData("waiting_next_turn", "cancelled"),
]);
export const TurnCreatedDataSchema = z.object({ turn: TurnSchema }).strict();
export const TurnStatusChangedDataSchema = z.union([
  transitionData("queued", "running"),
  transitionData("running", "waiting_input"),
  transitionData("running", "completed"),
  transitionData("running", "failed"),
  transitionData("running", "cancelled"),
  transitionData("waiting_input", "running"),
  transitionData("waiting_input", "cancelled"),
]);
export const StepStartedDataSchema = z.object({ step: StepSchema }).strict();
export const StepCompletedDataSchema = z
  .object({
    output: JsonValueSchema.optional(),
    usage: UsageSchema.optional(),
  })
  .strict();
export const StepFailedDataSchema = z
  .object({ error: RuntimeErrorSchema })
  .strict();
export const StepCancelledDataSchema = z
  .object({ reason: nonEmptyString.optional() })
  .strict();
export const ModelRequestedDataSchema = z
  .object({
    providerId: nonEmptyString,
    model: nonEmptyString,
    attempt: positiveInteger,
  })
  .strict();
export const ModelCompletedDataSchema = z
  .object({
    responseKind: z.enum(["message", "tool_calls"]),
    usage: UsageSchema,
  })
  .strict();
export const ModelFailedDataSchema = z
  .object({ error: RuntimeErrorSchema, attempt: positiveInteger })
  .strict();
export const ToolRequestedDataSchema = z
  .object({ call: ToolCallSchema, idempotencyKey: nonEmptyString })
  .strict();
export const ToolStartedDataSchema = z
  .object({ toolCallId: ToolCallIdSchema, toolName: nonEmptyString })
  .strict();
export const ToolCompletedDataSchema = z
  .object({ toolCallId: ToolCallIdSchema, output: JsonValueSchema })
  .strict();
export const ToolFailedDataSchema = z
  .object({ toolCallId: ToolCallIdSchema, error: RuntimeErrorSchema })
  .strict();
export const ContextCompactedDataSchema = z
  .object({
    beforeTokens: nonNegativeInteger,
    afterTokens: nonNegativeInteger,
    summary: JsonValueSchema,
  })
  .strict();
export const InputRequestedDataSchema = z
  .object({
    requestId: nonEmptyString,
    prompt: nonEmptyString,
    schema: JsonValueSchema.optional(),
  })
  .strict();
export const InputReceivedDataSchema = z
  .object({ requestId: nonEmptyString, value: JsonValueSchema })
  .strict();
export const SessionCompletedDataSchema = z
  .object({
    output: JsonValueSchema.optional(),
  })
  .strict();
export type SessionCompletedData = z.infer<typeof SessionCompletedDataSchema>;
export const SessionFailedDataSchema = z
  .object({
    error: RuntimeErrorSchema,
  })
  .strict();
export type SessionFailedData = z.infer<typeof SessionFailedDataSchema>;
export const SessionCancelledDataSchema = z
  .object({
    reason: nonEmptyString.optional(),
  })
  .strict();
export type SessionCancelledData = z.infer<typeof SessionCancelledDataSchema>;

export const EventDataSchemas = {
  "session.created": SessionCreatedDataSchema,
  "session.status_changed": SessionStatusChangedDataSchema,
  "turn.created": TurnCreatedDataSchema,
  "turn.status_changed": TurnStatusChangedDataSchema,
  "step.started": StepStartedDataSchema,
  "step.completed": StepCompletedDataSchema,
  "step.failed": StepFailedDataSchema,
  "step.cancelled": StepCancelledDataSchema,
  "model.requested": ModelRequestedDataSchema,
  "model.completed": ModelCompletedDataSchema,
  "model.failed": ModelFailedDataSchema,
  "tool.requested": ToolRequestedDataSchema,
  "tool.started": ToolStartedDataSchema,
  "tool.completed": ToolCompletedDataSchema,
  "tool.failed": ToolFailedDataSchema,
  "context.compacted": ContextCompactedDataSchema,
  "input.requested": InputRequestedDataSchema,
  "input.received": InputReceivedDataSchema,
  "session.completed": SessionCompletedDataSchema,
  "session.failed": SessionFailedDataSchema,
  "session.cancelled": SessionCancelledDataSchema,
} as const;

export const EventTypeSchema = z.enum(
  Object.keys(EventDataSchemas) as [
    keyof typeof EventDataSchemas,
    ...(keyof typeof EventDataSchemas)[],
  ],
);

export type EventType = z.infer<typeof EventTypeSchema>;

const eventEnvelopeShape = {
  protocolVersion: ProtocolVersionSchema,
  id: EventIdSchema,
  cursor: positiveInteger,
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema.optional(),
  stepId: StepIdSchema.optional(),
  correlationId: nonEmptyString,
  causationId: EventIdSchema.optional(),
  occurredAt: UtcDateTimeSchema,
};

function runtimeEventVariant<
  const Type extends EventType,
  Data extends z.ZodType,
>(type: Type, data: Data) {
  return z
    .object({
      ...eventEnvelopeShape,
      type: z.literal(type),
      data,
    })
    .strict();
}

function stepEventVariant<
  const Type extends `step.${string}`,
  Data extends z.ZodType,
>(type: Type, data: Data) {
  return z
    .object({
      ...eventEnvelopeShape,
      turnId: TurnIdSchema,
      stepId: StepIdSchema,
      type: z.literal(type),
      data,
    })
    .strict();
}

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  runtimeEventVariant("session.created", SessionCreatedDataSchema),
  runtimeEventVariant("session.status_changed", SessionStatusChangedDataSchema),
  runtimeEventVariant("turn.created", TurnCreatedDataSchema),
  runtimeEventVariant("turn.status_changed", TurnStatusChangedDataSchema),
  stepEventVariant("step.started", StepStartedDataSchema),
  stepEventVariant("step.completed", StepCompletedDataSchema),
  stepEventVariant("step.failed", StepFailedDataSchema),
  stepEventVariant("step.cancelled", StepCancelledDataSchema),
  runtimeEventVariant("model.requested", ModelRequestedDataSchema),
  runtimeEventVariant("model.completed", ModelCompletedDataSchema),
  runtimeEventVariant("model.failed", ModelFailedDataSchema),
  runtimeEventVariant("tool.requested", ToolRequestedDataSchema),
  runtimeEventVariant("tool.started", ToolStartedDataSchema),
  runtimeEventVariant("tool.completed", ToolCompletedDataSchema),
  runtimeEventVariant("tool.failed", ToolFailedDataSchema),
  runtimeEventVariant("context.compacted", ContextCompactedDataSchema),
  runtimeEventVariant("input.requested", InputRequestedDataSchema),
  runtimeEventVariant("input.received", InputReceivedDataSchema),
  runtimeEventVariant("session.completed", SessionCompletedDataSchema),
  runtimeEventVariant("session.failed", SessionFailedDataSchema),
  runtimeEventVariant("session.cancelled", SessionCancelledDataSchema),
]);

type ParsedRuntimeEvent = z.infer<typeof RuntimeEventSchema>;
type RawEventData = {
  [Type in EventType]: z.infer<(typeof EventDataSchemas)[Type]>;
}[EventType];
type UnionKeys<Value> = Value extends Value ? keyof Value : never;
type ClosedEventData<Type extends EventType> = z.infer<
  (typeof EventDataSchemas)[Type]
> &
  Partial<
    Record<
      Exclude<
        UnionKeys<RawEventData>,
        keyof z.infer<(typeof EventDataSchemas)[Type]>
      >,
      never
    >
  >;
type RuntimeEventUnion = {
  [Type in EventType]: Omit<
    Extract<ParsedRuntimeEvent, { type: Type }>,
    "data"
  > & { data: ClosedEventData<Type> };
}[EventType];

export type RuntimeEvent<Type extends EventType = EventType> = Extract<
  RuntimeEventUnion,
  { type: Type }
>;

export type EventData<Type extends EventType> = RuntimeEvent<Type>["data"];

type WithoutStoredEnvelope<Event> = Event extends RuntimeEvent
  ? Omit<Event, "protocolVersion" | "sessionId" | "cursor">
  : never;

export type NewEvent<Type extends EventType = EventType> =
  WithoutStoredEnvelope<RuntimeEvent<Type>>;
