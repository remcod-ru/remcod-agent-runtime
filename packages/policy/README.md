# @remcod/policy

Owns the local decision boundary between a model-proposed tool call and a
side-effecting capability: risk classification of the exact action, an
explicit approval ledger bound to that action, and one-shot consumption.

## Why it exists

A model may propose any tool call. It must never be able to grant itself the
authority to run it. This package keeps that authority in a pure, deterministic
place:

- `createPolicyEngine()` maps a `PolicyAction` to `allow`, `deny` or
  `require_approval`. The default is fail-closed: `read` and `draft` run, while
  `write` and `privileged` always need an approval. The engine exposes the
  `policyDigest` of its exact ruleset and refuses an action built for another one.
- `createApprovalLedger()` stores approvals issued by a **trusted principal**
  (a server-side caller, never the model). An approval is bound to the policy
  digest and the exact canonical action digest; a different input, tool, session
  or ruleset does not match, and a second consumption fails closed. `withdraw()`
  retires a still-pending question, so an answer that arrives after the asker gave
  up is refused instead of authorizing work.
- `digestToolAction()` and `canonicalJson()` define that binding deterministically.

## Public surface

```ts
import {
  canonicalJson,
  createApprovalLedger,
  createPolicyEngine,
  digestToolAction,
} from "@remcod/policy";
```

The package performs no I/O, holds no network client and never touches a
database. The in-memory ledger is a Phase 1 foundation: it loses decisions on
process restart, which durability must not treat as a completed approval.

## Boundaries

- No principal, tenant or role comes from model output.
- No API accepts an approval record from untrusted input; the ledger is the only
  source of "approved".
- `consume()` is one-shot and atomic per approval record.
- Denying or expiring an approval never falls back to allowing the action.

See [`docs/adr/0008-policy-and-capability-approvals.md`](../../docs/adr/0008-policy-and-capability-approvals.md).
