# Public API Reference

This reference describes the current Phase 1 package exports. Package names and
versions remain private and provisional. Import package specifiers only; deep
imports are unsupported except for the explicit `@remcod/runtime/transport` export.

## Curated SDK

Most agent authors should import from `@remcod/sdk`:

```ts
import {
  ProviderRegistry,
  ScriptedModel,
  createApprovalLedger,
  createId,
  createInMemoryRuntimeStore,
  createPolicyEngine,
  createRuntime,
  defineAgent,
  defineTool,
  z,
} from "@remcod/sdk";
```

The SDK re-exports selected types for agents, models, protocol records/events,
runtime/store, policy decisions and approvals, transport, scripted testing, and
tools. It does not re-export package internals or every protocol schema.

## Agent and model contracts

```ts
interface AgentDefinition<TOutput extends JsonValue = JsonValue> {
  id: string;
  name: string;
  instructions: string | InstructionBuilder;
  model: { providerId: string; model: string };
  tools?: readonly AnyTool[];
  outputSchema?: z.ZodType<TOutput>;
  limits?: RuntimeLimits;
}

function defineAgent<TOutput extends JsonValue = JsonValue>(
  definition: AgentDefinition<TOutput>,
): AgentDefinition<TOutput>;

interface ModelProvider {
  readonly id: string;
  generate(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): Promise<ModelResponse>;
}

type ModelResponse =
  | { kind: "message"; content: JsonValue; usage: Usage }
  | { kind: "tool_calls"; calls: readonly ToolCall[]; usage: Usage };
```

`ProviderRegistry.register(provider)` rejects duplicate provider IDs.
`ProviderRegistry.resolve(selector)` resolves the exact `providerId` or throws.
Credentials and tenant/authorization context are absent from `ModelRequest`.

## Tool contract

```ts
const tool = defineTool({
  name: "add",
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
  outputSchema: z.number(),
  risk: "read",
  timeoutMs: 1_000,
  async execute(input, context) {
    return input.a + input.b;
  },
});
```

Risks are `read | draft | write | privileged`. Tool context contains the combined
abort/timeout signal, session/turn/step/tool-call IDs, and idempotency key. The
author implementation receives normalized `z.output<InputSchema>` and returns
raw `z.input<OutputSchema>`; the defined tool accepts raw schema input and returns
normalized `z.output<OutputSchema>`.

`defineTool` snapshots the definition, rejects invalid timeouts and output schemas
without a representable JSON output side, and validates input/output around the
implementation. Without a configured policy the runtime executes only `read` and
`draft` risks; `write` and `privileged` fail with `POLICY_REQUIRED`.

## Policy and approvals

```ts
interface PolicyAction {
  policyVersion: "1";
  policyDigest: string; // digest of the exact ruleset
  sessionId: SessionId;
  turnId: TurnId;
  stepId: StepId;
  toolCallId: ToolCallId;
  toolName: string;
  risk: ToolRisk;
  inputDigest: string; // sha256 hex of canonical { input, toolName }
}

type PolicyDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "require_approval"; reason: string };

function createPolicyEngine(config?: PolicyConfig): PolicyEngine;
function createApprovalLedger(options?: ApprovalLedgerOptions): ApprovalLedger;
function digestToolAction(action: {
  toolName: string;
  input: JsonValue;
}): string;
```

`createRuntime({ policy, approvals })` evaluates the policy for each proposed tool
call before input validation and idempotency. A denial is recorded as
`tool.failed` and returned to the model as a tool result carrying the reason
(`POLICY_REQUIRED`, `details.outcome: "denied"`), so the turn continues and the
model can choose another approach; the tool never runs. A missing approval parks
the turn instead (below). `consume()` is one-shot, so the same approval can never
authorize two effects, and `withdraw()` retires a pending question so a late
answer is refused.

## Waiting for a human decision

When a `write` or `privileged` call has no matching approval, the turn parks
instead of failing:

```ts
interface RunTurnResult {
  session: Session;            // status: "waiting_input"
  turn: Turn;                  // status: "waiting_input"
  output?: JsonValue;
  usage: Usage;
  pendingApproval?: PendingApproval;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  risk: ToolRisk;
  inputDigest: string;
  policyDigest: string;
  expiresAt: string | null;
}

resumeTurn(
  input: { sessionId: SessionId; expectedSessionVersion?: number },
  options?: { signal?: AbortSignal },
): Promise<RunTurnResult>;
```

While a turn is parked, `runTurn` rejects with `INVALID_TRANSITION` (`reason:
"approval_pending"`) so a new turn cannot bypass the pending decision. A
trusted principal calls `approvals.decide(requestId, { principalId, approved })`;
`resumeTurn` then rejects while the decision is pending (no events written),
cancels the session when it was denied or expired, and otherwise emits
`input.received`, moves `waiting_input` back to `running` and continues the same
turn with the same `toolCallId`. The approval is consumed exactly once.

The continuation lives in memory: a process restart loses a parked turn and
`resumeTurn` fails closed. Durable continuation belongs to the Phase 2 store.

## Runtime

```ts
interface RuntimeConfig {
  store: RuntimeStore;
  providers: ProviderRegistry;
  agents: readonly AgentDefinition[];
  compactor?: ContextCompactor;
  retry?: RetryPolicy;
  defaults?: Partial<RuntimeLimits>;
  clock?: () => Date;
  idFactory?: <Name extends string>(brand: Name) => BrandedId<Name>;
}

interface AgentRuntime {
  createSession(input: CreateSessionInput): Promise<Session>;
  runTurn(
    input: RunTurnInput,
    options?: { signal?: AbortSignal },
  ): Promise<RunTurnResult>;
  cancelSession(sessionId: SessionId, reason?: string): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  events(query: EventQuery): AsyncIterable<RuntimeEvent>;
}

function createRuntime(config: RuntimeConfig): AgentRuntime;
function createInMemoryRuntimeStore(): RuntimeStore;
```

`CreateSessionInput` contains an `agentId` and optional `correlationId`.
`RunTurnInput` contains `sessionId`, JSON `input`, and optional
`expectedSessionVersion`. `RunTurnResult` returns the current session, turn,
optional output, and aggregate usage.

The supplied `agents` array is an explicit immutable registry. Duplicate IDs and
unknown session agent IDs fail closed; there is no global or environment registry.

## Store seam

```ts
interface RuntimeStore {
  createSession(session: Session, event: NewEvent): Promise<Session>;
  getSession(id: SessionId): Promise<Session | null>;
  compareAndSetSession(
    id: SessionId,
    expectedVersion: number,
    update: SessionUpdate,
    events: readonly NewEvent[],
  ): Promise<Session>;
  appendEvents(
    sessionId: SessionId,
    expectedCursor: number,
    events: readonly NewEvent[],
  ): Promise<readonly RuntimeEvent[]>;
  readEvents(query: EventQuery): Promise<EventPage>;
  claimIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyClaim>;
  completeIdempotency(
    scope: string,
    key: string,
    value: JsonValue,
  ): Promise<void>;
}
```

`IdempotencyClaim` is `claimed`, `in_flight`, `completed` with a JSON value, or
`conflict`. The Phase 1 implementation returns defensive snapshots and serializes
writes per session; it is not durable across process restart.

## NDJSON and HTTP transport

Import the transport either from the curated SDK or from the explicit runtime
subpath:

```ts
import {
  createRuntimeHttpHandler,
  encodeRuntimeEventNdjson,
  encodeRuntimeEventsNdjson,
} from "@remcod/runtime/transport";
```

```ts
function encodeRuntimeEventNdjson(event: RuntimeEvent): Uint8Array;

function encodeRuntimeEventsNdjson(
  events: AsyncIterable<RuntimeEvent>,
  signal?: AbortSignal,
  limit?: number,
): AsyncIterable<Uint8Array>;

function createRuntimeHttpHandler(runtime: AgentRuntime): RuntimeHttpHandler;
```

The encoder validates every event and emits one compact JSON value plus `\n`.
Iteration follows consumer backpressure. Abort closes the source iterator without
cancelling the runtime session, including while an upstream pull is stuck.

The neutral handler accepts `{ method, url, signal }` and supports:

```text
GET /v1/sessions/:sessionId/events?afterCursor=N&limit=N
```

- success: `200 application/x-ndjson; charset=utf-8`;
- unknown route/session: `404 application/problem+json`;
- unsupported method: `405` with `Allow: GET`;
- malformed URL/query: `400`;
- runtime cursor/version conflict: `409`;
- unclassified internal failure: sanitized `500`.

`afterCursor` defaults to `0` and is exclusive. `limit` defaults to `1000` and is
clamped to `1..1000`. Duplicate/unknown query keys are rejected. Raw dot and
percent-encoded session path segments are preserved before one decoding pass.

## Deterministic testing

```ts
const model = new ScriptedModel("scripted", [
  { kind: "response", response: firstResponse },
  { kind: "response", response: finalResponse },
]);
```

Each successful call consumes exactly one script item. Requests and plain script
data are immutable snapshots. An already-aborted call does not consume an item.
`assertExhausted()` verifies that the expected interaction is complete.

## Direct package exports

- `@remcod/protocol`: public Zod schemas, types, IDs, transitions, event data map,
  and `generateProtocolJsonSchemas()`;
- `@remcod/core`: agent, compaction, defaults, limits, and retry contracts;
- `@remcod/model-router`: provider registry and normalized model types;
- `@remcod/tools`: tool authoring contract, risk predicate, and typed errors;
- `@remcod/runtime`: harness/store contracts and implementations;
- `@remcod/testing`: scripted model and errors;
- `@remcod/sdk`: curated authoring surface.

See [Protocol v1](protocol-v1.md) for the closed event union and transition tables.
