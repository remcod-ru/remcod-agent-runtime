# Dependency, Provenance, and License Audit

## Scope and result

Local audit date: 2026-08-30.

The repository command below completed successfully in this checkout:

```sh
pnpm legal:licenses
```

It runs the repository governance scanner and `pnpm licenses list --json`. The
automated result confirms only that the checked workspace matched the configured
rules at that time. It is not legal advice, a legal opinion, or permission to
publish.

## Automated checks

The scanner currently verifies:

- text files do not match configured private-key/token/password patterns;
- packages with manifests under `packages/` are marked `private: true`;
- `packages/core` dependencies and JavaScript/TypeScript imports stay on an
  explicit provider-neutral allowlist;
- the pnpm license report is nonempty and structurally valid;
- configured identifiers for AGPL, SSPL, BSL/BUSL, Business Source, Commons
  Clause, and PolyForm-style licenses fail the gate;
- dedicated governance tests exercise malformed/empty license reports,
  restrictive-license, secret, core-dependency, and public-export fixtures;
- a positive workspace-manifest test and the governance scanner verify that
  current package manifests remain private. There is no separate negative
  `private: false` fixture claim.

After `pnpm build` creates the artifacts, the public export smoke loads supported
package specifiers in a child Node process. The smoke itself does not build. The
source boundary scan found no product-specific runtime or unapproved vendor
import in the executable core packages.

## Provenance

The implementation is independently authored from written requirements, public
standards, and tests. Future compatibility observations define adapter contracts,
not core architecture. Contributor provenance obligations are recorded in [the
provenance policy](../provenance.md) and
[ADR-0001](../adr/0001-clean-implementation-boundary.md).

No generated vendor source, raw production artifact, credential, or private
customer data is permitted. A contributor introducing externally derived code,
data, assets, or substantial documentation must record source, revision/date,
license, modifications, and attribution obligations in the same change.

## Static-only infrastructure check

`compose.yaml` and `.env.example` were inspected as source files. The compose
configuration is a Phase 2 reference seam and is unused by Phase 1. Docker is not
installed in this checkout, so parsing by Docker Compose, image retrieval,
healthcheck, named-volume persistence, and teardown have not been runtime-tested.
This limitation must remain visible until a Docker-capable environment verifies it.

## Human release review still required

Before public release, a qualified maintainer must review:

- the complete resolved dependency graph and every unknown/compound license;
- source, binary, transitive, NOTICE, attribution, and modification obligations;
- project/package naming, trademarks, and brand;
- provenance records and generated material;
- the security threat model and release artifacts.

The automated denylist is intentionally conservative but cannot determine legal
compatibility or replace counsel. Passing it does not make the repository
open-source-ready by itself.

## Publication state

The source repository is published as `remcod-ru/remcod-agent-runtime` under
the REMCOD Agent Runtime identity. All `@remcod/*` workspace packages remain
private. No npm publication, deployment, release tag, or product cutover has been
performed as part of Phase 0 + Phase 1.
