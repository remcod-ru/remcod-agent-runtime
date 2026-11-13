# Architecture Overview

REMCOD Agent Runtime separates stable, provider-neutral execution semantics
from adapters and product integrations. Phase 1 is deliberately small: one
process, an in-memory store, deterministic test providers, and a transport that
projects stored events without owning them.

## Dependency direction

The current package import graph is acyclic:

```text
protocol:          zod
tools:             protocol, zod
policy:            protocol, tools, zod
core:              protocol, tools, zod
model-router:      core, protocol
runtime:           core, model-router, policy, protocol, tools, zod
runtime/transport: protocol, runtime
testing:           model-router, protocol
sdk:               core, model-router, policy, protocol, runtime, testing, tools, zod
```

The supported cross-package seams are public package exports; deep source imports
are unsupported. `sdk` is a leaf facade and no implementation package depends on
it.

## Module ownership

| Module                      | Owns                                                                                             | Public surface                                                             | Keeps internal                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `@remcod/protocol`          | Protocol version, JSON values, branded IDs, records, errors, event vocabulary, state transitions | Zod schemas, inferred types, transition predicates, JSON Schema generation | Schema construction helpers                     |
| `@remcod/core`              | Agent definition, limits, retry and compaction policies                                          | `defineAgent`, defaults, contract types                                    | Definition normalization                        |
| `@remcod/model-router`      | Provider selection and normalized model request/response                                         | `ModelProvider`, `ProviderRegistry`, model types                           | Provider map                                    |
| `@remcod/tools`             | Typed tool definition, validation, timeout, risk classification                                  | `defineTool`, tool types, typed errors                                     | Abort/timeout and validation plumbing           |
| `@remcod/policy`            | Capability policy decisions, canonical action digest, in-memory approval ledger                  | `createPolicyEngine`, `createApprovalLedger`, `digestToolAction`           | Rule matching and approval state                |
| `@remcod/runtime`           | Session execution, CAS/event orchestration, in-memory store, pure reducer                        | `createRuntime`, `AgentRuntime`, `RuntimeStore`, typed failures            | Loop state, counters, idempotency orchestration |
| `@remcod/runtime/transport` | Event serialization and neutral HTTP mapping                                                     | NDJSON encoders and `createRuntimeHttpHandler`                             | Raw URL/query parsing and iterator cleanup      |
| `@remcod/testing`           | Deterministic provider fixture                                                                   | `ScriptedModel` and its typed script items/errors                          | Script cursor and request journal               |
| `@remcod/sdk`               | Supported Phase 1 authoring experience                                                           | Curated re-exports only                                                    | Workspace topology and internal files           |

## Runtime flow

1. `createRuntime` snapshots the explicit agent registry and rejects duplicate
   agent or tool names.
2. `createSession` resolves one agent by ID and appends `session.created`.
3. `runTurn` assembles bounded context, invokes the selected provider, validates
   any tool calls, and continues until a terminal message or failure.
4. Every proposed tool call passes the configured policy before input validation:
   a denial or a missing one-shot approval fails the turn with `POLICY_REQUIRED`,
   whose `details.outcome` names the case.
5. Session state and events are changed through store CAS/cursor methods.
6. The internal reducer derives state and counters from events without invoking a
   model or tool.
7. The transport reads events and encodes NDJSON; disconnecting a consumer closes
   its iterator but does not cancel or mutate the session.

Provider retries are limited to classified transient model failures. Tool effects
are never silently retried. A tool call is bound to a stable idempotency key and a
canonical fingerprint; conflicting or ambiguous in-flight reuse fails closed.

## External compatibility boundary

Core packages cannot import product-specific runtimes or vendor SDKs. The
repository governance scan enforces the `packages/core` dependency and import
allowlist. Product authorization, organization scope, approval workflows,
secrets, and trusted principals never come from model output and are not part of
the Phase 1 core contracts.

Product compatibility belongs in the deferred `compatibility-adapter` after
independent contract traces exist. Adapters do not define core execution
semantics and require their own deployment and migration approval.

## Durability and deployment boundary

The Phase 1 store loses all state on process restart. Its cursor reconnect is
valid only while the current process retains the session events. PostgreSQL in
`compose.yaml` is reference-local infrastructure for the future Phase 2 store;
Phase 1 neither imports a database driver nor claims crash recovery.

The compose file has only received static inspection in this checkout. Docker is
not installed, so service startup, healthcheck, persistence, and shutdown are
unverified. Remote hosting, npm publication, and deployment are also outside the
completed scope.
