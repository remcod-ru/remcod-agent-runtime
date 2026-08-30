import { z } from "zod";

import { RuntimeErrorSchema } from "./errors.js";
import {
  AgentIdSchema,
  SessionIdSchema,
  StepIdSchema,
  TurnIdSchema,
} from "./ids.js";
import {
  JsonValueSchema,
  ProtocolVersionSchema,
  UtcDateTimeSchema,
} from "./json.js";
import {
  SessionStatusSchema,
  StepStatusSchema,
  TurnStatusSchema,
} from "./states.js";

const nonNegativeInteger = z.number().int().nonnegative();

export const SessionSchema = z
  .object({
    id: SessionIdSchema,
    protocolVersion: ProtocolVersionSchema,
    agentId: AgentIdSchema,
    status: SessionStatusSchema,
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
    version: nonNegativeInteger,
    lastEventCursor: nonNegativeInteger,
  })
  .strict();

export type Session = z.infer<typeof SessionSchema>;

export const TurnSchema = z
  .object({
    id: TurnIdSchema,
    sessionId: SessionIdSchema,
    status: TurnStatusSchema,
    input: JsonValueSchema,
    output: JsonValueSchema.optional(),
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
  })
  .strict();

export type Turn = z.infer<typeof TurnSchema>;

export const StepKindSchema = z.enum(["model", "tool", "compaction"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const StepSchema = z
  .object({
    id: StepIdSchema,
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    index: nonNegativeInteger,
    kind: StepKindSchema,
    status: StepStatusSchema,
    startedAt: UtcDateTimeSchema.optional(),
    completedAt: UtcDateTimeSchema.optional(),
    error: RuntimeErrorSchema.optional(),
  })
  .strict();

export type Step = z.infer<typeof StepSchema>;
