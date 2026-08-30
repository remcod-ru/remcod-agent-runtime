# Provenance Policy

REMCOD Agent Runtime is a clean-room, standalone implementation derived from written requirements, public standards, and independently authored tests and code. Compatibility observations may inform adapter contracts, but third-party source code and product architecture are not adopted as core.

Contributors must identify externally derived code, data, generated assets, and substantial documentation in the change that introduces them. The record must name the source, revision or retrieval date, license, modifications, and required attribution. A compatible license does not remove this provenance requirement.

Dependencies must use exact approved versions. Before public release, maintainers must complete a human dependency and license review, confirm NOTICE obligations, review trademarks and package naming, and resolve every unknown origin. Dependencies or material under AGPL, SSPL, Business Source License, Commons Clause, PolyForm-style, or similarly restrictive terms fail the automated gate unless a later documented human decision explicitly changes policy.

Generated code is treated as a contribution: its human submitter must verify origin, license compatibility, behavior, and tests. Secrets, credentials, private customer data, raw production artifacts, and unreviewed vendor source are prohibited.
