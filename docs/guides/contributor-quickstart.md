# Contributor Quickstart

## Prerequisites

- Node.js `24.15.0` from `.node-version`;
- Corepack and pnpm `11.24.0` from the root `packageManager` field;
- no credentials, provider account, database, or Docker for Phase 1.

Run all commands from the repository root.

## Install and run the example

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @remcod/example-basic-agent build
pnpm --filter @remcod/example-basic-agent start
```

The final command prints exactly:

```text
{"answer":42}
```

The example imports only `@remcod/sdk`, uses two deterministic `ScriptedModel`
responses, executes an `add` tool, and makes no network request.

## Verification commands

Run the complete non-mutating suite:

```sh
pnpm check
pnpm legal:licenses
```

Or run a specific gate:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm smoke:exports
pnpm legal:licenses
```

`pnpm smoke:exports` imports supported public package specifiers in a child Node
process. It does **not** build them, so run `pnpm build` first in a fresh clone. The
smoke is stronger than checking that an export target file merely exists.
`pnpm legal:licenses` runs source/secret/privacy checks and rejects configured
restrictive dependency-license identifiers.

## Package-level workflow

Use the workspace package name, not a deep source path:

```sh
pnpm --filter @remcod/protocol test
pnpm --filter @remcod/runtime typecheck
pnpm --filter @remcod/sdk build
```

For a behavior change, follow this order:

1. add a failing test through the public API or one of the documented seams;
2. implement the smallest behavior that satisfies it;
3. refactor without changing the public contract;
4. run the affected package test and typecheck;
5. run `pnpm check` and `pnpm legal:licenses` before the commit.

Do not import another package's `src/` or `dist/` files. Supported package
specifiers are listed in the [public API reference](../reference/public-api.md).

## Optional PostgreSQL reference

`compose.yaml` documents the intended local PostgreSQL seam for Phase 2. It is
not required or consumed by Phase 1. If Docker is available on another machine,
copy `.env.example` to `.env`, fill the four local values, and validate the compose
file before starting it. Do not commit `.env`.

Docker commands are intentionally not part of the acceptance proof for this
checkout: the Docker CLI is unavailable, so the compose service has only been
inspected statically.

## Public release boundary

All packages remain private and provisional. Do not publish to npm, create a
remote repository, deploy, or announce a release from these instructions. Those
actions require an explicit maintainer decision plus the human reviews listed in
the [audit record](../audits/dependency-provenance-license.md).
