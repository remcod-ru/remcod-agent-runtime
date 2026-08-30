import { defineAgent } from "@remcod/core";
import {
  ProviderRegistry,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@remcod/model-router";
import { createId } from "@remcod/protocol";
import { describe, expect, it } from "vitest";

import {
  DuplicateAgentError,
  UnknownAgentError,
  createInMemoryRuntimeStore,
  createRuntime,
} from "./index.js";

function messageModel(id = "provider-1") {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider & {
    readonly requests: readonly ModelRequest[];
  } = {
    id,
    requests,
    async generate(request): Promise<ModelResponse> {
      requests.push(request);
      return {
        kind: "message",
        content: { answer: "done" },
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      };
    },
  };
  return provider;
}

describe("agent runtime", () => {
  it("snapshots agent resolution, rejects duplicate/unknown IDs, and completes a message-only turn", async () => {
    const provider = messageModel();
    const providers = new ProviderRegistry();
    providers.register(provider);
    const agent = defineAgent({
      id: "agent-1",
      name: "Agent One",
      instructions: "Be deterministic.",
      model: { providerId: provider.id, model: "scripted" },
    });
    const agents = [agent];
    const runtime = createRuntime({
      agents,
      providers,
      store: createInMemoryRuntimeStore(),
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
      idFactory: (brand) => createId(brand, `${brand.toLowerCase()}-1`),
    });
    agents.length = 0;

    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    const result = await runtime.runTurn({
      sessionId: session.id,
      input: { question: "ready?" },
    });

    expect(result.output).toEqual({ answer: "done" });
    expect(result.session.status).toBe("completed");
    expect(result.turn.status).toBe("completed");
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages).toEqual([
      { role: "system", content: "Be deterministic." },
      { role: "user", content: { question: "ready?" } },
    ]);

    await expect(
      runtime.createSession({ agentId: createId("AgentId", "missing") }),
    ).rejects.toBeInstanceOf(UnknownAgentError);
    expect(() =>
      createRuntime({
        agents: [agent, agent],
        providers,
        store: createInMemoryRuntimeStore(),
      }),
    ).toThrow(DuplicateAgentError);
  });
});
