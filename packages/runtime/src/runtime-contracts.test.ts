import {
  defineAgent,
  type ContextCompactor,
  type RetryPolicy,
} from "@remcod/core";
import {
  ProviderRegistry,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@remcod/model-router";
import { createId, type RuntimeEvent } from "@remcod/protocol";
import { defineTool, type AnyTool } from "@remcod/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RuntimeFailure,
  createInMemoryRuntimeStore,
  createRuntime,
  type RuntimeConfig,
  type RuntimeStore,
} from "./index.js";
import { reduceRuntimeEvents } from "./reducer.js";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

function scriptedProvider(
  script: readonly (ModelResponse | Error)[],
  id = "p",
) {
  const requests: ModelRequest[] = [];
  let cursor = 0;
  const provider: ModelProvider & {
    readonly requests: readonly ModelRequest[];
  } = {
    id,
    requests,
    async generate(request): Promise<ModelResponse> {
      requests.push(structuredClone(request));
      const item = script[cursor++];
      if (!item) throw new Error("script exhausted");
      if (item instanceof Error) throw item;
      return item;
    },
  };
  return provider;
}

function harness(
  provider: ModelProvider,
  options: {
    tools?: readonly ReturnType<typeof defineTool>[];
    limits?: RuntimeConfig["defaults"];
    outputSchema?: z.ZodType;
    retry?: RetryPolicy;
    compactor?: ContextCompactor;
    store?: RuntimeStore;
  } = {},
) {
  const providers = new ProviderRegistry();
  providers.register(provider);
  const store = options.store ?? createInMemoryRuntimeStore();
  const agent = defineAgent({
    id: "agent",
    name: "Agent",
    instructions: "system",
    model: { providerId: provider.id, model: "test" },
    tools: options.tools,
    outputSchema: options.outputSchema,
  });
  const runtime = createRuntime({
    agents: [agent],
    providers,
    store,
    defaults: options.limits,
    retry: options.retry,
    compactor: options.compactor,
  });
  return { runtime, store };
}

async function newSession(runtime: ReturnType<typeof harness>["runtime"]) {
  return runtime.createSession({ agentId: createId("AgentId", "agent") });
}

describe("bounded harness contracts", () => {
  it("executes declared multi-tool order and suppresses a stable duplicate call", async () => {
    const executions: string[] = [];
    const first = defineTool({
      name: "first",
      description: "first",
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      risk: "read",
      timeoutMs: 1_000,
      async execute(input) {
        executions.push(`first:${input.value}`);
        return input;
      },
    });
    const second = defineTool({
      name: "second",
      description: "second",
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      risk: "draft",
      timeoutMs: 1_000,
      async execute(input) {
        executions.push(`second:${input.value}`);
        return input;
      },
    });
    const duplicate = {
      id: createId("ToolCallId", "same-call"),
      name: "first",
      input: { value: 1 },
    } as const;
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [
          duplicate,
          duplicate,
          {
            id: createId("ToolCallId", "second-call"),
            name: "second",
            input: { value: 2 },
          },
        ],
        usage: USAGE,
      },
      { kind: "message", content: "done", usage: USAGE },
    ]);
    const { runtime } = harness(provider, { tools: [first, second] });
    const session = await newSession(runtime);

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).resolves.toMatchObject({ output: "done" });
    expect(executions).toEqual(["first:1", "second:2"]);
    expect(provider.requests[1]?.messages.slice(-3)).toEqual([
      { role: "tool", toolCallId: duplicate.id, content: { value: 1 } },
      { role: "tool", toolCallId: duplicate.id, content: { value: 1 } },
      {
        role: "tool",
        toolCallId: createId("ToolCallId", "second-call"),
        content: { value: 2 },
      },
    ]);
  });

  it("treats completed null as cached and executes a repeated tool call once", async () => {
    let executions = 0;
    const nullable = defineTool({
      name: "nullable",
      description: "nullable",
      inputSchema: z.object({}),
      outputSchema: z.null(),
      risk: "read",
      timeoutMs: 1_000,
      async execute() {
        executions += 1;
        return null;
      },
    });
    const call = {
      id: createId("ToolCallId", "nullable-call"),
      name: nullable.name,
      input: {},
    } as const;
    const provider = scriptedProvider([
      { kind: "tool_calls", calls: [call, call], usage: USAGE },
      { kind: "message", content: "done", usage: USAGE },
    ]);
    const { runtime } = harness(provider, { tools: [nullable] });
    const session = await newSession(runtime);

    await runtime.runTurn({ sessionId: session.id, input: "go" });
    expect(executions).toBe(1);
    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      { role: "tool", toolCallId: call.id, content: null },
      { role: "tool", toolCallId: call.id, content: null },
    ]);
  });

  it("binds one provider call ID to a canonical tool fingerprint and rejects mismatched input", async () => {
    const inputs: number[] = [];
    const tool = defineTool({
      name: "fingerprinted",
      description: "fingerprinted",
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      risk: "draft",
      timeoutMs: 1_000,
      async execute(input) {
        inputs.push(input.value);
        return input;
      },
    });
    const id = createId("ToolCallId", "provider-controlled-id");
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id, name: tool.name, input: { value: 1 } }],
        usage: USAGE,
      },
      {
        kind: "tool_calls",
        calls: [{ id, name: tool.name, input: { value: 2 } }],
        usage: USAGE,
      },
    ]);
    const { runtime, store } = harness(provider, { tools: [tool] });
    const session = await newSession(runtime);

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    expect(inputs).toEqual([1]);
    const events = (await store.readEvents({ sessionId: session.id })).events;
    expect(
      events.filter((event) => event.type === "tool.completed"),
    ).toHaveLength(1);
  });

  it("canonicalizes object key order when fingerprinting the same provider call", async () => {
    let executions = 0;
    const tool = defineTool({
      name: "canonical",
      description: "canonical",
      inputSchema: z.object({ first: z.number(), second: z.number() }),
      outputSchema: z.literal("ok"),
      risk: "read",
      timeoutMs: 1_000,
      async execute() {
        executions += 1;
        return "ok" as const;
      },
    });
    const id = createId("ToolCallId", "canonical-id");
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id, name: tool.name, input: { first: 1, second: 2 } }],
        usage: USAGE,
      },
      {
        kind: "tool_calls",
        calls: [{ id, name: tool.name, input: { second: 2, first: 1 } }],
        usage: USAGE,
      },
      { kind: "message", content: "done", usage: USAGE },
    ]);
    const { runtime } = harness(provider, { tools: [tool] });
    const session = await newSession(runtime);

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).resolves.toMatchObject({ output: "done" });
    expect(executions).toBe(1);
  });

  it("validates completed cached output against the current tool schema before returning it", async () => {
    const base = createInMemoryRuntimeStore();
    const store = new Proxy(base, {
      get(target, property) {
        if (property === "claimIdempotency") {
          return async () => ({ status: "completed", value: "stale" });
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    let executions = 0;
    const tool = defineTool({
      name: "cache-schema",
      description: "cache schema",
      inputSchema: z.object({}),
      outputSchema: z.number(),
      risk: "read",
      timeoutMs: 1_000,
      async execute() {
        executions += 1;
        return 1;
      },
    });
    const callId = createId("ToolCallId", "cached-invalid");
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id: callId, name: tool.name, input: {} }],
        usage: USAGE,
      },
      { kind: "message", content: "recovered", usage: USAGE },
    ]);
    const { runtime } = harness(provider, { tools: [tool], store });
    const session = await newSession(runtime);

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).resolves.toMatchObject({ output: "recovered" });
    expect(executions).toBe(0);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: callId,
      content: { error: { code: "TOOL_FAILED" } },
    });
  });

  it("validates a cached codec output structurally without decoding it twice", async () => {
    let executions = 0;
    const outputSchema = z.codec(z.string(), z.number(), {
      decode: (value) => Number(value),
      encode: (value) => String(value),
    });
    const tool = defineTool({
      name: "codec-cache",
      description: "codec cache",
      inputSchema: z.object({}),
      outputSchema,
      risk: "read",
      timeoutMs: 1_000,
      async execute() {
        executions += 1;
        return "42";
      },
    });
    const call = {
      id: createId("ToolCallId", "codec-cache-call"),
      name: tool.name,
      input: {},
    } as const;
    const provider = scriptedProvider([
      { kind: "tool_calls", calls: [call, call], usage: USAGE },
      { kind: "message", content: "done", usage: USAGE },
    ]);
    const { runtime } = harness(provider, { tools: [tool] });
    const session = await newSession(runtime);

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).resolves.toMatchObject({ output: "done" });
    expect(executions).toBe(1);
    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      { role: "tool", toolCallId: call.id, content: 42 },
      { role: "tool", toolCallId: call.id, content: 42 },
    ]);
  });

  it("returns the original cached value without reapplying overwrite normalization", async () => {
    let executions = 0;
    const tool = Object.freeze({
      name: "overwrite-cache",
      description: "overwrite cache",
      inputSchema: z.object({}),
      outputSchema: z.string().overwrite((value) => `${value}!`),
      risk: "read" as const,
      timeoutMs: 1_000,
      async execute() {
        executions += 1;
        return "value!";
      },
    }) as unknown as AnyTool;
    const call = {
      id: createId("ToolCallId", "overwrite-cache-call"),
      name: tool.name,
      input: {},
    } as const;
    const provider = scriptedProvider([
      { kind: "tool_calls", calls: [call, call], usage: USAGE },
      { kind: "message", content: "done", usage: USAGE },
    ]);
    const { runtime } = harness(provider, { tools: [tool] });
    const session = await newSession(runtime);

    await runtime.runTurn({ sessionId: session.id, input: "go" });
    expect(executions).toBe(1);
    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      { role: "tool", toolCallId: call.id, content: "value!" },
      { role: "tool", toolCallId: call.id, content: "value!" },
    ]);
  });

  it("leaves a post-invocation validation failure in flight and never re-executes the possible effect", async () => {
    let executions = 0;
    let idempotencyKey = "";
    const invalid = defineTool({
      name: "effect",
      description: "effect",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.literal(true) }),
      risk: "draft",
      timeoutMs: 1_000,
      async execute(_input, context) {
        executions += 1;
        idempotencyKey = context.idempotencyKey;
        return { ok: false } as never;
      },
    });
    const call = {
      id: createId("ToolCallId", "effect-call"),
      name: invalid.name,
      input: {},
    } as const;
    const provider = scriptedProvider([
      { kind: "tool_calls", calls: [call, call], usage: USAGE },
    ]);
    const { runtime, store } = harness(provider, { tools: [invalid] });
    const session = await newSession(runtime);

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    expect(executions).toBe(1);
    expect(
      await store.claimIdempotency(
        "tool",
        idempotencyKey,
        '{"input":{},"name":"effect"}',
      ),
    ).toEqual({ status: "in_flight" });
  });

  it("leaves the claim in flight when completion storage fails after invocation", async () => {
    const base = createInMemoryRuntimeStore();
    const store = new Proxy(base, {
      get(target, property) {
        if (property === "completeIdempotency") {
          return async () => {
            throw new Error("completion store unavailable");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    let executions = 0;
    let idempotencyKey = "";
    const effect = defineTool({
      name: "store-failure-effect",
      description: "effect",
      inputSchema: z.object({}),
      outputSchema: z.null(),
      risk: "draft",
      timeoutMs: 1_000,
      async execute(_input, context) {
        executions += 1;
        idempotencyKey = context.idempotencyKey;
        return null;
      },
    });
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [
          {
            id: createId("ToolCallId", "store-failure-call"),
            name: effect.name,
            input: {},
          },
        ],
        usage: USAGE,
      },
    ]);
    const { runtime } = harness(provider, { tools: [effect], store });
    const session = await newSession(runtime);

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    expect(executions).toBe(1);
    expect(
      await base.claimIdempotency(
        "tool",
        idempotencyKey,
        '{"input":{},"name":"store-failure-effect"}',
      ),
    ).toEqual({ status: "in_flight" });
  });

  it("leaves an aborted post-invocation tool claim in flight and never re-executes", async () => {
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let executions = 0;
    let idempotencyKey = "";
    const pending = defineTool({
      name: "pending-effect",
      description: "pending",
      inputSchema: z.object({}),
      outputSchema: z.null(),
      risk: "draft",
      timeoutMs: 10_000,
      async execute(_input, context) {
        executions += 1;
        idempotencyKey = context.idempotencyKey;
        started();
        return new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
    });
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [
          {
            id: createId("ToolCallId", "pending-call"),
            name: pending.name,
            input: {},
          },
        ],
        usage: USAGE,
      },
    ]);
    const { runtime, store } = harness(provider, { tools: [pending] });
    const session = await newSession(runtime);
    const turn = runtime.runTurn({ sessionId: session.id, input: "go" });
    await toolStarted;
    const cancelled = runtime.cancelSession(session.id, "stop effect");

    await expect(turn).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(cancelled).resolves.toMatchObject({ status: "cancelled" });
    expect(executions).toBe(1);
    expect(
      await store.claimIdempotency(
        "tool",
        idempotencyKey,
        '{"input":{},"name":"pending-effect"}',
      ),
    ).toEqual({ status: "in_flight" });
    expect(provider.requests).toHaveLength(1);
  });

  it("fails write and privileged tools with POLICY_REQUIRED before execution", async () => {
    for (const risk of ["write", "privileged"] as const) {
      let executions = 0;
      const unsafe = defineTool({
        name: `unsafe-${risk}`,
        description: "unsafe",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.literal(true) }),
        risk,
        timeoutMs: 1_000,
        async execute() {
          executions += 1;
          return { ok: true as const };
        },
      });
      const provider = scriptedProvider(
        [
          {
            kind: "tool_calls",
            calls: [
              {
                id: createId("ToolCallId", `unsafe-${risk}`),
                name: unsafe.name,
                input: {},
              },
            ],
            usage: USAGE,
          },
        ],
        `p-${risk}`,
      );
      const { runtime } = harness(provider, { tools: [unsafe] });
      const session = await newSession(runtime);
      await expect(
        runtime.runTurn({ sessionId: session.id, input: "go" }),
      ).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
      expect(executions).toBe(0);
    }
  });

  it("returns invalid tool input to the model exactly once without execution", async () => {
    let invalidInputExecutions = 0;
    const invalidInput = defineTool({
      name: "invalid-input",
      description: "input",
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ ok: z.boolean() }),
      risk: "read",
      timeoutMs: 1_000,
      async execute() {
        invalidInputExecutions += 1;
        return { ok: true };
      },
    });
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [
          {
            id: createId("ToolCallId", "bad-input"),
            name: invalidInput.name,
            input: { value: "not-number" },
          },
        ],
        usage: USAGE,
      },
      { kind: "message", content: "recovered", usage: USAGE },
    ]);
    const { runtime } = harness(provider, {
      tools: [invalidInput],
    });
    const session = await newSession(runtime);
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).resolves.toMatchObject({ output: "recovered" });
    expect(invalidInputExecutions).toBe(0);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: createId("ToolCallId", "bad-input"),
      content: { error: { code: "VALIDATION_FAILED", retryable: false } },
    });
  });

  it("returns unknown, execution, and invalid-output tool errors to the next model request once", async () => {
    const scenarios = [
      {
        name: "unknown-tool",
        tools: [] as ReturnType<typeof defineTool>[],
        toolName: "missing",
        expectedCode: "TOOL_FAILED",
      },
      {
        name: "execution-failure",
        tools: [
          defineTool({
            name: "throws",
            description: "throws",
            inputSchema: z.object({}),
            outputSchema: z.null(),
            risk: "read",
            timeoutMs: 1_000,
            async execute() {
              throw new Error("tool exploded");
            },
          }),
        ],
        toolName: "throws",
        expectedCode: "TOOL_FAILED",
      },
      {
        name: "invalid-output",
        tools: [
          defineTool({
            name: "bad-output",
            description: "bad output",
            inputSchema: z.object({}),
            outputSchema: z.object({ ok: z.literal(true) }),
            risk: "draft",
            timeoutMs: 1_000,
            async execute() {
              return { ok: false } as never;
            },
          }),
        ],
        toolName: "bad-output",
        expectedCode: "TOOL_FAILED",
      },
    ] as const;

    for (const scenario of scenarios) {
      const callId = createId("ToolCallId", scenario.name);
      const provider = scriptedProvider(
        [
          {
            kind: "tool_calls",
            calls: [{ id: callId, name: scenario.toolName, input: {} }],
            usage: USAGE,
          },
          { kind: "message", content: "recovered", usage: USAGE },
        ],
        `provider-${scenario.name}`,
      );
      const { runtime, store } = harness(provider, { tools: scenario.tools });
      const session = await newSession(runtime);
      await expect(
        runtime.runTurn({ sessionId: session.id, input: "go" }),
      ).resolves.toMatchObject({ output: "recovered" });
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: callId,
        content: {
          error: { code: scenario.expectedCode, retryable: false },
        },
      });
      const events = (await store.readEvents({ sessionId: session.id })).events;
      expect(
        events.filter((event) => event.type === "tool.failed"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "step.failed"),
      ).toHaveLength(1);
    }
  });

  it("retries transient provider errors within attempts and never retries permanent errors", async () => {
    const transient = Object.assign(new Error("temporary"), {
      retryable: true,
    });
    const retry: RetryPolicy = {
      maxAttempts: 2,
      classify: (error) =>
        error instanceof RuntimeFailure && error.retryable
          ? "transient"
          : "permanent",
      delayMs: () => 0,
    };
    const recovered = scriptedProvider([
      transient,
      { kind: "message", content: "ok", usage: USAGE },
    ]);
    const recoveredHarness = harness(recovered, { retry });
    const recoveredSession = await newSession(recoveredHarness.runtime);
    await expect(
      recoveredHarness.runtime.runTurn({
        sessionId: recoveredSession.id,
        input: "go",
      }),
    ).resolves.toMatchObject({ output: "ok" });
    expect(recovered.requests).toHaveLength(2);

    const permanent = scriptedProvider([new Error("permanent")], "permanent");
    const permanentHarness = harness(permanent, { retry });
    const permanentSession = await newSession(permanentHarness.runtime);
    await expect(
      permanentHarness.runtime.runTurn({
        sessionId: permanentSession.id,
        input: "go",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
    expect(permanent.requests).toHaveLength(1);
  });

  it("never sends budget or response-validation hard stops through the user retry classifier", async () => {
    let classifications = 0;
    const retry: RetryPolicy = {
      maxAttempts: 3,
      classify() {
        classifications += 1;
        return "transient";
      },
      delayMs: () => 0,
    };
    const budgetProvider = scriptedProvider([
      { kind: "message", content: "over", usage: USAGE },
    ]);
    const budgetHarness = harness(budgetProvider, {
      retry,
      limits: { maxOutputTokens: 0 },
    });
    const budgetSession = await newSession(budgetHarness.runtime);
    await expect(
      budgetHarness.runtime.runTurn({
        sessionId: budgetSession.id,
        input: "go",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    const invalidProvider = scriptedProvider([
      {
        kind: "message",
        content: "invalid usage",
        usage: { inputTokens: -1, outputTokens: 0, totalTokens: -1 },
      },
    ] as readonly ModelResponse[]);
    const invalidHarness = harness(invalidProvider, { retry });
    const invalidSession = await newSession(invalidHarness.runtime);
    await expect(
      invalidHarness.runtime.runTurn({
        sessionId: invalidSession.id,
        input: "go",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(classifications).toBe(0);
    expect(budgetProvider.requests).toHaveLength(1);
    expect(invalidProvider.requests).toHaveLength(1);
  });

  it("records step before turn/session cancellation and starts no further work", async () => {
    let started!: () => void;
    const provider: ModelProvider = {
      id: "pending",
      async generate(_request, { signal }) {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { runtime, store } = harness(provider);
    const session = await newSession(runtime);
    const turn = runtime.runTurn({ sessionId: session.id, input: "go" });
    await providerStarted;
    await expect(
      runtime.cancelSession(session.id, "stop"),
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(turn).rejects.toMatchObject({ code: "CANCELLED" });
    const types = (
      await store.readEvents({ sessionId: session.id })
    ).events.map((event) => event.type);
    expect(types.indexOf("step.cancelled")).toBeLessThan(
      types.indexOf("session.cancelled"),
    );
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "again" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("registers the active run before CAS can return and never starts a provider after cancellation", async () => {
    const base = createInMemoryRuntimeStore();
    let releaseCas!: () => void;
    let casCommitted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCas = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      casCommitted = resolve;
    });
    let blockFirstCas = true;
    const store = new Proxy(base, {
      get(target, property) {
        if (property === "compareAndSetSession") {
          return async (
            ...args: Parameters<RuntimeStore["compareAndSetSession"]>
          ) => {
            const result = await target.compareAndSetSession(...args);
            if (blockFirstCas) {
              blockFirstCas = false;
              casCommitted();
              await gate;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "never-after-cancel",
      async generate() {
        providerCalls += 1;
        return { kind: "message", content: "bad", usage: USAGE };
      },
    };
    const { runtime } = harness(provider, { store });
    const session = await newSession(runtime);
    const running = runtime.runTurn({ sessionId: session.id, input: "go" });
    await committed;
    const cancelled = runtime.cancelSession(session.id, "cancel-in-cas-window");
    releaseCas();

    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(cancelled).resolves.toMatchObject({ status: "cancelled" });
    expect(providerCalls).toBe(0);
    const types = (
      await store.readEvents({ sessionId: session.id })
    ).events.map((event) => event.type);
    expect(types).not.toContain("model.requested");
  });

  it("cancels a compaction step after compactor abort without completing it or starting model work", async () => {
    const controller = new AbortController();
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "post-compaction-abort",
      async generate() {
        providerCalls += 1;
        return { kind: "message", content: "bad", usage: USAGE };
      },
    };
    const compactor: ContextCompactor = {
      shouldCompact: () => true,
      async compact(snapshot) {
        controller.abort(new Error("stop after compaction"));
        return { messages: snapshot.messages, summary: { compacted: true } };
      },
    };
    const { runtime, store } = harness(provider, { compactor });
    const session = await newSession(runtime);
    await expect(
      runtime.runTurn(
        { sessionId: session.id, input: "go" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    expect(providerCalls).toBe(0);
    const types = (
      await store.readEvents({ sessionId: session.id })
    ).events.map((event) => event.type);
    expect(types).toContain("step.cancelled");
    expect(types).not.toContain("context.compacted");
    expect(types).not.toContain("step.completed");
    expect(types).not.toContain("model.requested");
    expect(types.indexOf("step.cancelled")).toBeLessThan(
      types.indexOf("session.cancelled"),
    );
  });

  it("records a failed compaction step before turn and session failure transitions", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      id: "compaction-rejection",
      async generate() {
        providerCalls += 1;
        return { kind: "message", content: "bad", usage: USAGE };
      },
    };
    const compactor: ContextCompactor = {
      shouldCompact: () => true,
      async compact() {
        throw new Error("compactor failed");
      },
    };
    const { runtime, store } = harness(provider, { compactor });
    const session = await newSession(runtime);
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });

    expect(providerCalls).toBe(0);
    const events = (await store.readEvents({ sessionId: session.id })).events;
    const types = events.map((event) => event.type);
    const failedStepIndex = types.indexOf("step.failed");
    expect(failedStepIndex).toBeGreaterThan(-1);
    expect(failedStepIndex).toBeLessThan(
      types.indexOf("turn.status_changed", failedStepIndex),
    );
    expect(failedStepIndex).toBeLessThan(types.indexOf("session.failed"));
    const failedStep = events[failedStepIndex];
    expect(failedStep).toMatchObject({
      type: "step.failed",
      data: { error: { code: "PROVIDER_FAILED" } },
    });
  });

  it.each([
    ["maxSteps", { maxSteps: 0 }],
    ["maxModelCalls", { maxModelCalls: 0 }],
    ["maxInputTokens", { maxInputTokens: 0 }],
    ["maxOutputTokens", { maxOutputTokens: 0 }],
  ] as const)("enforces the hard %s budget", async (_name, limit) => {
    const provider = scriptedProvider([
      { kind: "message", content: "too much", usage: USAGE },
    ]);
    const { runtime } = harness(provider, { limits: limit });
    const session = await newSession(runtime);
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("bounds an infinite tool loop by maxToolCalls", async () => {
    const tool = defineTool({
      name: "again",
      description: "again",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      risk: "read",
      timeoutMs: 1_000,
      async execute() {
        return {};
      },
    });
    const call = {
      id: createId("ToolCallId", "loop"),
      name: "again",
      input: {},
    } as const;
    const provider = scriptedProvider(
      Array.from({ length: 10 }, () => ({
        kind: "tool_calls" as const,
        calls: [call],
        usage: USAGE,
      })),
    );
    const { runtime } = harness(provider, {
      tools: [tool],
      limits: { maxToolCalls: 2 },
    });
    const session = await newSession(runtime);
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "loop" }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(provider.requests.length).toBeLessThan(10);
  });

  it("fails invalid structured output and appends compaction without deleting source events", async () => {
    const compactor: ContextCompactor = {
      shouldCompact: () => true,
      async compact(snapshot) {
        return {
          messages: snapshot.messages.slice(-1),
          summary: { compacted: true },
        };
      },
    };
    const provider = scriptedProvider([
      { kind: "message", content: { wrong: true }, usage: USAGE },
    ]);
    const { runtime, store } = harness(provider, {
      outputSchema: z.object({ answer: z.string() }),
      compactor,
    });
    const session = await newSession(runtime);
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({ code: "STRUCTURED_OUTPUT_INVALID" });
    const events = (await store.readEvents({ sessionId: session.id })).events;
    expect(events[0]?.type).toBe("session.created");
    expect(events.some((event) => event.type === "context.compacted")).toBe(
      true,
    );
  });

  it("retries invalid structured output only when the retry policy explicitly classifies it transient", async () => {
    const provider = scriptedProvider([
      { kind: "message", content: { wrong: true }, usage: USAGE },
      { kind: "message", content: { answer: "valid" }, usage: USAGE },
    ]);
    const retry: RetryPolicy = {
      maxAttempts: 2,
      classify: (error) =>
        error instanceof RuntimeFailure &&
        error.code === "STRUCTURED_OUTPUT_INVALID"
          ? "transient"
          : "permanent",
      delayMs: () => 0,
    };
    const { runtime } = harness(provider, {
      outputSchema: z.object({ answer: z.string() }),
      retry,
    });
    const session = await newSession(runtime);
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).resolves.toMatchObject({ output: { answer: "valid" } });
    expect(provider.requests).toHaveLength(2);
  });

  it("reduces event history as a deterministic side-effect-free projection", () => {
    const events = [
      {
        protocolVersion: "1",
        id: createId("EventId", "model-requested"),
        cursor: 1,
        type: "model.requested",
        sessionId: createId("SessionId", "session"),
        correlationId: "correlation",
        occurredAt: "2026-08-30T00:00:00.000Z",
        data: { providerId: "p", model: "m", attempt: 1 },
      },
      {
        protocolVersion: "1",
        id: createId("EventId", "tool-started"),
        cursor: 2,
        type: "tool.requested",
        sessionId: createId("SessionId", "session"),
        correlationId: "correlation",
        occurredAt: "2026-08-30T00:00:00.000Z",
        data: {
          call: {
            id: createId("ToolCallId", "call"),
            name: "read",
            input: {},
          },
          idempotencyKey: "session:turn:call",
        },
      },
    ] as const satisfies readonly RuntimeEvent[];

    const first = reduceRuntimeEvents(events);
    const second = reduceRuntimeEvents(structuredClone(events));
    expect(first.modelCalls).toBe(1);
    expect(first.toolCalls).toBe(1);
    expect(second).toEqual(first);
    expect(events).toHaveLength(2);
  });

  it("faithfully projects session CAS metadata, terminal model output, and step state", () => {
    const sessionId = createId("SessionId", "projection-session");
    const turnId = createId("TurnId", "projection-turn");
    const stepId = createId("StepId", "projection-step");
    const occurredAt = "2026-08-30T00:00:00.000Z";
    const session = {
      id: sessionId,
      protocolVersion: "1" as const,
      agentId: createId("AgentId", "agent"),
      status: "idle" as const,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      version: 0,
      lastEventCursor: 0,
    };
    const turn = {
      id: turnId,
      sessionId,
      status: "queued" as const,
      input: "go",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    const step = {
      id: stepId,
      sessionId,
      turnId,
      index: 0,
      kind: "model" as const,
      status: "running" as const,
      startedAt: occurredAt,
    };
    const event = (cursor: number, type: string, data: object) => ({
      protocolVersion: "1" as const,
      id: createId("EventId", `projection-${cursor}`),
      cursor,
      type,
      sessionId,
      correlationId: "projection",
      occurredAt,
      data,
    });
    const events = [
      event(1, "session.created", { session }),
      { ...event(2, "turn.created", { turn }), turnId },
      event(3, "session.status_changed", { from: "idle", to: "running" }),
      {
        ...event(4, "turn.status_changed", {
          from: "queued",
          to: "running",
        }),
        turnId,
      },
      { ...event(5, "step.started", { step }), turnId, stepId },
      {
        ...event(6, "model.requested", {
          providerId: "p",
          model: "m",
          attempt: 1,
        }),
        turnId,
        stepId,
      },
      {
        ...event(7, "step.completed", { output: { answer: "done" } }),
        turnId,
        stepId,
      },
      {
        ...event(8, "turn.status_changed", {
          from: "running",
          to: "completed",
        }),
        turnId,
      },
      event(9, "session.status_changed", {
        from: "running",
        to: "completed",
      }),
    ] as RuntimeEvent[];

    const state = reduceRuntimeEvents(events);
    expect(state.session).toMatchObject({
      status: "completed",
      version: 2,
      lastEventCursor: 9,
    });
    expect(state.turns.get(turnId)).toMatchObject({
      status: "completed",
      output: { answer: "done" },
    });
    expect(state.steps.get(stepId)).toMatchObject({ status: "completed" });
    expect(state.modelCalls).toBe(1);
  });
});
