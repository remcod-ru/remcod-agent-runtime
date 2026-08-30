# @remcod/core

Provider-neutral agent authoring and execution-policy contracts for Phase 1:

- `defineAgent`, top-level frozen definitions, and validated limit snapshots;
- `RuntimeLimits`, defaults, and validation;
- provider `RetryPolicy` and the default bounded exponential delay;
- `ContextCompactor` and deterministic default truncation/summary behavior;
- model selector/message types and `defaultRuntimeConfig`.

This package does not select providers, execute tools, store sessions, or contain
authorization/tenant context. Import only from `@remcod/core`; most authors should
use the curated `@remcod/sdk` surface.
