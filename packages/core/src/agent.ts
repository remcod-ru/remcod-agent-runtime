import type {
  JsonValue,
  RuntimeEvent,
  Session,
  ToolCallId,
} from "@remcod/protocol";
import type { AnyTool } from "@remcod/tools";
import type { z } from "zod";

import { resolveRuntimeLimits } from "./limits.js";

export interface ModelSelector {
  providerId: string;
  model: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: JsonValue;
  toolCallId?: ToolCallId;
}

export interface RuntimeLimits {
  maxSteps: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export type InstructionBuilder = (context: {
  session: Session;
  priorEvents: readonly RuntimeEvent[];
}) => string | Promise<string>;

export interface AgentDefinition<TOutput extends JsonValue = JsonValue> {
  id: string;
  name: string;
  instructions: string | InstructionBuilder;
  model: ModelSelector;
  tools?: readonly AnyTool[];
  outputSchema?: z.ZodType<TOutput>;
  limits?: RuntimeLimits;
}

export function defineAgent<TOutput extends JsonValue = JsonValue>(
  definition: AgentDefinition<TOutput>,
): AgentDefinition<TOutput> {
  const limits =
    definition.limits === undefined
      ? undefined
      : resolveRuntimeLimits(definition.limits);
  return Object.freeze({ ...definition, limits });
}
