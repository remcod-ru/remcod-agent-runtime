import type { ModelMessage, ModelSelector, RuntimeLimits } from "@remcod/core";
import type { JsonValue, ToolCall, Usage } from "@remcod/protocol";

export type { ModelSelector } from "@remcod/core";
export type { ToolCall, Usage } from "@remcod/protocol";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export interface ModelRequest {
  model: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDescriptor[];
  outputSchema?: JsonValue;
  remaining: RuntimeLimits;
}

export type ModelResponse =
  | { kind: "message"; content: JsonValue; usage: Usage }
  | { kind: "tool_calls"; calls: readonly ToolCall[]; usage: Usage };

export interface ModelProvider {
  readonly id: string;
  generate(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): Promise<ModelResponse>;
}

export class DuplicateProviderError extends Error {
  readonly code = "DUPLICATE_PROVIDER";

  constructor(readonly providerId: string) {
    super(`Provider is already registered: ${providerId}`);
    this.name = "DuplicateProviderError";
  }
}

export class UnknownProviderError extends Error {
  readonly code = "UNKNOWN_PROVIDER";

  constructor(readonly providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = "UnknownProviderError";
  }
}

export class ProviderRegistry {
  readonly #providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new DuplicateProviderError(provider.id);
    }
    this.#providers.set(provider.id, provider);
  }

  resolve(selector: ModelSelector): ModelProvider {
    const provider = this.#providers.get(selector.providerId);
    if (!provider) {
      throw new UnknownProviderError(selector.providerId);
    }
    return provider;
  }
}
