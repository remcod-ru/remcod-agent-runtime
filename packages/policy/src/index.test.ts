import { createId } from "@remcod/protocol";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createApprovalLedger,
  createPolicyEngine,
  digestToolAction,
  type PolicyAction,
} from "./index.js";

function action(overrides: Partial<PolicyAction> = {}): PolicyAction {
  return {
    sessionId: createId("SessionId", "session-1"),
    turnId: createId("TurnId", "turn-1"),
    stepId: createId("StepId", "step-1"),
    toolCallId: createId("ToolCallId", "call-1"),
    toolName: "invoices.create",
    risk: "write",
    inputDigest: digestToolAction({
      toolName: "invoices.create",
      input: { amount: 100, currency: "RUB" },
    }),
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("is independent of object key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("sorts nested keys and keeps array order", () => {
    expect(canonicalJson({ z: [{ b: 1, a: 2 }], a: null })).toBe(
      '{"a":null,"z":[{"a":2,"b":1}]}',
    );
  });

  it("refuses non-finite numbers instead of emitting invalid JSON", () => {
    expect(() => canonicalJson(Number.NaN as never)).toThrowError(/non-finite/);
  });
});

describe("digestToolAction", () => {
  it("is stable for equal input in a different key order", () => {
    expect(digestToolAction({ toolName: "t", input: { a: 1, b: 2 } })).toBe(
      digestToolAction({ toolName: "t", input: { b: 2, a: 1 } }),
    );
  });

  it("changes when the tool name or the input changes", () => {
    const base = digestToolAction({ toolName: "t", input: { a: 1 } });
    expect(digestToolAction({ toolName: "u", input: { a: 1 } })).not.toBe(base);
    expect(digestToolAction({ toolName: "t", input: { a: 2 } })).not.toBe(base);
  });
});

describe("createPolicyEngine", () => {
  it("allows read and draft by default", () => {
    const engine = createPolicyEngine();
    expect(engine.evaluate(action({ risk: "read" }))).toEqual({
      outcome: "allow",
    });
    expect(engine.evaluate(action({ risk: "draft" }))).toEqual({
      outcome: "allow",
    });
  });

  it("requires approval for write and privileged by default", () => {
    const engine = createPolicyEngine();
    expect(engine.evaluate(action({ risk: "write" })).outcome).toBe(
      "require_approval",
    );
    expect(engine.evaluate(action({ risk: "privileged" })).outcome).toBe(
      "require_approval",
    );
  });

  it("honours an explicit deny rule for a named tool", () => {
    const engine = createPolicyEngine({
      rules: [
        {
          name: "no-finance-export",
          toolNames: ["finance.export"],
          decision: { outcome: "deny", reason: "finance export is forbidden" },
        },
      ],
    });
    expect(engine.evaluate(action({ toolName: "finance.export" }))).toEqual({
      outcome: "deny",
      reason: "finance export is forbidden",
    });
  });

  it("rejects duplicate rule names and empty tool lists", () => {
    expect(() =>
      createPolicyEngine({
        rules: [
          { name: "r", toolNames: ["a"], decision: { outcome: "allow" } },
          { name: "r", toolNames: ["b"], decision: { outcome: "allow" } },
        ],
      }),
    ).toThrowError(/Duplicate policy rule/);
    expect(() =>
      createPolicyEngine({
        rules: [{ name: "r", toolNames: [], decision: { outcome: "allow" } }],
      }),
    ).toThrowError(/at least one tool/);
  });

  it("rejects a malformed action instead of guessing", () => {
    const engine = createPolicyEngine();
    expect(() =>
      engine.evaluate(action({ inputDigest: "not-a-digest" })),
    ).toThrowError(/not valid/);
  });

  it("returns frozen decisions that callers cannot mutate", () => {
    const engine = createPolicyEngine();
    const decision = engine.evaluate(action({ risk: "read" }));
    expect(Object.isFrozen(decision)).toBe(true);
  });
});

describe("createApprovalLedger", () => {
  it("binds an approved action to its exact digest and consumes it once", () => {
    const ledger = createApprovalLedger({ idFactory: () => "apv_1" });
    const request = action();
    const record = ledger.request(request, { principalId: "principal-1" });
    expect(record.status).toBe("pending");

    ledger.decide("apv_1", { principalId: "principal-1", approved: true });
    const consumed = ledger.consume(request);
    expect(consumed.consumedAt).not.toBeNull();
    expect(consumed.consumedByToolCallId).toBe(request.toolCallId);

    expect(() => ledger.consume(request)).toThrowError(/already consumed/);
  });

  it("refuses an approval for different input, tool or session", () => {
    const ledger = createApprovalLedger({ idFactory: () => "apv_2" });
    const request = action();
    ledger.request(request, { principalId: "principal-1" });
    ledger.decide("apv_2", { principalId: "principal-1", approved: true });

    const otherInput = action({
      inputDigest: digestToolAction({
        toolName: "invoices.create",
        input: { amount: 1 },
      }),
    });
    expect(() => ledger.consume(otherInput)).toThrowError(
      /No approval matches this exact action/,
    );
    expect(() =>
      ledger.consume(action({ toolName: "invoices.delete" })),
    ).toThrowError(/No approval matches this exact action/);
    expect(() =>
      ledger.consume(
        action({ sessionId: createId("SessionId", "another-session") }),
      ),
    ).toThrowError(/No approval matches this exact action/);
  });

  it("fails closed for pending, denied and expired approvals", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const ledger = createApprovalLedger({
      clock: () => new Date(now),
      idFactory: (() => {
        let index = 0;
        return () => `apv_${++index}`;
      })(),
    });

    const pending = action({
      toolCallId: createId("ToolCallId", "c-pending"),
      inputDigest: digestToolAction({
        toolName: "invoices.create",
        input: { amount: 1 },
      }),
    });
    ledger.request(pending, { principalId: "principal-1" });
    expect(() => ledger.consume(pending)).toThrowError(/still pending/);

    const denied = action({
      toolCallId: createId("ToolCallId", "c-denied"),
      inputDigest: digestToolAction({
        toolName: "invoices.create",
        input: { amount: 2 },
      }),
    });
    ledger.request(denied, { principalId: "principal-1" });
    ledger.decide("apv_2", { principalId: "principal-1", approved: false });
    expect(() => ledger.consume(denied)).toThrowError(/was denied/);

    const expiring = action({
      toolCallId: createId("ToolCallId", "c-expiring"),
      inputDigest: digestToolAction({
        toolName: "invoices.create",
        input: { amount: 7 },
      }),
    });
    ledger.request(expiring, { principalId: "principal-1", ttlMs: 1000 });
    ledger.decide("apv_3", { principalId: "principal-1", approved: true });
    now += 1000;
    expect(() => ledger.consume(expiring)).toThrowError(/expired/);
  });

  it("refuses a second decision and an unknown approval", () => {
    const ledger = createApprovalLedger({ idFactory: () => "apv_4" });
    ledger.request(action(), { principalId: "principal-1" });
    ledger.decide("apv_4", { principalId: "principal-1", approved: true });
    expect(() =>
      ledger.decide("apv_4", { principalId: "principal-1", approved: false }),
    ).toThrowError(/already approved/);
    expect(() =>
      ledger.decide("apv_missing", { principalId: "p", approved: true }),
    ).toThrowError(/Unknown approval/);
  });

  it("requires a trusted principal for requests and decisions", () => {
    const ledger = createApprovalLedger();
    expect(() => ledger.request(action(), { principalId: "" })).toThrowError(
      /trusted principal/,
    );
  });

  it("fails closed when an approval is reused after consumption", () => {
    const ledger = createApprovalLedger({ idFactory: () => "apv_5" });
    ledger.request(action(), { principalId: "principal-1" });
    ledger.decide("apv_5", { principalId: "principal-1", approved: true });
    expect(ledger.consume(action()).consumedAt).not.toBeNull();
    expect(() => ledger.consume(action())).toThrowError(/already consumed/);
  });
});
