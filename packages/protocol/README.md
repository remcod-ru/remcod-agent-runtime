# @remcod/protocol

Protocol v1 is the provider-neutral, JSON-only boundary shared by the runtime and
its adapters. Zod schemas are the runtime source of truth for:

- branded agent, session, turn, step, event, and tool-call IDs;
- strict `Session`, `Turn`, `Step`, usage, tool-call, and runtime-error records;
- exhaustive session, turn, and step transition predicates;
- the closed `RuntimeEvent` type/data union and every dedicated event-data schema.

Use `generateProtocolJsonSchemas()` to derive JSON Schema from the public Zod
schemas. Import only from `@remcod/protocol`; deep source imports are unsupported.

Protocol v1 is a closed union: unknown event types and mismatched event/data pairs
fail validation. Per-session event cursors are assigned by the store, not by this
package. See the [protocol reference](../../docs/reference/protocol-v1.md).
