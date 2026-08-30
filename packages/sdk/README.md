# @remcod/sdk

Curated Phase 1 entry point for agent/tool authoring, deterministic testing,
in-memory runtime execution, protocol types, and the neutral NDJSON/HTTP
transport. Internal package files and deep imports are not part of the SDK.

Typical imports:

```ts
import {
  ProviderRegistry,
  ScriptedModel,
  createId,
  createInMemoryRuntimeStore,
  createRuntime,
  defineAgent,
  defineTool,
  z,
} from "@remcod/sdk";
```

The Phase 1 runtime retains events only in the current process. Durable event
recovery and reconnect across a process restart are deferred to Phase 2.

The `@remcod/*` workspace packages and all versions remain private and unpublished. See
the [public API reference](../../docs/reference/public-api.md).
