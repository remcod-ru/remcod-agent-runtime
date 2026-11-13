import { defineAgent } from "@remcod/core";
import { ProviderRegistry } from "@remcod/model-router";
import { createApprovalLedger, createPolicyEngine } from "@remcod/policy";
import { createId, type JsonValue, type RuntimeEvent } from "@remcod/protocol";
import { defineTool } from "@remcod/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createInMemoryRuntimeStore,
  createRuntime,
  type AgentRuntime,
} from "./index.js";

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

function approvalsHarness(
  script: readonly ScriptedResponse[],
  options: {
    readonly tool: ReturnType<typeof defineTool>;
    readonly approvals: ReturnType<typeof createApprovalLedger>;
    readonly policy?: ReturnType<typeof createPolicyEngine>;
    readonly clock?: () => Date;
  },
) {
  const provider = scriptedProvider(script);
  const providers = new ProviderRegistry();
  providers.register(provider as never);
  const agent = defineAgent({
    id: "agent-1",
    name: "Agent One",
    instructions: "Be deterministic.",
    model: { providerId: provider.id, model: "scripted" },
    tools: [options.tool] as never,
  });
  const runtime = createRuntime({
    agents: [agent],
    providers,
    store: createInMemoryRuntimeStore(),
    policy: options.policy ?? createPolicyEngine(),
    approvals: options.approvals,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { runtime, provider };
}

function writeTool(executions: { count: number }) {
  return defineTool({
    name: "invoices.create",
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

async function readEvents(runtime: AgentRuntime, sessionId: string) {
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.events({
    sessionId: sessionId as never,
  })) {
    events.push(event);
  }
  return events;
}

describe("interactive approvals", () => {
  it("parks a side-effecting call in waiting_input and reports the request", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const approvals = createApprovalLedger();
    const { runtime } = approvalsHarness(
      [
        {
          kind: "tool_calls",
          calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
        },
      ],
      { tool, approvals },
    );
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });

    const result = await runtime.runTurn({
      sessionId: session.id,
      input: "create an invoice",
    });

    expect(result.session.status).toBe("waiting_input");
    expect(result.turn.status).toBe("waiting_input");
    expect(result.pendingApproval?.toolName).toBe(tool.name);
    expect(result.pendingApproval?.risk).toBe("write");
    expect(result.pendingApproval?.requestId).toMatch(/^apv_/);
    expect(executions.count).toBe(0);

    const events = await readEvents(runtime, session.id);
    const requested = events.find((event) => event.type === "input.requested");
    expect(requested).toBeDefined();
    expect(
      events.some(
        (event) =>
          event.type === "tool.failed" &&
          (event.data.error as { code: string }).code === "POLICY_REQUIRED",
      ),
    ).toBe(true);
  });

  it("refuses runTurn and a pending resume without writing events", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const approvals = createApprovalLedger();
    const { runtime } = approvalsHarness(
      [
        {
          kind: "tool_calls",
          calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
        },
      ],
      { tool, approvals },
    );
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    await runtime.runTurn({ sessionId: session.id, input: "create" });
    const before = (await readEvents(runtime, session.id)).length;

    await expect(
      runtime.runTurn({ sessionId: session.id, input: "again" }),
    ).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      details: { reason: "approval_pending" },
    });
    await expect(
      runtime.resumeTurn({ sessionId: session.id }),
    ).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
      details: { outcome: "approval_pending" },
    });
    expect((await readEvents(runtime, session.id)).length).toBe(before);
    expect(executions.count).toBe(0);
  });

  it("resumes the same turn after approval and executes the call once", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const approvals = createApprovalLedger();
    const { runtime, provider } = approvalsHarness(
      [
        {
          kind: "tool_calls",
          calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
        },
        { kind: "message", content: { answer: "created" } },
      ],
      { tool, approvals },
    );
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    const parked = await runtime.runTurn({
      sessionId: session.id,
      input: "create an invoice",
    });
    const requestId = parked.pendingApproval?.requestId as string;

    approvals.decide(requestId, {
      principalId: "principal-1",
      approved: true,
    });

    const resumed = await runtime.resumeTurn({ sessionId: session.id });
    expect(resumed.session.status).toBe("completed");
    expect(resumed.turn.status).toBe("completed");
    expect(resumed.output).toEqual({ answer: "created" });
    expect(provider.remaining()).toBe(0);
    expect(executions.count).toBe(1);
    expect(approvals.get(requestId)?.consumedAt).not.toBeNull();

    const events = await readEvents(runtime, session.id);
    const receivedIndex = events.findIndex(
      (event) => event.type === "input.received",
    );
    const startedIndex = events.findIndex(
      (event) => event.type === "tool.started",
    );
    expect(receivedIndex).toBeGreaterThanOrEqual(0);
    expect(receivedIndex).toBeLessThan(startedIndex);
  });

  it("cancels fail-closed when the approval is denied", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const approvals = createApprovalLedger();
    const { runtime } = approvalsHarness(
      [
        {
          kind: "tool_calls",
          calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
        },
      ],
      { tool, approvals },
    );
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    const parked = await runtime.runTurn({
      sessionId: session.id,
      input: "create an invoice",
    });
    approvals.decide(parked.pendingApproval?.requestId as string, {
      principalId: "principal-1",
      approved: false,
    });

    await expect(
      runtime.resumeTurn({ sessionId: session.id }),
    ).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
      details: { outcome: "denied" },
    });
    expect(executions.count).toBe(0);
    const sessionAfter = await runtime.getSession(session.id);
    expect(sessionAfter?.status).toBe("cancelled");
    await expect(
      runtime.resumeTurn({ sessionId: session.id }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("cancels fail-closed when the approval expired before resume", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = () => new Date(now);
    const approvals = createApprovalLedger({ clock });
    const { runtime } = approvalsHarness(
      [
        {
          kind: "tool_calls",
          calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
        },
      ],
      { tool, approvals, clock },
    );
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    const parked = await runtime.runTurn({
      sessionId: session.id,
      input: "create an invoice",
    });
    approvals.decide(parked.pendingApproval?.requestId as string, {
      principalId: "principal-1",
      approved: true,
    });
    now += 16 * 60 * 1000;

    await expect(
      runtime.resumeTurn({ sessionId: session.id }),
    ).rejects.toMatchObject({
      code: "POLICY_REQUIRED",
      details: { outcome: "expired" },
    });
    expect(executions.count).toBe(0);
    expect((await runtime.getSession(session.id))?.status).toBe("cancelled");
  });

  it("withdraws the pending question when the session is cancelled, so a late answer cannot authorize work", async () => {
    const executions = { count: 0 };
    const tool = writeTool(executions);
    const approvals = createApprovalLedger();
    const { runtime } = approvalsHarness(
      [
        {
          kind: "tool_calls",
          calls: [{ id: "call-1", name: tool.name, input: { amount: 10 } }],
        },
      ],
      { tool, approvals },
    );
    const session = await runtime.createSession({
      agentId: createId("AgentId", "agent-1"),
    });
    const parked = await runtime.runTurn({
      sessionId: session.id,
      input: "create an invoice",
    });
    const requestId = parked.pendingApproval?.requestId as string;
    await runtime.cancelSession(session.id, "stop");
    expect(approvals.get(requestId)?.status).toBe("withdrawn");
    // The human answers after the question is gone: the answer is refused.
    expect(() =>
      approvals.decide(requestId, {
        principalId: "principal-1",
        approved: true,
      }),
    ).toThrowError(/already withdrawn/);

    await expect(
      runtime.resumeTurn({ sessionId: session.id }),
    ).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      details: { reason: "no_parked_turn" },
    });
    expect(executions.count).toBe(0);
  });
});
