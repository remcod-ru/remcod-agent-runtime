import {
  createId,
  type AgentId,
  type NewEvent,
  type Session,
} from "@remcod/protocol";
import { describe, expect, it } from "vitest";

import {
  CursorConflictError,
  VersionConflictError,
  createInMemoryRuntimeStore,
} from "./index.js";

const NOW = "2026-08-30T00:00:00.000Z";

function session(id = "session-1"): Session {
  return {
    id: createId("SessionId", id),
    protocolVersion: "1",
    agentId: createId("AgentId", "agent-1") as AgentId,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    lastEventCursor: 0,
  };
}

function createdEvent(value: Session): NewEvent<"session.created"> {
  return {
    id: createId("EventId", "event-created"),
    type: "session.created",
    correlationId: "correlation-1",
    occurredAt: NOW,
    data: { session: value },
  };
}

function transitionEvent(id: string): NewEvent<"session.status_changed"> {
  return {
    id: createId("EventId", id),
    type: "session.status_changed",
    correlationId: "correlation-1",
    occurredAt: NOW,
    data: { from: "idle", to: "running" },
  };
}

describe("in-memory runtime store", () => {
  it("creates an empty session with the first contiguous event and defensive snapshots", async () => {
    const store = createInMemoryRuntimeStore();
    const initial = session();
    const created = await store.createSession(initial, createdEvent(initial));

    expect(created).toMatchObject({ version: 0, lastEventCursor: 1 });
    const page = await store.readEvents({ sessionId: initial.id });
    expect(page.events.map(({ cursor, type }) => ({ cursor, type }))).toEqual([
      { cursor: 1, type: "session.created" },
    ]);

    (created as { status: string }).status = "failed";
    expect((await store.getSession(initial.id))?.status).toBe("idle");
  });

  it("serializes concurrent CAS writes and never partially appends the loser", async () => {
    const store = createInMemoryRuntimeStore();
    const initial = session();
    await store.createSession(initial, createdEvent(initial));

    const writes = await Promise.allSettled([
      store.compareAndSetSession(
        initial.id,
        0,
        { status: "running", updatedAt: NOW },
        [transitionEvent("event-winner-a")],
      ),
      store.compareAndSetSession(
        initial.id,
        0,
        { status: "running", updatedAt: NOW },
        [transitionEvent("event-winner-b")],
      ),
    ]);

    expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = writes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(VersionConflictError),
    });
    expect(
      (await store.readEvents({ sessionId: initial.id })).events,
    ).toHaveLength(2);
  });

  it("uses exclusive cursors and rejects cursor conflicts", async () => {
    const store = createInMemoryRuntimeStore();
    const initial = session();
    await store.createSession(initial, createdEvent(initial));
    await store.appendEvents(initial.id, 1, [transitionEvent("event-2")]);

    await expect(
      store.appendEvents(initial.id, 1, [transitionEvent("event-never")]),
    ).rejects.toBeInstanceOf(CursorConflictError);
    const page = await store.readEvents({
      sessionId: initial.id,
      afterCursor: 1,
      limit: 1,
    });
    expect(page.events.map((event) => event.cursor)).toEqual([2]);
    expect(page.nextCursor).toBeNull();
  });

  it("atomically claims idempotency and preserves completed null as a value", async () => {
    const store = createInMemoryRuntimeStore();
    const claims = await Promise.all([
      store.claimIdempotency("scope", "key", "fingerprint-a"),
      store.claimIdempotency("scope", "key", "fingerprint-a"),
    ]);

    expect(claims).toContainEqual({ status: "claimed" });
    expect(claims).toContainEqual({ status: "in_flight" });
    await store.completeIdempotency("scope", "key", null);
    expect(
      await store.claimIdempotency("scope", "key", "fingerprint-a"),
    ).toEqual({
      status: "completed",
      value: null,
    });
    expect(
      await store.claimIdempotency("scope", "key", "fingerprint-b"),
    ).toEqual({ status: "conflict" });
  });

  it("rejects a zero page limit so event iteration cannot stall", async () => {
    const store = createInMemoryRuntimeStore();
    const initial = session();
    await store.createSession(initial, createdEvent(initial));

    await expect(
      store.readEvents({ sessionId: initial.id, limit: 0 }),
    ).rejects.toThrow("limit must be a positive integer");
  });
});
