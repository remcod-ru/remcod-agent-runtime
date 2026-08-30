<p align="right"><a href="README.md">Русский</a> · English</p>

<p align="center">
  <img src="docs/assets/brand/remcod-agent-runtime-mark.png" alt="REMCOD Agent Runtime logo" width="128">
</p>

# REMCOD Agent Runtime

Provider-neutral execution runtime and test harness for autonomous agents. This
standalone repository currently implements the local, in-memory **Phase 0 +
Phase 1** foundation. It does not yet provide production durability, policy,
browser/computer control, multi-agent orchestration, or a public release.

## Status and boundaries

- Implemented: protocol v1, typed agent/model/tool contracts, bounded model/tool
  loop, deterministic in-memory event store, NDJSON/HTTP event transport,
  scripted testing utilities, curated SDK, and a runnable basic example.
- Selected identity: **REMCOD Agent Runtime**, repository
  `remcod-ru/remcod-agent-runtime`, and the private `@remcod/*` workspace
  scope. Package names and `0.0.0` versions remain unpublished.
- Not done: npm publication, deployment, and a production release.
- Product-specific compatibility belongs in optional adapters. External business
  rules, identity context, credentials, and authorization do not define or enter
  the core runtime.

## Contributor quickstart

Prerequisites:

- Node.js `24.15.0` (see `.node-version`);
- pnpm `11.24.0`, activated through Corepack.

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @remcod/example-basic-agent build
pnpm --filter @remcod/example-basic-agent start
pnpm check
pnpm legal:licenses
```

The example prints exactly:

```text
{"answer":42}
```

`pnpm check` runs formatting, lint, type checking, tests, coverage, builds, and
public-export smoke checks. Phase 1 needs no API key, network service, database,
or Docker. The optional PostgreSQL service in `compose.yaml` is only a static
reference seam for Phase 2; its Docker runtime has not been verified in this
checkout because the Docker CLI is unavailable.

See the [full contributor guide](docs/guides/contributor-quickstart.md) for
individual commands and troubleshooting.

## Packages

| Package                     | Phase 1 responsibility                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `@remcod/protocol`          | JSON-only protocol v1 schemas, IDs, records, events, errors, and transition predicates |
| `@remcod/core`              | Agent definitions, execution limits, retry policy, and context compaction contracts    |
| `@remcod/model-router`      | Provider-neutral model request/response seam and provider registry                     |
| `@remcod/tools`             | Typed tool definitions, validation, timeout, risk, and execution envelope              |
| `@remcod/runtime`           | Bounded harness, in-memory store, reducer, and typed failures                          |
| `@remcod/runtime/transport` | Validated NDJSON encoder and framework-neutral event HTTP handler                      |
| `@remcod/testing`           | Deterministic `ScriptedModel` fixtures                                                 |
| `@remcod/sdk`               | Curated public authoring surface                                                       |

Other package and example directories are roadmap placeholders, not hidden or
partially implemented packages.

## Documentation

- [Architecture and module ownership](docs/architecture/overview.md)
- [Runtime concepts](docs/concepts/runtime-model.md)
- [Public API reference](docs/reference/public-api.md)
- [Protocol v1 events and state machines](docs/reference/protocol-v1.md)
- [Phase 0 + Phase 1 TDD implementation plan](docs/implementation-plan-phase-0-1.md)
- [Deferred Phase 2–10 roadmap](docs/roadmap.md)
- [Dependency, provenance, and license audit](docs/audits/dependency-provenance-license.md)
- [ADR-0001: clean implementation boundary](docs/adr/0001-clean-implementation-boundary.md)
- [ADR-0007: REMCOD Agent Runtime identity](docs/adr/0007-remcod-agent-runtime-identity.md)

## License

Apache-2.0. Automated checks are guardrails, not legal advice. A human dependency,
license, NOTICE, provenance, trademark, and brand review remains mandatory before
any public release.
