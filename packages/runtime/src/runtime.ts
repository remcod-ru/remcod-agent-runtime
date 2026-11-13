import {
  defaultRuntimeConfig,
  resolveRuntimeLimits,
  type AgentDefinition,
  type ContextCompactor,
  type ModelMessage,
  type RetryPolicy,
  type RuntimeLimits,
} from "@remcod/core";
import {
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  ProviderRegistry,
} from "@remcod/model-router";
import {
  PolicyError,
  digestToolAction,
  type ApprovalLedger,
  type PolicyAction,
  type PolicyEngine,
} from "@remcod/policy";
import {
  AgentIdSchema,
  JsonValueSchema,
  SessionIdSchema,
  ToolCallSchema,
  UsageSchema,
  createId,
  type AgentId,
  type BrandedId,
  type EventId,
  type JsonValue,
  type NewEvent,
  type RuntimeError,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type Session,
  type SessionId,
  type Step,
  type StepId,
  type ToolCall,
  type Turn,
  type TurnId,
  type Usage,
} from "@remcod/protocol";
import { requiresExplicitPolicy, type AnyTool } from "@remcod/tools";
import { z } from "zod";

import { reduceRuntimeEvents } from "./reducer.js";
import {
  SessionNotFoundError,
  type EventQuery,
  type RuntimeStore,
} from "./store.js";

export interface CreateSessionInput {
  readonly agentId: AgentId;
  readonly correlationId?: string;
}

export interface RunTurnInput {
  readonly sessionId: SessionId;
  readonly input: JsonValue;
  readonly expectedSessionVersion?: number;
}

export interface RunTurnResult {
  readonly session: Session;
  readonly turn: Turn;
  readonly output?: JsonValue;
  readonly usage: Usage;
}

export interface RuntimeConfig {
  readonly store: RuntimeStore;
  readonly providers: ProviderRegistry;
  readonly agents: readonly AgentDefinition[];
  readonly compactor?: ContextCompactor;
  readonly retry?: RetryPolicy;
  readonly defaults?: Partial<RuntimeLimits>;
  /**
   * Explicit capability policy. When present it replaces the legacy
   * `write`/`privileged` blanket refusal with a decision per exact action.
   */
  readonly policy?: PolicyEngine;
  /**
   * Trusted approval ledger. Only approvals issued by a server-side principal
   * can let a side-effecting tool run; the model never supplies a decision.
   */
  readonly approvals?: ApprovalLedger;
  readonly clock?: () => Date;
  readonly idFactory?: <Name extends string>(brand: Name) => BrandedId<Name>;
}

export interface AgentRuntime {
  createSession(input: CreateSessionInput): Promise<Session>;
  runTurn(
    input: RunTurnInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RunTurnResult>;
  cancelSession(sessionId: SessionId, reason?: string): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  events(query: EventQuery): AsyncIterable<RuntimeEvent>;
}

export class RuntimeFailure extends Error implements RuntimeError {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "RuntimeFailure";
  }
}

export class DuplicateAgentError extends RuntimeFailure {
  constructor(readonly agentId: string) {
    super(
      "VALIDATION_FAILED",
      `Duplicate agent definition: ${agentId}`,
      false,
      { agentId },
    );
    this.name = "DuplicateAgentError";
  }
}

export class UnknownAgentError extends RuntimeFailure {
  constructor(readonly agentId: string) {
    super("VALIDATION_FAILED", `Unknown agent: ${agentId}`, false, {
      agentId,
    });
    this.name = "UnknownAgentError";
  }
}

interface SnapshotAgent extends AgentDefinition {
  readonly tools: readonly AnyTool[];
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  finish(): void;
}

interface Counters {
  steps: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface CurrentStep {
  step: Step;
  terminal: boolean;
}

function runtimeError(
  error: unknown,
  fallback: RuntimeErrorCode,
): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  if (error instanceof Error) {
    const candidate = error as Error & {
      readonly code?: unknown;
      readonly retryable?: unknown;
    };
    const protocolCodes = new Set<RuntimeErrorCode>([
      "VALIDATION_FAILED",
      "INVALID_TRANSITION",
      "VERSION_CONFLICT",
      "CURSOR_CONFLICT",
      "PROVIDER_FAILED",
      "TOOL_FAILED",
      "POLICY_REQUIRED",
      "BUDGET_EXCEEDED",
      "CANCELLED",
      "STRUCTURED_OUTPUT_INVALID",
      "SCRIPT_EXHAUSTED",
    ]);
    const code =
      typeof candidate.code === "string" &&
      protocolCodes.has(candidate.code as RuntimeErrorCode)
        ? (candidate.code as RuntimeErrorCode)
        : fallback;
    return new RuntimeFailure(
      code,
      candidate.message || "Runtime operation failed",
      candidate.retryable === true,
    );
  }
  return new RuntimeFailure(fallback, "Runtime operation failed", false);
}

function serializeRuntimeError(error: RuntimeFailure): RuntimeError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details === undefined
      ? {}
      : { details: structuredClone(error.details) }),
  };
}

function snapshotAgent(definition: AgentDefinition): SnapshotAgent {
  if (!/\S/.test(definition.id)) {
    throw new RuntimeFailure(
      "VALIDATION_FAILED",
      "Agent ID cannot be blank",
      false,
    );
  }
  const tools = Object.freeze([...(definition.tools ?? [])]);
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new RuntimeFailure(
        "VALIDATION_FAILED",
        `Duplicate tool definition: ${tool.name}`,
        false,
      );
    }
    names.add(tool.name);
  }
  return Object.freeze({
    ...definition,
    model: Object.freeze({ ...definition.model }),
    tools,
    limits: definition.limits
      ? Object.freeze({ ...definition.limits })
      : undefined,
  });
}

function createActiveRun(): ActiveRun {
  const controller = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { controller, done, finish };
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Readonly<Record<string, JsonValue>>)[key] as JsonValue,
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolCallFingerprint(call: ToolCall): string {
  return canonicalJson({ input: call.input, name: call.name });
}

const structuralOutputValidators = new WeakMap<AnyTool, z.ZodType>();

function structuralOutputValidator(tool: AnyTool): z.ZodType {
  const cached = structuralOutputValidators.get(tool);
  if (cached) return cached;
  const validator = z.fromJSONSchema(
    z.toJSONSchema(tool.outputSchema, { io: "output" }),
  );
  structuralOutputValidators.set(tool, validator);
  return validator;
}

function asJsonSchema(schema: z.ZodType): JsonValue {
  return JsonValueSchema.parse(z.toJSONSchema(schema));
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error && error.name === "AbortError") ||
      ("code" in error && error.code === "CANCELLED"))
  );
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

class DefaultAgentRuntime implements AgentRuntime {
  readonly #store: RuntimeStore;
  readonly #providers: ProviderRegistry;
  readonly #agents: ReadonlyMap<string, SnapshotAgent>;
  readonly #compactor: ContextCompactor;
  readonly #retry: RetryPolicy;
  readonly #defaults: RuntimeLimits;
  readonly #clock: () => Date;
  readonly #idFactory: <Name extends string>(brand: Name) => BrandedId<Name>;
  readonly #policy: PolicyEngine | undefined;
  readonly #approvals: ApprovalLedger | undefined;
  readonly #active = new Map<SessionId, ActiveRun>();

  constructor(config: RuntimeConfig) {
    this.#store = config.store;
    this.#providers = config.providers;
    this.#compactor = config.compactor ?? defaultRuntimeConfig.compactor;
    this.#retry = config.retry ?? defaultRuntimeConfig.retry;
    this.#defaults = resolveRuntimeLimits(config.defaults);
    this.#policy = config.policy;
    this.#approvals = config.approvals;
    if (this.#approvals !== undefined && this.#policy === undefined) {
      throw new TypeError("approvals require an explicit policy engine");
    }
    this.#clock = config.clock ?? (() => new Date());
    this.#idFactory = config.idFactory ?? createId;
    if (
      !Number.isInteger(this.#retry.maxAttempts) ||
      this.#retry.maxAttempts < 1
    ) {
      throw new TypeError("retry.maxAttempts must be a positive integer");
    }
    const agents = new Map<string, SnapshotAgent>();
    for (const definition of [...config.agents]) {
      if (agents.has(definition.id))
        throw new DuplicateAgentError(definition.id);
      agents.set(definition.id, snapshotAgent(definition));
    }
    this.#agents = agents;
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #id<Name extends string>(brand: Name): BrandedId<Name> {
    return this.#idFactory(brand);
  }

  #agent(agentId: string): SnapshotAgent {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new UnknownAgentError(agentId);
    return agent;
  }

  #newEvent(
    type: NewEvent["type"],
    data: JsonValue,
    correlationId: string,
    identity: { readonly turnId?: TurnId; readonly stepId?: StepId } = {},
  ): NewEvent {
    return {
      id: this.#id("EventId") as EventId,
      type,
      correlationId,
      occurredAt: this.#now(),
      ...identity,
      data,
    } as NewEvent;
  }

  async #append(
    sessionId: SessionId,
    events: readonly NewEvent[],
  ): Promise<void> {
    const current = await this.#store.getSession(sessionId);
    if (!current) throw new SessionNotFoundError(sessionId);
    await this.#store.appendEvents(sessionId, current.lastEventCursor, events);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const agentId = AgentIdSchema.parse(input.agentId);
    this.#agent(agentId);
    const now = this.#now();
    const session: Session = {
      id: this.#id("SessionId") as SessionId,
      protocolVersion: "1",
      agentId,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      version: 0,
      lastEventCursor: 0,
    };
    const correlationId = input.correlationId ?? session.id;
    return this.#store.createSession(
      session,
      this.#newEvent("session.created", { session }, correlationId),
    );
  }

  async getSession(sessionId: SessionId): Promise<Session | null> {
    return this.#store.getSession(SessionIdSchema.parse(sessionId));
  }

  async *events(query: EventQuery): AsyncIterable<RuntimeEvent> {
    let afterCursor = query.afterCursor;
    while (true) {
      const page = await this.#store.readEvents({ ...query, afterCursor });
      for (const event of page.events) yield event;
      if (page.nextCursor === null) return;
      afterCursor = page.nextCursor;
    }
  }

  async cancelSession(sessionId: SessionId, reason?: string): Promise<Session> {
    const id = SessionIdSchema.parse(sessionId);
    const active = this.#active.get(id);
    if (active) {
      active.controller.abort(
        new RuntimeFailure("CANCELLED", reason ?? "Session cancelled", false),
      );
      await active.done;
      const cancelled = await this.#store.getSession(id);
      if (!cancelled) throw new SessionNotFoundError(id);
      return cancelled;
    }
    const current = await this.#store.getSession(id);
    if (!current) throw new SessionNotFoundError(id);
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      return current;
    }
    const now = this.#now();
    return this.#store.compareAndSetSession(
      id,
      current.version,
      { status: "cancelled", updatedAt: now },
      [
        this.#newEvent(
          "session.status_changed",
          {
            from: current.status,
            to: "cancelled",
            ...(reason ? { reason } : {}),
          },
          id,
        ),
        this.#newEvent("session.cancelled", reason ? { reason } : {}, id),
      ],
    );
  }

  runTurn(
    input: RunTurnInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RunTurnResult> {
    const sessionId = SessionIdSchema.parse(input.sessionId);
    if (this.#active.has(sessionId)) {
      return Promise.reject(
        new RuntimeFailure(
          "VERSION_CONFLICT",
          "A turn is already running for this session",
          false,
        ),
      );
    }
    const active = createActiveRun();
    this.#active.set(sessionId, active);
    return this.#runRegisteredTurn(input, options, sessionId, active).finally(
      () => {
        this.#active.delete(sessionId);
        active.finish();
      },
    );
  }

  async #runRegisteredTurn(
    input: RunTurnInput,
    options: { readonly signal?: AbortSignal },
    sessionId: SessionId,
    active: ActiveRun,
  ): Promise<RunTurnResult> {
    const turnInput = JsonValueSchema.parse(input.input);
    const initial = await this.#store.getSession(sessionId);
    if (!initial) throw new SessionNotFoundError(sessionId);
    const agent = this.#agent(initial.agentId);
    const provider = this.#providers.resolve(agent.model);
    const limits = resolveRuntimeLimits(agent.limits ?? this.#defaults);
    if (
      !["idle", "waiting_input", "waiting_next_turn"].includes(initial.status)
    ) {
      throw new RuntimeFailure(
        "INVALID_TRANSITION",
        `Session cannot start a turn from ${initial.status}`,
        false,
      );
    }
    const expectedVersion = input.expectedSessionVersion ?? initial.version;
    const correlationId = sessionId;
    const now = this.#now();
    let turn: Turn = {
      id: this.#id("TurnId") as TurnId,
      sessionId,
      status: "queued",
      input: turnInput,
      createdAt: now,
      updatedAt: now,
    };
    let session = await this.#store.compareAndSetSession(
      sessionId,
      expectedVersion,
      { status: "running", updatedAt: now },
      [
        this.#newEvent("turn.created", { turn }, correlationId, {
          turnId: turn.id,
        }),
        this.#newEvent(
          "session.status_changed",
          { from: initial.status, to: "running" },
          correlationId,
          { turnId: turn.id },
        ),
      ],
    );
    turn = { ...turn, status: "running", updatedAt: this.#now() };
    await this.#append(sessionId, [
      this.#newEvent(
        "turn.status_changed",
        { from: "queued", to: "running" },
        correlationId,
        { turnId: turn.id },
      ),
    ]);

    const signal = options.signal
      ? AbortSignal.any([options.signal, active.controller.signal])
      : active.controller.signal;
    const counters: Counters = {
      steps: 0,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let currentStep: CurrentStep | null = null;

    try {
      if (signal.aborted) throw signal.reason;
      const priorEvents = (await this.#store.readEvents({ sessionId })).events;
      reduceRuntimeEvents(priorEvents);
      const instructions =
        typeof agent.instructions === "string"
          ? agent.instructions
          : await agent.instructions({ session, priorEvents });
      let messages: readonly ModelMessage[] = [
        { role: "system", content: instructions },
        { role: "user", content: turnInput },
      ];

      while (true) {
        if (signal.aborted) throw signal.reason;
        const compacted = await this.#compactIfNeeded(
          session,
          turn,
          messages,
          limits,
          counters,
          correlationId,
          signal,
        );
        messages = compacted;
        this.#assertBudget(
          "maxInputTokens",
          estimateTokens(messages),
          limits.maxInputTokens,
        );
        currentStep = await this.#startStep(
          session,
          turn,
          "model",
          counters,
          limits,
          correlationId,
        );
        const response = await this.#generate(
          provider,
          agent,
          turn,
          messages,
          limits,
          counters,
          currentStep.step,
          correlationId,
          signal,
        );
        const output =
          response.kind === "message"
            ? await this.#validateStructuredOutput(agent, response.content)
            : response.calls;
        await this.#append(sessionId, [
          this.#newEvent(
            "model.completed",
            { responseKind: response.kind, usage: response.usage },
            correlationId,
            { turnId: turn.id, stepId: currentStep.step.id },
          ),
          this.#newEvent(
            "step.completed",
            { output, usage: response.usage },
            correlationId,
            { turnId: turn.id, stepId: currentStep.step.id },
          ),
        ]);
        currentStep.terminal = true;

        if (response.kind === "message") {
          turn = {
            ...turn,
            status: "completed",
            output,
            updatedAt: this.#now(),
          };
          session = await this.#store.compareAndSetSession(
            sessionId,
            session.version,
            { status: "completed", updatedAt: this.#now() },
            [
              this.#newEvent(
                "turn.status_changed",
                { from: "running", to: "completed" },
                correlationId,
                { turnId: turn.id },
              ),
              this.#newEvent(
                "session.status_changed",
                { from: "running", to: "completed" },
                correlationId,
                { turnId: turn.id },
              ),
              this.#newEvent("session.completed", { output }, correlationId, {
                turnId: turn.id,
              }),
            ],
          );
          return {
            session,
            turn,
            output,
            usage: this.#usage(counters),
          };
        }

        const toolMessages = await this.#executeTools(
          agent.tools,
          response.calls,
          session,
          turn,
          counters,
          limits,
          correlationId,
          signal,
          (step) => {
            currentStep = step;
          },
        );
        currentStep = null;
        messages = [
          ...messages,
          { role: "assistant", content: { toolCalls: response.calls } },
          ...toolMessages,
        ];
      }
    } catch (error) {
      const cancelled = isCancellation(error, signal);
      const failure = cancelled
        ? new RuntimeFailure(
            "CANCELLED",
            error instanceof Error ? error.message : "Turn cancelled",
            false,
          )
        : runtimeError(error, "PROVIDER_FAILED");
      if (currentStep && !currentStep.terminal) {
        await this.#append(sessionId, [
          this.#newEvent(
            cancelled ? "step.cancelled" : "step.failed",
            cancelled ? {} : { error: serializeRuntimeError(failure) },
            correlationId,
            { turnId: turn.id, stepId: currentStep.step.id },
          ),
        ]);
        currentStep.terminal = true;
      }
      turn = {
        ...turn,
        status: cancelled ? "cancelled" : "failed",
        updatedAt: this.#now(),
      };
      const latest = await this.#store.getSession(sessionId);
      if (latest && latest.status === "running") {
        session = await this.#store.compareAndSetSession(
          sessionId,
          latest.version,
          {
            status: cancelled ? "cancelled" : "failed",
            updatedAt: this.#now(),
          },
          [
            this.#newEvent(
              "turn.status_changed",
              {
                from: "running",
                to: cancelled ? "cancelled" : "failed",
                reason: failure.message,
              },
              correlationId,
              { turnId: turn.id },
            ),
            this.#newEvent(
              "session.status_changed",
              {
                from: "running",
                to: cancelled ? "cancelled" : "failed",
                reason: failure.message,
              },
              correlationId,
              { turnId: turn.id },
            ),
            this.#newEvent(
              cancelled ? "session.cancelled" : "session.failed",
              cancelled
                ? { reason: failure.message }
                : { error: serializeRuntimeError(failure) },
              correlationId,
              { turnId: turn.id },
            ),
          ],
        );
      }
      throw failure;
    }
  }

  #usage(counters: Counters): Usage {
    return {
      inputTokens: counters.inputTokens,
      outputTokens: counters.outputTokens,
      totalTokens: counters.totalTokens,
    };
  }

  #assertBudget(
    name: keyof RuntimeLimits,
    actual: number,
    limit: number,
  ): void {
    if (actual > limit) {
      throw new RuntimeFailure(
        "BUDGET_EXCEEDED",
        `${name} budget exceeded`,
        false,
        { budget: name, actual, limit },
      );
    }
  }

  #consumeUsage(counters: Counters, usage: Usage, limits: RuntimeLimits): void {
    counters.inputTokens += usage.inputTokens;
    counters.outputTokens += usage.outputTokens;
    counters.totalTokens += usage.totalTokens;
    this.#assertBudget(
      "maxInputTokens",
      counters.inputTokens,
      limits.maxInputTokens,
    );
    this.#assertBudget(
      "maxOutputTokens",
      counters.outputTokens,
      limits.maxOutputTokens,
    );
  }

  async #startStep(
    session: Session,
    turn: Turn,
    kind: Step["kind"],
    counters: Counters,
    limits: RuntimeLimits,
    correlationId: string,
  ): Promise<CurrentStep> {
    this.#assertBudget("maxSteps", counters.steps + 1, limits.maxSteps);
    const step: Step = {
      id: this.#id("StepId") as StepId,
      sessionId: session.id,
      turnId: turn.id,
      index: counters.steps,
      kind,
      status: "running",
      startedAt: this.#now(),
    };
    counters.steps += 1;
    await this.#append(session.id, [
      this.#newEvent("step.started", { step }, correlationId, {
        turnId: turn.id,
        stepId: step.id,
      }),
    ]);
    return { step, terminal: false };
  }

  async #compactIfNeeded(
    session: Session,
    turn: Turn,
    messages: readonly ModelMessage[],
    limits: RuntimeLimits,
    counters: Counters,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<readonly ModelMessage[]> {
    const beforeTokens = estimateTokens(messages);
    const snapshot = {
      instructions:
        typeof messages[0]?.content === "string" ? messages[0].content : "",
      messages,
      estimatedTokens: beforeTokens,
    };
    if (!this.#compactor.shouldCompact(snapshot, limits)) return messages;
    if (signal.aborted) throw signal.reason;
    const current = await this.#startStep(
      session,
      turn,
      "compaction",
      counters,
      limits,
      correlationId,
    );
    let result: Awaited<ReturnType<ContextCompactor["compact"]>>;
    try {
      result = await this.#compactor.compact(snapshot);
    } catch (error) {
      if (isCancellation(error, signal)) {
        const reason =
          signal.reason instanceof Error
            ? signal.reason.message
            : "Compaction cancelled";
        await this.#append(session.id, [
          this.#newEvent("step.cancelled", { reason }, correlationId, {
            turnId: turn.id,
            stepId: current.step.id,
          }),
        ]);
        current.terminal = true;
        throw error;
      }
      const failure = runtimeError(error, "PROVIDER_FAILED");
      await this.#append(session.id, [
        this.#newEvent(
          "step.failed",
          { error: serializeRuntimeError(failure) },
          correlationId,
          { turnId: turn.id, stepId: current.step.id },
        ),
      ]);
      current.terminal = true;
      throw failure;
    }
    if (signal.aborted) {
      const reason =
        signal.reason instanceof Error
          ? signal.reason.message
          : "Compaction cancelled";
      await this.#append(session.id, [
        this.#newEvent("step.cancelled", { reason }, correlationId, {
          turnId: turn.id,
          stepId: current.step.id,
        }),
      ]);
      current.terminal = true;
      throw signal.reason;
    }
    const compactedMessages = Object.freeze([...result.messages]);
    const afterTokens = estimateTokens(compactedMessages);
    await this.#append(session.id, [
      this.#newEvent(
        "context.compacted",
        { beforeTokens, afterTokens, summary: result.summary },
        correlationId,
        { turnId: turn.id, stepId: current.step.id },
      ),
      this.#newEvent(
        "step.completed",
        { output: result.summary },
        correlationId,
        { turnId: turn.id, stepId: current.step.id },
      ),
    ]);
    current.terminal = true;
    return compactedMessages;
  }

  async #generate(
    provider: ModelProvider,
    agent: SnapshotAgent,
    turn: Turn,
    messages: readonly ModelMessage[],
    limits: RuntimeLimits,
    counters: Counters,
    step: Step,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      this.#assertBudget(
        "maxModelCalls",
        counters.modelCalls + 1,
        limits.maxModelCalls,
      );
      counters.modelCalls += 1;
      await this.#append(turn.sessionId, [
        this.#newEvent(
          "model.requested",
          {
            providerId: agent.model.providerId,
            model: agent.model.model,
            attempt,
          },
          correlationId,
          { turnId: turn.id, stepId: step.id },
        ),
      ]);
      const remaining: RuntimeLimits = {
        maxSteps: limits.maxSteps - counters.steps,
        maxModelCalls: limits.maxModelCalls - counters.modelCalls,
        maxToolCalls: limits.maxToolCalls - counters.toolCalls,
        maxInputTokens: limits.maxInputTokens - counters.inputTokens,
        maxOutputTokens: limits.maxOutputTokens - counters.outputTokens,
      };
      const request: ModelRequest = {
        model: agent.model.model,
        messages,
        tools: agent.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: asJsonSchema(tool.inputSchema),
        })),
        ...(agent.outputSchema
          ? { outputSchema: asJsonSchema(agent.outputSchema) }
          : {}),
        remaining,
      };
      let response: ModelResponse;
      try {
        response = await provider.generate(request, { signal });
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        const failure = runtimeError(error, "PROVIDER_FAILED");
        await this.#append(turn.sessionId, [
          this.#newEvent(
            "model.failed",
            { error: serializeRuntimeError(failure), attempt },
            correlationId,
            { turnId: turn.id, stepId: step.id },
          ),
        ]);
        const transient = this.#retry.classify(failure) === "transient";
        if (!transient || attempt >= this.#retry.maxAttempts) throw failure;
        this.#assertBudget(
          "maxModelCalls",
          counters.modelCalls + 1,
          limits.maxModelCalls,
        );
        await abortableDelay(this.#retry.delayMs(attempt), signal);
        continue;
      }
      if (signal.aborted) throw signal.reason;
      const validated = this.#validateModelResponse(response);
      this.#consumeUsage(counters, validated.usage, limits);
      if (validated.kind === "message" && agent.outputSchema) {
        try {
          return {
            ...validated,
            content: await this.#validateStructuredOutput(
              agent,
              validated.content,
            ),
          };
        } catch (error) {
          const failure = runtimeError(error, "STRUCTURED_OUTPUT_INVALID");
          await this.#append(turn.sessionId, [
            this.#newEvent(
              "model.failed",
              { error: serializeRuntimeError(failure), attempt },
              correlationId,
              { turnId: turn.id, stepId: step.id },
            ),
          ]);
          const transient = this.#retry.classify(failure) === "transient";
          if (!transient || attempt >= this.#retry.maxAttempts) throw failure;
          this.#assertBudget(
            "maxModelCalls",
            counters.modelCalls + 1,
            limits.maxModelCalls,
          );
          await abortableDelay(this.#retry.delayMs(attempt), signal);
          continue;
        }
      }
      return validated;
    }
  }

  #validateModelResponse(response: ModelResponse): ModelResponse {
    try {
      const usage = UsageSchema.parse(response.usage);
      if (response.kind === "message") {
        return {
          kind: "message",
          content: JsonValueSchema.parse(response.content),
          usage,
        };
      }
      if (response.kind === "tool_calls") {
        return {
          kind: "tool_calls",
          calls: response.calls.map((call) => ToolCallSchema.parse(call)),
          usage,
        };
      }
      throw new RuntimeFailure(
        "VALIDATION_FAILED",
        "Unknown model response kind",
        false,
      );
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw new RuntimeFailure(
        "VALIDATION_FAILED",
        "Model response does not satisfy the runtime contract",
        false,
      );
    }
  }

  async #validateStructuredOutput(
    agent: SnapshotAgent,
    content: JsonValue,
  ): Promise<JsonValue> {
    if (!agent.outputSchema) return content;
    const parsed = await agent.outputSchema.safeParseAsync(content);
    if (!parsed.success) {
      throw new RuntimeFailure(
        "STRUCTURED_OUTPUT_INVALID",
        "Model output does not satisfy the agent output schema",
        false,
        { issues: parsed.error.issues as unknown as JsonValue },
      );
    }
    return JsonValueSchema.parse(parsed.data);
  }

  async #executeTools(
    tools: readonly AnyTool[],
    calls: readonly ToolCall[],
    session: Session,
    turn: Turn,
    counters: Counters,
    limits: RuntimeLimits,
    correlationId: string,
    signal: AbortSignal,
    setCurrent: (step: CurrentStep) => void,
  ): Promise<readonly ModelMessage[]> {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const messages: ModelMessage[] = [];
    for (const call of calls) {
      if (signal.aborted) throw signal.reason;
      this.#assertBudget(
        "maxToolCalls",
        counters.toolCalls + 1,
        limits.maxToolCalls,
      );
      const current = await this.#startStep(
        session,
        turn,
        "tool",
        counters,
        limits,
        correlationId,
      );
      setCurrent(current);
      counters.toolCalls += 1;
      const key = `${session.id}:${turn.id}:${call.id}`;
      await this.#append(session.id, [
        this.#newEvent(
          "tool.requested",
          { call, idempotencyKey: key },
          correlationId,
          { turnId: turn.id, stepId: current.step.id },
        ),
      ]);
      const tool = byName.get(call.name);
      if (!tool) {
        const failure = new RuntimeFailure(
          "TOOL_FAILED",
          `Unknown tool: ${call.name}`,
          false,
          { toolName: call.name },
        );
        await this.#recordToolFailure(
          session.id,
          turn.id,
          current,
          call,
          failure,
          correlationId,
        );
        messages.push(this.#toolFailureMessage(call, failure));
        continue;
      }
      if (this.#policy) {
        const policyAction: PolicyAction = {
          policyVersion: this.#policy.policyVersion,
          policyDigest: this.#policy.policyDigest,
          sessionId: session.id,
          turnId: turn.id,
          stepId: current.step.id,
          toolCallId: call.id,
          toolName: tool.name,
          risk: tool.risk,
          inputDigest: digestToolAction({
            toolName: tool.name,
            input: call.input,
          }),
        };
        const decision = this.#policy.evaluate(policyAction);
        if (decision.outcome === "deny") {
          const failure = new RuntimeFailure(
            "POLICY_REQUIRED",
            `Tool ${tool.name} is denied by policy: ${decision.reason}`,
            false,
            {
              inputDigest: policyAction.inputDigest,
              outcome: "denied",
              reason: decision.reason,
              risk: tool.risk,
              toolName: tool.name,
            },
          );
          await this.#recordToolFailure(
            session.id,
            turn.id,
            current,
            call,
            failure,
            correlationId,
          );
          throw failure;
        }
        if (decision.outcome === "require_approval") {
          const approvals = this.#approvals;
          if (!approvals) {
            const failure = new RuntimeFailure(
              "POLICY_REQUIRED",
              `Tool ${tool.name} requires an explicit policy decision: ${decision.reason}`,
              false,
              {
                inputDigest: policyAction.inputDigest,
                outcome: "approval_required",
                risk: tool.risk,
                toolName: tool.name,
              },
            );
            await this.#recordToolFailure(
              session.id,
              turn.id,
              current,
              call,
              failure,
              correlationId,
            );
            throw failure;
          }
          try {
            approvals.consume(policyAction);
          } catch (error) {
            const approvalCode =
              error instanceof PolicyError ? error.code : "APPROVAL_MISMATCH";
            const failure = new RuntimeFailure(
              "POLICY_REQUIRED",
              `Tool ${tool.name} requires an approval bound to this exact action`,
              false,
              {
                approval: approvalCode,
                inputDigest: policyAction.inputDigest,
                outcome: "approval_rejected",
                risk: tool.risk,
                toolName: tool.name,
              },
            );
            await this.#recordToolFailure(
              session.id,
              turn.id,
              current,
              call,
              failure,
              correlationId,
            );
            throw failure;
          }
        }
      } else if (requiresExplicitPolicy(tool.risk)) {
        const failure = new RuntimeFailure(
          "POLICY_REQUIRED",
          `Tool ${tool.name} requires an explicit policy decision`,
          false,
          { toolName: tool.name, risk: tool.risk },
        );
        await this.#recordToolFailure(
          session.id,
          turn.id,
          current,
          call,
          failure,
          correlationId,
        );
        throw failure;
      }
      const inputValidation = await tool.inputSchema.safeParseAsync(call.input);
      if (!inputValidation.success) {
        const failure = new RuntimeFailure(
          "VALIDATION_FAILED",
          `Tool ${tool.name} input does not satisfy its schema`,
          false,
          {
            toolName: tool.name,
            issues: inputValidation.error.issues as unknown as JsonValue,
          },
        );
        await this.#recordToolFailure(
          session.id,
          turn.id,
          current,
          call,
          failure,
          correlationId,
        );
        messages.push(this.#toolFailureMessage(call, failure));
        continue;
      }
      const fingerprint = toolCallFingerprint(call);
      const claim = await this.#store.claimIdempotency(
        "tool",
        key,
        fingerprint,
      );
      if (claim.status === "completed") {
        let cached: Awaited<ReturnType<z.ZodType["safeParseAsync"]>>;
        try {
          cached = await structuralOutputValidator(tool).safeParseAsync(
            claim.value,
          );
        } catch (error) {
          const failure = runtimeError(error, "TOOL_FAILED");
          await this.#recordToolFailure(
            session.id,
            turn.id,
            current,
            call,
            failure,
            correlationId,
          );
          messages.push(this.#toolFailureMessage(call, failure));
          continue;
        }
        if (!cached.success) {
          const failure = new RuntimeFailure(
            "TOOL_FAILED",
            `Cached output for tool ${tool.name} does not satisfy its schema`,
            false,
            {
              toolName: tool.name,
              issues: cached.error.issues as unknown as JsonValue,
            },
          );
          await this.#recordToolFailure(
            session.id,
            turn.id,
            current,
            call,
            failure,
            correlationId,
          );
          messages.push(this.#toolFailureMessage(call, failure));
          continue;
        }
        const cachedOutput = claim.value;
        await this.#recordToolSuccess(
          session.id,
          turn.id,
          current,
          call,
          cachedOutput,
          correlationId,
        );
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: cachedOutput,
        });
        continue;
      }
      if (claim.status === "in_flight" || claim.status === "conflict") {
        const failure = new RuntimeFailure(
          "TOOL_FAILED",
          claim.status === "conflict"
            ? `Tool ${tool.name} reused a call ID with a different fingerprint`
            : `Tool ${tool.name} has an ambiguous in-flight idempotency claim`,
          false,
          {
            toolName: tool.name,
            idempotencyKey: key,
            claimStatus: claim.status,
          },
        );
        await this.#recordToolFailure(
          session.id,
          turn.id,
          current,
          call,
          failure,
          correlationId,
        );
        throw failure;
      }
      await this.#append(session.id, [
        this.#newEvent(
          "tool.started",
          { toolCallId: call.id, toolName: call.name },
          correlationId,
          { turnId: turn.id, stepId: current.step.id },
        ),
      ]);
      let jsonOutput: JsonValue;
      try {
        const output = await tool.execute(call.input, {
          signal,
          sessionId: session.id,
          turnId: turn.id,
          stepId: current.step.id,
          toolCallId: call.id,
          idempotencyKey: key,
        });
        if (signal.aborted) throw signal.reason;
        jsonOutput = JsonValueSchema.parse(output);
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        const failure = runtimeError(error, "TOOL_FAILED");
        await this.#recordToolFailure(
          session.id,
          turn.id,
          current,
          call,
          failure,
          correlationId,
        );
        messages.push(this.#toolFailureMessage(call, failure));
        continue;
      }
      try {
        await this.#store.completeIdempotency("tool", key, jsonOutput);
      } catch (error) {
        const failure = runtimeError(error, "TOOL_FAILED");
        await this.#recordToolFailure(
          session.id,
          turn.id,
          current,
          call,
          failure,
          correlationId,
        );
        throw failure;
      }
      await this.#recordToolSuccess(
        session.id,
        turn.id,
        current,
        call,
        jsonOutput,
        correlationId,
      );
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: jsonOutput,
      });
    }
    return messages;
  }

  #toolFailureMessage(call: ToolCall, failure: RuntimeFailure): ModelMessage {
    return {
      role: "tool",
      toolCallId: call.id,
      content: { error: serializeRuntimeError(failure) },
    };
  }

  async #recordToolSuccess(
    sessionId: SessionId,
    turnId: TurnId,
    current: CurrentStep,
    call: ToolCall,
    output: JsonValue,
    correlationId: string,
  ): Promise<void> {
    await this.#append(sessionId, [
      this.#newEvent(
        "tool.completed",
        { toolCallId: call.id, output },
        correlationId,
        { turnId, stepId: current.step.id },
      ),
      this.#newEvent("step.completed", { output }, correlationId, {
        turnId,
        stepId: current.step.id,
      }),
    ]);
    current.terminal = true;
  }

  async #recordToolFailure(
    sessionId: SessionId,
    turnId: TurnId,
    current: CurrentStep,
    call: ToolCall,
    failure: RuntimeFailure,
    correlationId: string,
  ): Promise<void> {
    await this.#append(sessionId, [
      this.#newEvent(
        "tool.failed",
        { toolCallId: call.id, error: serializeRuntimeError(failure) },
        correlationId,
        { turnId, stepId: current.step.id },
      ),
      this.#newEvent(
        "step.failed",
        { error: serializeRuntimeError(failure) },
        correlationId,
        { turnId, stepId: current.step.id },
      ),
    ]);
    current.terminal = true;
  }
}

export function createRuntime(config: RuntimeConfig): AgentRuntime {
  return new DefaultAgentRuntime(config);
}
