# Security Policy

## Supported versions

This project is pre-release. No version is supported for production use yet.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability and do not include credentials, private data, or working exploits in public channels. Once a repository host is approved, use its private security-advisory channel to contact the maintainers. Until then, keep the report private and ask the maintainer for an approved reporting channel.

Reports should identify the affected revision, impact, reproduction conditions, and any suggested mitigation. Maintainers will acknowledge a report only through the agreed private channel; no response-time commitment applies before the first release.

## Security boundary

Phase 1 is a local development and testing runtime. Write and privileged tools fail closed until deterministic policy and audit capabilities are implemented. Secrets, tenant scope, and authorization data must not enter model context or repository files.
