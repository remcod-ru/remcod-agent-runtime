# ADR-0001: Clean implementation and compatibility boundary

- Status: Accepted
- Date: 2026-08-30

## Context

The project needs stable autonomous-agent execution semantics without making a product-specific runtime or one provider its architectural center.

## Decision

Build a clean-room standalone implementation from approved requirements and public contracts. Provider-neutral protocol, core, tools, and runtime packages own the execution model. Product-specific HTTP and NDJSON behavior may be added later through a compatibility adapter; it is not the primary architecture and may not leak authorization, organization scope, approval behavior, or secrets into core.

Workspace packages remain private under the provisional `@remcod/*` scope. No public package name, repository host, or release is selected before dependency, license, provenance, trademark, and brand review.

The later project identity and repository decision is recorded separately in
[ADR-0007](./0007-remcod-agent-runtime-identity.md); it does not change this
clean implementation boundary.

## Consequences

Compatibility work must map at an explicit adapter boundary and be backed by independently captured contracts. Core dependency and import scans reject unapproved product and vendor coupling. Future privileged capabilities must fail closed until policy, approval versioning, idempotency, and audit contracts exist.
