import { z } from "zod";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  InvalidToolRiskError,
  InvalidToolTimeoutError,
  UnsupportedToolOutputSchemaError,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolTimeoutError,
  defineTool,
  requiresExplicitPolicy,
  type ToolDefinition,
  type ToolExecutionContext,
} from "./index.js";

const context = {
  signal: new AbortController().signal,
  sessionId: "session" as ToolExecutionContext["sessionId"],
  turnId: "turn" as ToolExecutionContext["turnId"],
  stepId: "step" as ToolExecutionContext["stepId"],
  toolCallId: "call" as ToolExecutionContext["toolCallId"],
  idempotencyKey: "session:turn:call",
} satisfies ToolExecutionContext;

describe("defineTool", () => {
  it("types codec implementations with raw output and decodes exactly once", async () => {
    const codec = z.codec(z.string(), z.number(), {
      decode: (value) => Number(value),
      encode: (value) => String(value),
    });
    const tool = defineTool({
      name: "codec-output",
      description: "Decodes one raw string result",
      inputSchema: z.string().transform((value) => ({ value })),
      outputSchema: codec,
      risk: "read",
      timeoutMs: 1_000,
      execute: async ({ value }) => value,
    });

    expectTypeOf(tool.execute).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(tool.execute).returns.toEqualTypeOf<Promise<number>>();
    await expect(tool.execute("42", context)).resolves.toBe(42);
  });

  it("rejects transforming outputs while preserving input transforms and output refinements", async () => {
    const unsupportedExecute = vi.fn(async () => "value");

    expect(() =>
      defineTool({
        name: "transforming-output",
        description: "Unsupported output transform fixture",
        inputSchema: z.string(),
        outputSchema: z.string().transform((value) => ({ wrapped: value })),
        risk: "read",
        timeoutMs: 1_000,
        execute: unsupportedExecute,
      }),
    ).toThrow(UnsupportedToolOutputSchemaError);
    expect(unsupportedExecute).not.toHaveBeenCalled();

    const supported = defineTool({
      name: "validation-only-output",
      description: "Transforms input and refines output",
      inputSchema: z.string().transform((value) => ({ value })),
      outputSchema: z
        .object({ wrapped: z.string() })
        .refine(({ wrapped }) => wrapped.length > 0),
      risk: "read",
      timeoutMs: 1_000,
      execute: async ({ value }) => ({ wrapped: value }),
    });

    await expect(supported.execute("kept", context)).resolves.toEqual({
      wrapped: "kept",
    });
  });

  it("rejects non-finite or negative timeout declarations", () => {
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        defineTool({
          name: "invalid-timeout",
          description: "Invalid timeout fixture",
          inputSchema: z.object({}),
          outputSchema: z.object({}),
          risk: "read",
          timeoutMs,
          execute: async () => ({}),
        }),
      ).toThrow(InvalidToolTimeoutError);
    }
  });

  it("preserves schema inference and validates input before execution", async () => {
    const execute = vi.fn(async (input: { count: number }) => ({
      doubled: input.count * 2,
    }));
    const tool = defineTool({
      name: "double",
      description: "Doubles a count",
      inputSchema: z.object({ count: z.number().int() }),
      outputSchema: z.object({ doubled: z.number().int() }),
      risk: "read",
      timeoutMs: 1_000,
      execute,
    });
    expectTypeOf(tool.execute).parameter(0).toEqualTypeOf<{ count: number }>();
    await expect(tool.execute({ count: 4 }, context)).resolves.toEqual({
      doubled: 8,
    });
    await expect(
      tool.execute({ count: "4" } as never, context),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects output that does not satisfy the declared runtime schema", async () => {
    const tool = defineTool({
      name: "broken",
      description: "Returns an invalid fixture",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      risk: "draft",
      timeoutMs: 1_000,
      execute: async () => ({ ok: "yes" }) as never,
    });

    await expect(tool.execute({}, context)).rejects.toBeInstanceOf(
      ToolOutputValidationError,
    );
  });

  it("passes a combined caller-or-timeout signal and releases every timer", async () => {
    vi.useFakeTimers();
    const timeoutCaller = new AbortController();
    let timeoutCall: Promise<unknown> | undefined;
    const seenSignals: AbortSignal[] = [];
    let markCallerExecutionStarted!: () => void;
    const callerExecutionStarted = new Promise<void>((resolve) => {
      markCallerExecutionStarted = resolve;
    });

    try {
      const tool = defineTool({
        name: "wait-for-abort",
        description: "Waits until its signal aborts",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        risk: "read",
        timeoutMs: 50,
        execute: async (_input, executionContext) => {
          seenSignals.push(executionContext.signal);
          if (seenSignals.length === 2) markCallerExecutionStarted();
          return await new Promise<Record<string, never>>(() => undefined);
        },
      });

      timeoutCall = tool.execute(
        {},
        {
          ...context,
          signal: timeoutCaller.signal,
        },
      );
      const timeoutOutcome = timeoutCall.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      let timeoutSettled = false;
      void timeoutOutcome.then(() => {
        timeoutSettled = true;
      });
      await vi.advanceTimersByTimeAsync(50);

      expect(seenSignals[0]?.aborted).toBe(true);
      expect(timeoutSettled).toBe(true);
      expect(await timeoutOutcome).toMatchObject({
        status: "rejected",
        reason: expect.any(ToolTimeoutError),
      });
      expect(vi.getTimerCount()).toBe(0);

      const caller = new AbortController();
      const callerCall = tool.execute(
        {},
        { ...context, signal: caller.signal },
      );
      const callerOutcome = callerCall.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await callerExecutionStarted;
      caller.abort("caller-cancelled");
      await Promise.resolve();
      await Promise.resolve();

      expect(await callerOutcome).toEqual({
        status: "rejected",
        reason: "caller-cancelled",
      });
      expect(seenSignals[1]?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timeoutCaller.abort("test-cleanup");
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("enforces one timeout across async input and output validation", async () => {
    vi.useFakeTimers();
    try {
      for (const stage of ["input", "output"] as const) {
        const validationStarted = vi.fn();
        const hangingSchema = z.object({}).superRefine(async () => {
          validationStarted();
          await new Promise<void>(() => undefined);
        });
        const execute = vi.fn(async () => ({}));
        const tool = defineTool({
          name: `${stage}-timeout`,
          description: `Hangs during ${stage} validation`,
          inputSchema: stage === "input" ? hangingSchema : z.object({}),
          outputSchema: stage === "output" ? hangingSchema : z.object({}),
          risk: "read",
          timeoutMs: 50,
          execute,
        });
        const call = tool.execute({}, context);
        const outcome = call.then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        let settled = false;
        void outcome.then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(50);

        expect(validationStarted).toHaveBeenCalledOnce();
        expect(settled).toBe(true);
        expect(await outcome).toMatchObject({
          status: "rejected",
          reason: expect.any(ToolTimeoutError),
        });
        expect(execute).toHaveBeenCalledTimes(stage === "input" ? 0 : 1);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not invoke the implementation when the caller is already aborted", async () => {
    vi.useFakeTimers();
    try {
      const reason = new Error("cancelled-before-execution");
      const caller = new AbortController();
      caller.abort(reason);
      const inspectInput = vi.fn((value: unknown) => value);
      const execute = vi.fn(async () => ({}));
      const tool = defineTool({
        name: "pre-aborted",
        description: "Must not run after cancellation",
        inputSchema: z.preprocess(inspectInput, z.object({})),
        outputSchema: z.object({}),
        risk: "read",
        timeoutMs: 50,
        execute,
      });

      await expect(
        tool.execute({}, { ...context, signal: caller.signal }),
      ).rejects.toBe(reason);
      expect(inspectInput).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("snapshots definition behavior, metadata, schemas, and timeout", async () => {
    vi.useFakeTimers();
    try {
      const originalInputSchema = z.object({ value: z.number() });
      const originalOutputSchema = z.object({ source: z.string() });
      const originalExecute = vi.fn(async () => ({ source: "original" }));
      const definition: ToolDefinition<{ value: number }, { source: string }> =
        {
          name: "snapshot",
          description: "Original definition",
          inputSchema: originalInputSchema,
          outputSchema: originalOutputSchema,
          risk: "read",
          timeoutMs: 50,
          execute: originalExecute,
        };
      const tool = defineTool(definition);
      const mutable = definition as {
        -readonly [Key in keyof typeof definition]: (typeof definition)[Key];
      };
      const replacementExecute = vi.fn(async () => ({ source: "replacement" }));

      mutable.name = "replacement";
      mutable.description = "Replacement definition";
      mutable.inputSchema = z.object({ value: z.number() }).refine(() => false);
      mutable.outputSchema = z
        .object({ source: z.string() })
        .refine(() => false);
      mutable.risk = "privileged";
      mutable.timeoutMs = 0;
      mutable.execute = replacementExecute;

      await expect(tool.execute({ value: 1 }, context)).resolves.toEqual({
        source: "original",
      });
      expect(tool).toMatchObject({
        name: "snapshot",
        description: "Original definition",
        risk: "read",
        timeoutMs: 50,
      });
      expect(tool.inputSchema).toBe(originalInputSchema);
      expect(tool.outputSchema).toBe(originalOutputSchema);
      expect(Object.isFrozen(tool)).toBe(true);
      expect(originalExecute).toHaveBeenCalledOnce();
      expect(replacementExecute).not.toHaveBeenCalled();

      const hangingDefinition: ToolDefinition<
        Record<string, never>,
        Record<string, never>
      > = {
        name: "snapshotted-timeout",
        description: "Uses its original timeout",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        risk: "read",
        timeoutMs: 25,
        execute: async () =>
          await new Promise<Record<string, never>>(() => undefined),
      };
      const hangingTool = defineTool(hangingDefinition);
      const mutableHanging = hangingDefinition as {
        -readonly [
          Key in keyof typeof hangingDefinition
        ]: (typeof hangingDefinition)[Key];
      };
      mutableHanging.timeoutMs = 2_500;
      const timeoutOutcome = hangingTool.execute({}, context).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );

      await vi.advanceTimersByTimeAsync(25);

      expect(await timeoutOutcome).toMatchObject({
        status: "rejected",
        reason: expect.any(ToolTimeoutError),
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("tool risk metadata", () => {
  it("marks write and privileged tools for fail-closed policy handling", () => {
    expect(requiresExplicitPolicy("read")).toBe(false);
    expect(requiresExplicitPolicy("draft")).toBe(false);
    expect(requiresExplicitPolicy("write")).toBe(true);
    expect(requiresExplicitPolicy("privileged")).toBe(true);
  });

  it("rejects an unknown risk at definition time instead of treating it as read", () => {
    let executions = 0;
    expect(() =>
      defineTool({
        name: "admin-action",
        description: "declared risk is not a published one",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        risk: "admin" as never,
        timeoutMs: 1_000,
        async execute() {
          executions += 1;
          return { ok: true };
        },
      }),
    ).toThrowError(InvalidToolRiskError);
    expect(executions).toBe(0);
  });

  it("keeps every declared risk in the frozen snapshot", () => {
    for (const risk of ["read", "draft", "write", "privileged"] as const) {
      const tool = defineTool({
        name: `tool-${risk}`,
        description: "declared risk",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        risk,
        timeoutMs: 1_000,
        async execute() {
          return { ok: true };
        },
      });
      expect(tool.risk).toBe(risk);
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });
});
