# Basic Agent

This example is an external consumer of `@remcod/sdk`. It uses the deterministic
`ScriptedModel` to perform a complete model → tool → terminal-message run with
no API key and no network access.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @remcod/example-basic-agent build
pnpm --filter @remcod/example-basic-agent start
```

Expected output: `{"answer":42}`.

The example uses the Phase 1 in-memory store. Event reconnect works only while
the process remains alive; durable reconnect across restart is deferred to
Phase 2.

`runBasicAgent()` also returns the output, model request count, second-request
messages, and emitted event types for deterministic consumer tests.
