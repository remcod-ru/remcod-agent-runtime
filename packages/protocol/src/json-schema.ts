import { z } from "zod";

import { RuntimeErrorSchema } from "./errors.js";
import { RuntimeEventSchema } from "./events.js";
import { SessionSchema, StepSchema, TurnSchema } from "./records.js";

export const ProtocolSchemas = {
  runtimeError: RuntimeErrorSchema,
  session: SessionSchema,
  turn: TurnSchema,
  step: StepSchema,
  runtimeEvent: RuntimeEventSchema,
} as const;

export type ProtocolSchemaName = keyof typeof ProtocolSchemas;
export type ProtocolJsonSchema = z.core.JSONSchema.JSONSchema;

export function generateProtocolJsonSchemas(): Readonly<
  Record<ProtocolSchemaName, ProtocolJsonSchema>
> {
  return {
    runtimeError: z.toJSONSchema(ProtocolSchemas.runtimeError),
    session: z.toJSONSchema(ProtocolSchemas.session),
    turn: z.toJSONSchema(ProtocolSchemas.turn),
    step: z.toJSONSchema(ProtocolSchemas.step),
    runtimeEvent: z.toJSONSchema(ProtocolSchemas.runtimeEvent),
  };
}
