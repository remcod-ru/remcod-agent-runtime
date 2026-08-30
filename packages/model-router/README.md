# @remcod/model-router

Provider-neutral model request/response contract and exact provider registry.

`ModelProvider.generate(request, { signal })` is the Phase 1 provider seam.
`ProviderRegistry.register` rejects duplicate IDs and `resolve` rejects unknown
providers. Requests contain normalized messages, tools, output schema, and
remaining limits; credentials and trusted authorization context are absent.

Phase 1 ships `ScriptedModel` for tests, not a real cloud-provider adapter.
Independent provider adapters are deferred to the roadmap.
