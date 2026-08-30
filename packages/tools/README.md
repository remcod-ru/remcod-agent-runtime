# @remcod/tools

Typed tool definitions and their execution envelope.

`defineTool` snapshots a definition, validates raw input into the author-facing
type, applies one caller-or-timeout `AbortSignal`, validates/normalizes output,
and exposes typed validation/timeout failures. Output schemas must have a
representable JSON output side so cached results can be structurally validated
without applying transforms twice.

Risks are `read`, `draft`, `write`, and `privileged`. The Phase 1 runtime executes
only the first two; the latter two require the deferred policy layer and fail
closed with `POLICY_REQUIRED`.
