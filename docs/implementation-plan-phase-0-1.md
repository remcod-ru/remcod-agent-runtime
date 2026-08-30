# Phase 0 + Phase 1 TDD Implementation Plan

This plan is both the build order and the contributor map for the current local
foundation. It is intentionally limited to Phase 0 + Phase 1; later product work
is preserved in the [roadmap](roadmap.md), not implied by placeholders.

## Target package layout

```text
packages/
  protocol/          # schemas, IDs, state machines, events, errors
  core/              # agent definitions, limits, retry, compaction
  model-router/      # provider-neutral model contract and registry
  tools/             # typed tools, risk, validation, timeout
  runtime/           # harness, in-memory store, pure reducer
    transport/       # NDJSON and framework-neutral HTTP adapter
  testing/           # ScriptedModel deterministic fixtures
  sdk/               # curated authoring re-exports
examples/
  basic-agent/       # external SDK consumer smoke
docs/
  architecture/ concepts/ guides/ reference/ adr/ audits/
```

Directories for future stores, scheduling, policy, drivers, memory, multi-agent,
observability, providers, console, and advanced examples contain README
placeholders only. A placeholder has no `package.json` and is not a build target.

## Public contracts fixed before implementation

The build uses three principal injection seams:

1. `ModelProvider.generate(request, { signal })` for provider calls;
2. `RuntimeStore` CAS, event, and idempotency methods for state;
3. `ToolDefinition.execute(input, context)` for capabilities.

`AgentRuntime` is the orchestration boundary. `@remcod/sdk` is the curated authoring
boundary. Protocol records/events are JSON-only and Zod-validated. Exact public
signatures are in the [API reference](reference/public-api.md); event schemas and
transition tables are in [Protocol v1](reference/protocol-v1.md).

## TDD sequence

Each step follows: failing test or fixture → minimal implementation → refactor →
package test/typecheck → root acceptance. Focused commits may contain both the red
test and implementation as long as the completed commit is coherent and green.

### 1. Workspace, governance, and CI

Red evidence:

- missing required governance files or private package flags pass;
- disallowed core imports, secret fixtures, restrictive license fixtures, and
  broken public exports are not detected;
- root checks do not exercise every package.

Implementation:

- pin Node, pnpm, TypeScript, Zod, Vitest, ESLint, and Prettier;
- create the private pnpm workspace, legal/security/contribution baseline,
  reference compose file, placeholder rules, and CI skeleton;
- add governance, license, secret, coverage, and real public-import gates.

Acceptance: frozen install, governance Node tests, all root scripts, and license
gate. Docker remains optional and outside Phase 1 tests.

### 2. Protocol v1

Red evidence:

- invalid records/events or mismatched event data validate;
- legal and illegal transitions are misclassified;
- generated JSON Schema diverges from runtime Zod behavior.

Implementation:

- JSON value, UTC timestamp, protocol literal, branded IDs;
- strict `Session`, `Turn`, `Step`, `RuntimeError`, `Usage`, and `ToolCall` schemas;
- exhaustive Session/Turn/Step transition tables;
- closed event/data discriminated union and derived JSON Schema fixture.

Acceptance: valid/invalid fixtures, every transition pair, JSON Schema parity,
single public `@remcod/protocol` entry.

### 3. Core, model router, tools, and testing

Red evidence:

- duplicate/unknown providers resolve silently;
- invalid tool input/output or timeout reaches implementation;
- caller abort and timeout do not cover the whole tool envelope;
- transformed/codec output is applied twice on replay;
- scripted tests consume items after pre-abort or leak mutable request data.

Implementation:

- immutable agent definitions, validated limits, default retry and compaction;
- provider registry and normalized model contracts;
- typed tool authoring generics, risk classification, schema validation, timeout;
- deterministic immutable `ScriptedModel`.

Acceptance: package tests/typechecks plus consumer-level type tests for normalized
tool input/output and canonical protocol wire types.

### 4. Runtime harness and in-memory store

Red evidence:

- concurrent CAS writes both succeed or cursor append partially mutates;
- duplicate tool effects execute twice;
- model/tool loop fails to continue after a tool result;
- budgets, structured output, cancellation, retry, or compaction do not terminate
  with the documented typed event sequence;
- reducing history invokes effects.

Implementation:

- explicit immutable agent resolution;
- defensive in-memory session/event store with per-session serialization;
- atomic fingerprint-bound idempotency claim/complete;
- bounded model/tool loop, provider-only retry, structured output, compaction,
  cancellation, and pure reducer.

Acceptance: message-only and multi-tool turns, failure matrices, every budget,
concurrency and idempotency probes, event ordering, and side-effect-free reduction.

### 5. Transport, SDK, and basic external consumer

Red evidence:

- malformed events produce NDJSON;
- reconnect repeats consumed cursors;
- abort hangs on a stuck upstream pull or does not close the real iterator;
- URL normalization changes raw `.`/`..` or encoded session IDs;
- malformed authority/query reaches the runtime;
- SDK smoke depends on internal files.

Implementation:

- validated one-event-per-line NDJSON encoder with backpressure, total limit, and
  prompt best-effort iterator close;
- neutral GET event handler with typed/sanitized problem responses;
- curated SDK exports and deterministic basic-agent model → tool → message run.

Acceptance: transport contract tests, public package imports in child Node, SDK
consumer tests, and exact example output `{"answer":42}`.

### 6. Documentation and final acceptance

Red evidence:

- quickstart commands, links, public contracts, events, states, or roadmap differ
  from code;
- implemented and deferred capabilities are not distinguishable;
- audit output is presented as legal or release approval.

Implementation:

- architecture/module ownership and external compatibility boundary;
- contributor guide, public API and protocol references;
- this implementation plan, deferred roadmap, and audit record;
- package READMEs aligned with their actual exports.

Acceptance: link/command/source scans followed by the full root suite and final
diff review. No publish, remote creation, deploy, or release action occurs.

## Test matrix

| Boundary       | Required proof                                                                          |
| -------------- | --------------------------------------------------------------------------------------- |
| Protocol       | strict valid/invalid records, closed event/data union, JSON Schema parity               |
| State machines | every legal and illegal Session/Turn/Step edge                                          |
| Model          | exact provider resolution, deterministic script, transient/permanent retry              |
| Tools          | input/output normalization, abort/timeout, risk fail-closed, no automatic retry         |
| Store          | CAS/cursor conflict, contiguous events, snapshots, atomic idempotency including `null`  |
| Harness        | terminal message, multi-tool loop, budgets, structured output, cancellation, compaction |
| Reducer        | state/counter reconstruction with no provider or tool call                              |
| Transport      | NDJSON round trip, exclusive reconnect, clamped limit, raw URL IDs, abort/cleanup       |
| SDK/example    | public imports only and exact deterministic output                                      |
| Governance     | formatting, lint, types, coverage, build, exports, secrets, package privacy, licenses   |

## Recommended development sequence

Keep future changes focused in this order when rebuilding or extending the
foundation:

1. workspace governance and CI;
2. protocol schemas and state machines;
3. core, model, tools, and deterministic testing;
4. in-memory runtime and idempotency boundaries;
5. transport, SDK, and runnable examples;
6. coverage, license gates, documentation, and final acceptance.

This order is a maintenance guide, not historical provenance or a release record.
