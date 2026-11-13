# ADR 0008 — Policy decisions and capability-bound approvals

**Status:** Accepted (first Phase 6 slice). Interactive park/resume stays deferred
until durable continuation exists.

## Context

Phase 1 refuses every `write` and `privileged` tool call with `POLICY_REQUIRED`
before execution. That is a safe default, but it means no product mutation can
ever run through the runtime: a working agent that edits estimates, invoices or
tasks needs a way to authorize the exact effect it proposes.

Two failure modes had to stay impossible:

- the model granting itself authority (a tool call, prompt text or structured
  output must never widen rights);
- an approval drifting to a different action (approve "create invoice 100",
  execute "delete invoice 100").

## Decision

1. A new package `@remcod/policy` owns the decision boundary and has no I/O:
   `createPolicyEngine()` maps a `PolicyAction` (session, turn, step, tool call,
   tool name, risk, canonical input digest) to `allow`, `deny` or
   `require_approval`.
2. The default is fail-closed: `read`/`draft` are allowed, `write`/`privileged`
   always require an approval unless an explicit rule decides otherwise. Rules are
   immutable, ordered by declaration, and matched by exact tool name.
3. `createApprovalLedger()` stores approvals issued by a **trusted principal**
   (a server-side caller). An approval binds to the session, the tool name and
   the SHA-256 digest of the canonical `{ input, toolName }` pair. `consume()`
   is one-shot: a second attempt, a different digest, a denied request, a pending
   request or an expired one all fail closed with a typed error code.
4. `createRuntime({ policy, approvals })` evaluates the policy for each proposed
   tool call before input validation and idempotency. Both a denial and a missing
   approval fail the turn with the existing `POLICY_REQUIRED` code, distinguishing
   the case through `details.outcome` (`denied`, `approval_required`,
   `approval_rejected`) and `details.approval` (`APPROVAL_MISMATCH`,
   `APPROVAL_ALREADY_CONSUMED`, `APPROVAL_NOT_APPROVED`, `APPROVAL_EXPIRED`).
   Omitting `policy` preserves the Phase 1 blanket refusal exactly.

## Consequences

- Side effects are now executable and auditable without giving the model
  authority: authority enters only through the ledger, which lives outside the
  model context.
- Approvals are in-memory and process-scoped. Restart loses them; a durable store
  (Phase 2) must persist decisions and their binding before production use.
- No interactive approval flow yet: an agent cannot park, ask a human and resume.
  That needs durable continuation, so Phase 6 keeps its place after Phase 2.
- The protocol stays at v1: no new event type and no new error code. A denial and
  a missing approval reuse `POLICY_REQUIRED`, and the machine-readable reason
  travels in `details`, which is already an open JSON value. Old readers keep
  validating every emitted event.
- Per-decision protocol events (an audit stream of `policy.decided`) are deferred
  to Phase 9 observability instead of widening the event union now.

## Alternatives rejected

- **Approval as a model tool.** The model would be able to approve itself;
  violates the trust boundary.
- **Trusting an approval object passed in the turn input.** Any caller could
  fabricate it, and it would travel through the same channel as model output.
- **Binding approvals to tool name only.** Approving a tool would authorize any
  input it is later called with, which is the drift this ADR exists to prevent.
- **New event type per decision now.** It would widen the closed event union
  before an audit consumer exists; failure details on `tool.failed` already carry
  the digest and the reason.
