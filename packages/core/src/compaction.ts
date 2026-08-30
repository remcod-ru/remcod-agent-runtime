import type { JsonValue } from "@remcod/protocol";

import type { ModelMessage, RuntimeLimits } from "./agent.js";

export interface ContextSnapshot {
  instructions: string;
  messages: readonly ModelMessage[];
  estimatedTokens: number;
}

export interface ContextCompaction {
  messages: readonly ModelMessage[];
  summary: JsonValue;
}

export interface ContextCompactor {
  shouldCompact(snapshot: ContextSnapshot, limits: RuntimeLimits): boolean;
  compact(snapshot: ContextSnapshot): Promise<ContextCompaction>;
}

export const defaultContextCompactor: Readonly<ContextCompactor> =
  Object.freeze({
    shouldCompact(snapshot: ContextSnapshot, limits: RuntimeLimits): boolean {
      return snapshot.estimatedTokens > limits.maxInputTokens;
    },
    async compact(snapshot: ContextSnapshot): Promise<ContextCompaction> {
      const retainedCount = Math.ceil(snapshot.messages.length / 2);
      const removedMessages = snapshot.messages.length - retainedCount;
      const summary = {
        kind: "deterministic_truncation",
        removedMessages,
        sourceEstimatedTokens: snapshot.estimatedTokens,
      } as const satisfies JsonValue;
      const retained =
        retainedCount === 0
          ? []
          : snapshot.messages.slice(snapshot.messages.length - retainedCount);

      return {
        messages: [{ role: "system", content: summary }, ...retained],
        summary,
      };
    },
  });
