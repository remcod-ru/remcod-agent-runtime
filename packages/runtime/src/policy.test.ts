import { defineAgent } from "@remcod/core";
import { ProviderRegistry } from "@remcod/model-router";
import {
  createApprovalLedger,
  createPolicyEngine,
  digestToolAction,
} from "@remcod/policy";
import { createId, type JsonValue } from "@remcod/protocol";
import { defineTool } from "@remcod/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createInMemoryRuntimeStore, createRuntime } from "./index.js";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type ScriptedResponse =
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly {
        readonly id: string;
        readonly name: string;
        readonly input: JsonValue;
      }[];
    }
  | { readonly kind: "message"; readonly content: JsonValue };

function scriptedProvider(script: readonly ScriptedResponse[]) {
  let cursor = 0;
  return {
    id: "scripted",
    remaining() {
      return script.length - cursor;
    },
    async generate() {
      const next = script[cursor];
      cursor += 1;
      if (!next) throw new Error("script exhausted");
      if (next.kind === "message") {
        return {
          kind: "message" as const,
          content: next.content,
          usage: USAGE,
        };
      }
      return {
        kind: "tool_calls" as const,
        calls: next.calls.map((call) => ({
          ...call,
          id: createId("ToolCallId", call.id),
        })),
        usage: USAGE,
      };
    },
  };
}

function harness(
  provider: { id: string; generate: () => Promise<unknown> },
  options: {
    readonly tools: readonly ReturnType<typeof defineTool>[];
    readonly policy?: ReturnType<typeof createPolicyEngine>;
    readonly approvals?: ReturnType<typeof createApprovalLedger>;
  },
) {
  const providers = new ProviderRegistry();
  providers.register(provider as never);
  const agent = defineAgent({
    id: "agent-1",
    name: "Agent One",
    instructions: "Be deterministic.",
    model: { providerId: provider.id, model: "scripted" },
    tools: options.tools as never,
  });
  return createRuntime({
    agents: [agent],
    providers,
    store: createInMemoryRuntimeStore(),
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.approvals ? { approvals: options.approvals } : {}),
  });
}

function writeTool(executions: { count: number }, name = "invoices.create") {
  return defineTool({
    name,
    description: "Side effect",
    inputSchema: z.object({ amount: z.number() }),
    outputSchema: z.object({ ok: z.boolean() }),
    risk: "write" as const,
    timeoutMs: 1_000,
    async execute() {
      executions.count += 1;
      return { ok: true };
    },
  });
}

describe("policy integration", () => {
  it("executes a write tool only with an approval bound to the exact action", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const policy = createPolicyEngine();
    const approvals = createApprovalLedger();
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
      },
      { kind: "message", content: { answer: "created" } },
    ]);
    const runtime = harness(provider, { tools: [tool], policy, approvals });
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });

    const request = approvals.request(
      {
        policyVersion: "1",
        policyDigest: policy.policyDigest,
        sessionId: session.id,
        turnId: createId("TurnId", "turn-pre"),
        stepId: createId("StepId", "step-pre"),
        toolCallId: createId("ToolCallId", "call-pre"),
        toolName: tool.name,
        risk: "write",
        inputDigest: digestToolAction({
          toolName: tool.name,
          input: { amount: 10 },
        }),
      },
      { principalId: "principal-1" },
    );
    approvals.decide(request.approvalId, {
      principalId: "principal-1",
      approved: true,
    });

    const result = await runtime.runTurn({
      sessionId: session.id,
      input: "create an invoice",
    });
    expect(result.session.status).toBe("completed");
    expect(provider.remaining()).toBe(0);
    expect(executions.count).toBe(1);
    expect(approvals.list()[0]?.consumedAt).not.toBeNull();
  });

  it("refuses a write tool when no approval matches the exact input", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const policy = createPolicyEngine();
    const approvals = createApprovalLedger();
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
      },
    ]);
    const runtime = harness(provider, { tools: [tool], policy, approvals });
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });

    const request = approvals.request(
      {
        policyVersion: "1",
        policyDigest: policy.policyDigest,
        sessionId: session.id,
        turnId: createId("TurnId", "turn-pre"),
        stepId: createId("StepId", "step-pre"),
        toolCallId: createId("ToolCallId", "call-pre"),
        toolName: tool.name,
        risk: "write",
        inputDigest: digestToolAction({
          toolName: tool.name,
          input: { amount: 999 },
        }),
      },
      { principalId: "principal-1" },
    );
    approvals.decide(request.approvalId, {
      principalId: "principal-1",
      approved: true,
    });

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "create an invoice" }),
    ).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
      details: { outcome: "approval_rejected", approval: "APPROVAL_MISMATCH" },
    });
    expect(executions.count).toBe(0);
    expect(approvals.list()[0]?.consumedAt).toBeNull();
  });

  it("keeps the legacy fail-closed behaviour without a policy engine", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
      },
    ]);
    const runtime = harness(provider, { tools: [tool] });
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    expect(executions.count).toBe(0);
  });

  it("denies a tool named by a deny rule and never executes it", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions, "finance.export");
    const policy = createPolicyEngine({
      rules: [
        {
          name: "no-finance-export",
          toolNames: ["finance.export"],
          decision: { outcome: "deny", reason: "finance export is forbidden" },
        },
      ],
    });
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id: "call-1", name: tool.name, input: { amount: 1 } }],
      },
    ]);
    const runtime = harness(provider, { tools: [tool], policy });
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    await expect(
      runtime.runTurn({ sessionId: session.id, input: "go" }),
    ).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
      details: { outcome: "denied" },
    });
    expect(executions.count).toBe(0);
  });

  it("consumes an approval once, so a second identical call fails closed", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const policy = createPolicyEngine();
    const approvals = createApprovalLedger();
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id: "call-1", name: tool.name, input: { amount: 5 } }],
      },
      {
        kind: "tool_calls",
        calls: [{ id: "call-2", name: tool.name, input: { amount: 5 } }],
      },
      { kind: "message", content: { answer: "never reached" } },
    ]);
    const runtime = harness(provider, { tools: [tool], policy, approvals });
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    const request = approvals.request(
      {
        policyVersion: "1",
        policyDigest: policy.policyDigest,
        sessionId: session.id,
        turnId: createId("TurnId", "turn-pre"),
        stepId: createId("StepId", "step-pre"),
        toolCallId: createId("ToolCallId", "call-pre"),
        toolName: tool.name,
        risk: "write",
        inputDigest: digestToolAction({
          toolName: tool.name,
          input: { amount: 5 },
        }),
      },
      { principalId: "principal-1" },
    );
    approvals.decide(request.approvalId, {
      principalId: "principal-1",
      approved: true,
    });

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "create twice" }),
    ).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
      details: {
        outcome: "approval_rejected",
        approval: "APPROVAL_ALREADY_CONSUMED",
      },
    });
    expect(executions.count).toBe(1);
  });

  it("refuses an approval issued under a different ruleset", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const approvalPolicy = createPolicyEngine();
    const runtimePolicy = createPolicyEngine({
      rules: [
        {
          name: "extra-rule",
          toolNames: ["unrelated.tool"],
          decision: { outcome: "deny", reason: "unrelated" },
        },
      ],
    });
    expect(runtimePolicy.policyDigest).not.toBe(approvalPolicy.policyDigest);
    const approvals = createApprovalLedger();
    const provider = scriptedProvider([
      {
        kind: "tool_calls",
        calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
      },
    ]);
    const runtime = harness(provider, {
      tools: [tool],
      policy: runtimePolicy,
      approvals,
    });
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });

    const request = approvals.request(
      {
        policyVersion: "1",
        policyDigest: approvalPolicy.policyDigest,
        sessionId: session.id,
        turnId: createId("TurnId", "turn-pre"),
        stepId: createId("StepId", "step-pre"),
        toolCallId: createId("ToolCallId", "call-pre"),
        toolName: tool.name,
        risk: "write",
        inputDigest: digestToolAction({
          toolName: tool.name,
          input: { amount: 10 },
        }),
      },
      { principalId: "principal-1" },
    );
    approvals.decide(request.approvalId, {
      principalId: "principal-1",
      approved: true,
    });

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "create an invoice" }),
    ).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
      details: { outcome: "approval_rejected", approval: "APPROVAL_MISMATCH" },
    });
    expect(executions.count).toBe(0);
  });
});
