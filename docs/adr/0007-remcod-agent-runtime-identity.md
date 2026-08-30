# ADR-0007: REMCOD Agent Runtime identity

- Status: Accepted
- Date: 2026-08-30

## Context

The provider-neutral runtime needs a stable public identity without coupling its
core execution model to a particular application, model provider, or deployment
platform.

## Decision

Use **REMCOD Agent Runtime** as the project name and
`remcod-ru/remcod-agent-runtime` as the source repository. Use `@remcod/*`
for private workspace package names while npm publication remains deferred.

The REMCOD name identifies project stewardship. It does not make product-specific
business rules, authorization, credentials, or application runtime behavior part
of the core. Those integrations remain optional adapters behind documented public
contracts.

## Consequences

Documentation, examples, package imports, governance fixtures, and repository
metadata use the REMCOD Agent Runtime identity consistently. Future package or
release publication still requires an explicit maintainer decision and a human
package, license, provenance, trademark, and security review.
