# Runtime Model

Phase 1 models one bounded agent execution as three nested records and an
append-only event history.

## Session, turn, and step

- A **session** binds execution to one immutable agent definition. The protocol
  relates turns to sessions, but the current Phase 1 harness completes a
  successful turn and its session together; public continuation is deferred.
- A **turn** accepts one JSON input and returns an optional JSON output plus token
  usage.
- A **step** is one model invocation, tool invocation, or context compaction.

Records are protocol values, validated by Zod, and contain branded string IDs.
The protocol version is the literal `"1"`. All timestamps are UTC ISO-8601 values
and all persisted payloads are JSON values.

## Events as the execution trace

Every stored event has a contiguous cursor scoped to its session. The cursor
starts at `1`; `afterCursor` is exclusive. Event type and data are one closed,
discriminated protocol union, so a mismatched payload is rejected before storage.

The in-memory store updates a session and its transition events atomically through
compare-and-set. A separate pure reducer can reconstruct sessions, turns, steps,
and counters without calling providers or tools. It is an internal correctness
seam, not a public replay/time-travel feature.

## Bounded model/tool loop

The runtime resolves an agent and provider from explicit registries, builds the
context, optionally compacts it, and calls the provider. A message result completes
the turn. A `tool_calls` result executes declared calls in deterministic order and
feeds their outputs back into the next model request.

Hard limits cover steps, model calls, tool calls, input tokens, and output tokens.
All limits are finite non-negative integers. The defaults are 32 steps, 16 model
calls, 64 tool calls, 100,000 input tokens, and 16,000 output tokens.

## Retry, cancellation, and tool safety

The default retry policy attempts a provider call at most three times and retries
only errors carrying `retryable: true`. Tool execution is not automatically
retried. `AbortSignal` covers model and tool execution; cancelling an active step
records `step.cancelled` before terminal turn/session cancellation.

Only `read` and `draft` tools execute in Phase 1. `write` and `privileged` tools
fail with `POLICY_REQUIRED` until the deferred policy/capability milestone exists.

## Idempotency and ambiguous effects

The store atomically claims `(scope, key)` and binds it to a fingerprint of the
tool name and canonical JSON input. A completed value, including JSON `null`, is
returned from cache. Concurrent in-flight reuse and key reuse with another
fingerprint fail closed. If a tool may have produced an external effect but did
not complete its record, Phase 1 leaves the claim in flight instead of guessing
that a retry is safe.

## Compaction and structured output

Compaction appends a summary event and retains the source events. The default
compactor deterministically keeps the newest half of messages and prepends a
summary. A configured agent output schema validates the terminal model message;
invalid output fails with `STRUCTURED_OUTPUT_INVALID`.

Tool input schemas may normalize input before the author implementation runs.
Tool output is normalized once on first execution. Cached output is checked
against a structural output-side validator and returned unchanged, avoiding a
second transform, default, codec decode, or normalization pass.

## What is not implied

An append-only in-memory trace is not durable storage. NDJSON reconnect is not
restart recovery. A pure reducer is not public replay. An idempotency record is
not a distributed recovery protocol. Those capabilities remain in the
[Phase 2–10 roadmap](../roadmap.md).
