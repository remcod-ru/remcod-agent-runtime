# Contributing

Thank you for helping build REMCOD Agent Runtime.

## Before you start

- Keep the implementation provider neutral and clean-room. Do not copy source from another runtime or product.
- Do not add a dependency outside the approved exact pins without maintainer review.
- Do not commit credentials, private data, generated coverage, build output, or dependency directories.
- Keep packages private until a separate npm publication and package-scope review is complete.

## Development

Use Node.js and pnpm versions declared by `.node-version` and `packageManager`. Install and verify from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm legal:licenses
```

Changes should start with a failing test at a documented public seam, add the smallest implementation, and leave targeted and root checks green. Update documentation in the same change when behavior or a public boundary changes.

## Review

Keep changes focused. Describe user-visible behavior, tests run, dependency or license implications, and unresolved risk. Contributions are accepted under Apache-2.0; final public-release legal and brand review remains a human decision.
