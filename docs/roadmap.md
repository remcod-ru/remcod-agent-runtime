# Deferred Phase 2–10 Roadmap

Phase 0 + Phase 1 provides an in-memory provider-neutral execution foundation.
Everything below is **deferred**, not completed, and not removed from product
scope. Placeholder directories only reserve vocabulary and ownership boundaries.

| Phase                        | Intended milestone                                                                                                                                                    | Depends on / acceptance boundary                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 — Durable runtime          | PostgreSQL event store, checkpoints, continuation, durable cursor/reconnect, crash recovery, leases, idempotency recovery, migration/bootstrap CLI                    | Integration tests across restart/redeploy; cursor resumes without loss/duplication; lease contention and ambiguous effects fail safely                   |
| 3 — Product compatibility    | Independently captured contract traces, compatibility routes/event subset, trusted principal adapter, tool bridge, read-only shadow mode, staged cutover and rollback | Adapter preserves core independence; compatibility suite passes; no frontend rewrite or production cutover without separate approval                     |
| 4 — Persistent agents        | Goal Engine, Task Graph, scheduler, `wakeAt`/`wakeOn`/`wakeWhen`, event subscriptions, condition watches, compute-free durable waits                                  | Persistent goals/tasks survive restart; scheduled/event wakeups are deterministic and auditable                                                          |
| 5 — Multi-agent              | Supervisor, worker delegation, typed A2A messages, child lifecycle, blackboard, child budgets/authority ceilings, structured handoff/escalation                       | Delegation cannot expand parent authority or budget; child state is durable and attributable                                                             |
| 6 — Policy and HITL          | Capability Gateway, Policy Engine, L0–L5 autonomy, approvals/questions, Secret Broker seams, escalation, emergency stop, audit invariants                             | Trusted auth supplies tenant scope; model output cannot grant rights; approvals bind to exact action version; privileged work is fully audited           |
| 7 — Browser/computer workers | BrowserDriver, Playwright/CDP adapter, ComputerDriver, container worker, persistent profile/workspace snapshots, controlled egress, human takeover lease              | Isolated workers, deterministic policy enforcement, audited commands, safe takeover and revocation                                                       |
| 8 — Memory and routines      | Working, episodic, semantic, procedural, and organizational memory; trace-to-reviewed-Routine workflow and versioning                                                 | Provenance, retention, review, tenant isolation, and rollback are explicit; raw trace never becomes authority automatically                              |
| 9 — Observability and replay | OpenTelemetry, event explorer, public replay, checkpoint fork, provider/strategy comparison, budget monitoring, loop detection, progress watchdog                     | Replay is side-effect-free by default; forks are attributable; watchdog and cost signals are tested under failure                                        |
| 10 — Public ecosystem        | Stable public SDK, CLI, docs site, examples, skills format, agent packages, provider adapters, threat model, full dependency/license audit, first release             | Stable naming/versioning, compatibility matrix, at least two independent providers, security/legal/brand review, release automation and signed artifacts |

## MVP gates that remain open

The broader MVP is not achieved until at least:

- one durable agent reliably executes the model/tool loop across restart/redeploy;
- NDJSON reconnect resumes from a durable cursor;
- human input/approval can park and resume work safely;
- read/draft capabilities execute through deterministic policy and audit;
- at least two independent real model-provider adapters pass conformance;
- product compatibility passes independent contract traces through an adapter.

Phase 1 proves only the local execution semantics beneath these gates.

## Release gates

Before the first public release, maintainers must explicitly resolve the package
scope and brand, confirm hosting and release policy, run multi-version compatibility and
threat-model reviews, complete human dependency/license/NOTICE/provenance review,
and validate release artifacts. No current documentation authorizes package
publication, deployment, or product migration.
