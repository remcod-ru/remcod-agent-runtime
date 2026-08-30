# Protocol v1

Zod schemas in `@remcod/protocol` are the runtime source of truth. TypeScript types
are inferred from them, and `generateProtocolJsonSchemas()` derives JSON Schema.
The literal protocol version is `"1"`; unknown event types fail validation.

## Records

`Session` contains its branded ID, agent ID, status, timestamps, CAS version, and
last event cursor. `Turn` contains session ID, status, JSON input/output, and
timestamps. `Step` contains session/turn IDs, zero-based index, kind
(`model | tool | compaction`), status, timestamps, and an optional typed error.

`RuntimeError.code` is one of:

```text
VALIDATION_FAILED       INVALID_TRANSITION      VERSION_CONFLICT
CURSOR_CONFLICT         PROVIDER_FAILED         TOOL_FAILED
POLICY_REQUIRED         BUDGET_EXCEEDED         CANCELLED
STRUCTURED_OUTPUT_INVALID                     SCRIPT_EXHAUSTED
```

## State machines

Session:

```text
idle -> running | cancelled
running -> waiting_input | waiting_event | waiting_schedule |
           waiting_next_turn | completed | failed | cancelled
waiting_input -> running | cancelled
waiting_event -> running | cancelled
waiting_schedule -> running | cancelled
waiting_next_turn -> running | completed | cancelled
completed | failed | cancelled -> terminal
```

Turn:

```text
queued -> running
running -> waiting_input | completed | failed | cancelled
waiting_input -> running | cancelled
completed | failed | cancelled -> terminal
```

Step:

```text
pending -> running
running -> completed | failed | cancelled
completed | failed | cancelled -> terminal
```

Use `canTransitionSession`, `canTransitionTurn`, and `canTransitionStep`. Invalid
or terminal outgoing transitions are rejected. The event schema also constrains
`*.status_changed` payloads to these exact legal pairs.

## Event envelope

```ts
interface RuntimeEvent<Type extends EventType = EventType> {
  protocolVersion: "1";
  id: EventId;
  cursor: number;
  type: Type;
  sessionId: SessionId;
  turnId?: TurnId;
  stepId?: StepId;
  correlationId: string;
  causationId?: EventId;
  occurredAt: string;
  data: EventData<Type>;
}
```

Cursor is a positive integer. Step events require both `turnId` and `stepId`.
`NewEvent` omits the stored `protocolVersion`, `sessionId`, and `cursor`, which the
store assigns.

## Closed event/data union

| Event type               | Required data                                        |
| ------------------------ | ---------------------------------------------------- |
| `session.created`        | `{ session: Session }`                               |
| `session.status_changed` | one legal `{ from, to, reason? }` session transition |
| `turn.created`           | `{ turn: Turn }`                                     |
| `turn.status_changed`    | one legal `{ from, to, reason? }` turn transition    |
| `step.started`           | `{ step: Step }`                                     |
| `step.completed`         | `{ output?: JsonValue, usage?: Usage }`              |
| `step.failed`            | `{ error: RuntimeError }`                            |
| `step.cancelled`         | `{ reason?: string }`                                |
| `model.requested`        | `{ providerId, model, attempt }`                     |
| `model.completed`        | `{ responseKind: "message" \| "tool_calls", usage }` |
| `model.failed`           | `{ error, attempt }`                                 |
| `tool.requested`         | `{ call: ToolCall, idempotencyKey }`                 |
| `tool.started`           | `{ toolCallId, toolName }`                           |
| `tool.completed`         | `{ toolCallId, output }`                             |
| `tool.failed`            | `{ toolCallId, error }`                              |
| `context.compacted`      | `{ beforeTokens, afterTokens, summary }`             |
| `input.requested`        | `{ requestId, prompt, schema? }`                     |
| `input.received`         | `{ requestId, value }`                               |
| `session.completed`      | `{ output? }`                                        |
| `session.failed`         | `{ error }`                                          |
| `session.cancelled`      | `{ reason? }`                                        |

All schemas are strict. Attempts are positive integers; token counts and compaction
counts are non-negative integers; IDs and human-readable identifiers are nonempty.
ID schemas additionally reject values containing only whitespace.
`EventDataSchemas` is the public mapping from every `EventType` to its dedicated
Zod data schema.

## Cursor and reconnect semantics

The in-memory store assigns contiguous per-session cursors beginning at `1`.
`readEvents({ afterCursor })` is exclusive and pages in ascending order. The
runtime's `events()` iterator follows `nextCursor` until the current event history
is exhausted. NDJSON transport preserves that order.

These guarantees do not survive a process restart because Phase 1 has no durable
store. Durable cursors, checkpoints, leases, and crash recovery belong to Phase 2.
