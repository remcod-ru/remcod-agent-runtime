import {
  ProviderRegistry,
  ScriptedModel,
  createId,
  createInMemoryRuntimeStore,
  createRuntime,
  defineAgent,
  defineTool,
  z,
  type EventType,
  type JsonValue,
  type ModelMessage,
} from "@remcod/sdk";

export interface BasicAgentResult {
  readonly output: JsonValue | undefined;
  readonly modelRequestCount: number;
  readonly secondRequestMessages: readonly ModelMessage[];
  readonly eventTypes: readonly EventType[];
}

export async function runBasicAgent(): Promise<BasicAgentResult> {
  const add = defineTool({
    name: "add",
    description: "Add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
    outputSchema: z.number(),
    risk: "read",
    timeoutMs: 1_000,
    async execute(input) {
      return input.a + input.b;
    },
  });
  const model = new ScriptedModel("scripted", [
    {
      kind: "response",
      response: {
        kind: "tool_calls",
        calls: [
          {
            id: createId("ToolCallId", "call-add"),
            name: "add",
            input: { a: 20, b: 22 },
          },
        ],
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      },
    },
    {
      kind: "response",
      response: {
        kind: "message",
        content: { answer: 42 },
        usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
      },
    },
  ]);
  const providers = new ProviderRegistry();
  providers.register(model);
  const agent = defineAgent({
    id: "basic-agent",
    name: "Basic Agent",
    instructions: "Use the add tool and return its result.",
    model: { providerId: model.id, model: "scripted-v1" },
    tools: [add],
  });
  const counters = new Map<string, number>();
  const runtime = createRuntime({
    agents: [agent],
    providers,
    store: createInMemoryRuntimeStore(),
    clock: () => new Date("2026-08-30T10:00:00.000Z"),
    idFactory: (brand) => {
      const next = (counters.get(brand) ?? 0) + 1;
      counters.set(brand, next);
      return createId(brand, `${brand.toLowerCase()}-${next}`);
    },
  });

  const session = await runtime.createSession({
    agentId: createId("AgentId", agent.id),
  });
  const result = await runtime.runTurn({
    sessionId: session.id,
    input: { request: "Add 20 and 22" },
  });
  const eventTypes: EventType[] = [];
  for await (const runtimeEvent of runtime.events({
    sessionId: session.id,
    afterCursor: 0,
    limit: 1000,
  })) {
    eventTypes.push(runtimeEvent.type);
  }
  model.assertExhausted();

  return {
    output: result.output,
    modelRequestCount: model.requests.length,
    secondRequestMessages: model.requests[1]?.messages ?? [],
    eventTypes,
  };
}
