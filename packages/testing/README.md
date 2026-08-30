# @remcod/testing

Deterministic Phase 1 model fixtures.

`ScriptedModel` implements `ModelProvider` from a finite sequence of responses or
errors. Each call consumes one item, records an immutable request snapshot, and
preserves error identity. A pre-aborted call fails without consuming the next
item. `assertExhausted()` verifies the complete expected interaction.

No key, network, clock, or real provider is required. Production provider adapters
and broader conformance packages remain deferred.
