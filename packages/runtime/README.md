# @remcod/runtime

Provider-neutral Phase 1 bounded runtime harness and in-memory store.

The public entry exports `createRuntime`, `AgentRuntime`, `RuntimeStore`,
`createInMemoryRuntimeStore`, the runtime input/result contracts, and typed conflict
and runtime failures. Agent definitions are supplied explicitly through
`RuntimeConfig.agents`; duplicate and unknown IDs fail closed.

The in-memory store provides atomic session CAS, contiguous event cursors, and
fingerprint-bound `claimIdempotency`/`completeIdempotency` records for local
execution and tests. Completed `null` values are cached, while in-flight or
conflicting reuse of the same tool-call ID fails closed. The stored fingerprint
binds that ID to the canonical tool name and input. It makes no
production-durability claim.

Completed cached JSON is checked with a structural validator generated from the
tool schema's output-side JSON Schema. Successful validation returns the original
cached value unchanged, without reapplying codecs, defaults, coercion, transforms,
overwrites, trimming, or object normalization.

The harness executes only `read` and `draft` tools; `write` and `privileged`
risks require the deferred policy layer. Unknown tools, validation failures and
tool execution failures are recorded and returned to the model once without
retrying tool execution.

The supported `@remcod/runtime/transport` subpath provides validated NDJSON encoding
and a framework-neutral handler for:

```text
GET /v1/sessions/:sessionId/events?afterCursor=N&limit=N
```

`afterCursor` is exclusive; `limit` is clamped to `1..1000`. Backpressure follows
consumer pulls. Disconnect closes the event iterator without cancelling the
session. Reconnect is supported only for events retained by the current process;
durable recovery across restart is deferred to Phase 2.

See the [runtime concepts](../../docs/concepts/runtime-model.md) and
[public API](../../docs/reference/public-api.md).
