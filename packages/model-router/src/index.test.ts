import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ToolCall as ProtocolToolCall,
  Usage as ProtocolUsage,
} from "@remcod/protocol";

import {
  DuplicateProviderError,
  ProviderRegistry,
  UnknownProviderError,
  type ToolCall,
  type Usage,
  type ModelProvider,
} from "./index.js";

function provider(id: string): ModelProvider {
  return {
    id,
    generate: async () => {
      throw new Error("not called");
    },
  };
}

describe("ProviderRegistry", () => {
  it("re-exports canonical protocol usage and tool-call types", () => {
    expectTypeOf<Usage>().toEqualTypeOf<ProtocolUsage>();
    expectTypeOf<ToolCall>().toEqualTypeOf<ProtocolToolCall>();
  });

  it("resolves the exact registered provider from a model selector", () => {
    const registry = new ProviderRegistry();
    const primary = provider("primary");
    registry.register(primary);
    registry.register(provider("primary-backup"));

    expect(registry.resolve({ providerId: "primary", model: "small" })).toBe(
      primary,
    );
  });

  it("rejects duplicate and unknown provider ids with typed errors", () => {
    const registry = new ProviderRegistry();
    registry.register(provider("primary"));

    expect(() => registry.register(provider("primary"))).toThrow(
      DuplicateProviderError,
    );
    expect(() =>
      registry.resolve({ providerId: "missing", model: "small" }),
    ).toThrow(UnknownProviderError);
  });
});
