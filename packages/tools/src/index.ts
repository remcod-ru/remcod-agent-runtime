import type {
  JsonValue,
  SessionId,
  StepId,
  ToolCallId,
  TurnId,
} from "@remcod/protocol";
import { z } from "zod";

export type ToolRisk = "read" | "draft" | "write" | "privileged";

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly toolCallId: ToolCallId;
  readonly idempotencyKey: string;
}

export interface ToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly risk: ToolRisk;
  readonly timeoutMs: number;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export type AnyTool = ToolDefinition<JsonValue, JsonValue>;

type ToolAuthoringDefinition<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> = Omit<
  ToolDefinition<z.output<InputSchema>, z.input<OutputSchema>>,
  "inputSchema" | "outputSchema"
> & {
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
};

type DefinedTool<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> = Omit<
  ToolDefinition<z.input<InputSchema>, z.output<OutputSchema>>,
  "inputSchema" | "outputSchema"
> & {
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
};

export class ToolInputValidationError extends Error {
  readonly code = "TOOL_INPUT_INVALID";
  readonly retryable = false;

  constructor(readonly validationError: z.ZodError) {
    super("Tool input does not satisfy its declared schema", {
      cause: validationError,
    });
    this.name = "ToolInputValidationError";
  }
}

export class ToolOutputValidationError extends Error {
  readonly code = "TOOL_OUTPUT_INVALID";
  readonly retryable = false;

  constructor(readonly validationError: z.ZodError) {
    super("Tool output does not satisfy its declared schema", {
      cause: validationError,
    });
    this.name = "ToolOutputValidationError";
  }
}

export class InvalidToolTimeoutError extends TypeError {
  readonly code = "INVALID_TOOL_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super("Tool timeoutMs must be finite and non-negative");
    this.name = "InvalidToolTimeoutError";
  }
}

export class ToolTimeoutError extends Error {
  readonly code = "TOOL_TIMEOUT";
  readonly retryable = false;

  constructor(readonly timeoutMs: number) {
    super(`Tool execution exceeded its ${timeoutMs}ms timeout`);
    this.name = "ToolTimeoutError";
  }
}

export class UnsupportedToolOutputSchemaError extends TypeError {
  readonly code = "UNSUPPORTED_TOOL_OUTPUT_SCHEMA";
  readonly retryable = false;

  constructor(
    readonly toolName: string,
    readonly schemaError: unknown,
  ) {
    super(`Tool ${toolName} output schema is not JSON-output representable`, {
      cause: schemaError,
    });
    this.name = "UnsupportedToolOutputSchemaError";
  }
}

function assertOutputSchemaRepresentable(
  toolName: string,
  outputSchema: z.ZodType,
): void {
  try {
    z.toJSONSchema(outputSchema, { io: "output" });
  } catch (error) {
    throw new UnsupportedToolOutputSchemaError(toolName, error);
  }
}

function createCombinedExecutionSignal(
  callerSignal: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly aborted: Promise<never>;
  dispose(): void;
} {
  const controller = new AbortController();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const rejectFromCombinedSignal = () =>
    rejectAborted(controller.signal.reason);
  controller.signal.addEventListener("abort", rejectFromCombinedSignal, {
    once: true,
  });
  const abortFromCaller = () => controller.abort(callerSignal.reason);

  if (callerSignal.aborted) {
    abortFromCaller();
  } else {
    callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = callerSignal.aborted
    ? undefined
    : setTimeout(
        () => controller.abort(new ToolTimeoutError(timeoutMs)),
        timeoutMs,
      );

  return {
    signal: controller.signal,
    aborted,
    dispose(): void {
      if (timeout !== undefined) clearTimeout(timeout);
      callerSignal.removeEventListener("abort", abortFromCaller);
      controller.signal.removeEventListener("abort", rejectFromCombinedSignal);
    },
  };
}

export function requiresExplicitPolicy(
  risk: ToolRisk,
): risk is "write" | "privileged" {
  return risk === "write" || risk === "privileged";
}

export function defineTool<
  const InputSchema extends z.ZodType,
  const OutputSchema extends z.ZodType,
>(
  definition: ToolAuthoringDefinition<InputSchema, OutputSchema>,
): DefinedTool<InputSchema, OutputSchema>;
export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  const captured = Object.freeze({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    risk: definition.risk,
    timeoutMs: definition.timeoutMs,
    execute: definition.execute,
  }) satisfies ToolDefinition<TInput, TOutput>;

  if (!Number.isFinite(captured.timeoutMs) || captured.timeoutMs < 0) {
    throw new InvalidToolTimeoutError(captured.timeoutMs);
  }
  assertOutputSchemaRepresentable(captured.name, captured.outputSchema);

  const execute = async (
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<TOutput> => {
    if (context.signal.aborted) {
      throw context.signal.reason;
    }
    const executionSignal = createCombinedExecutionSignal(
      context.signal,
      captured.timeoutMs,
    );
    try {
      const execution = (async (): Promise<TOutput> => {
        const parsedInput = await captured.inputSchema.safeParseAsync(input);
        if (!parsedInput.success) {
          throw new ToolInputValidationError(parsedInput.error);
        }
        if (executionSignal.signal.aborted) {
          throw executionSignal.signal.reason;
        }

        const output = await captured.execute(parsedInput.data, {
          ...context,
          signal: executionSignal.signal,
        });
        if (executionSignal.signal.aborted) {
          throw executionSignal.signal.reason;
        }

        const parsedOutput = await captured.outputSchema.safeParseAsync(output);
        if (!parsedOutput.success) {
          throw new ToolOutputValidationError(parsedOutput.error);
        }
        if (executionSignal.signal.aborted) {
          throw executionSignal.signal.reason;
        }
        return parsedOutput.data;
      })();

      return await Promise.race([execution, executionSignal.aborted]);
    } finally {
      executionSignal.dispose();
    }
  };

  return Object.freeze({ ...captured, execute });
}
