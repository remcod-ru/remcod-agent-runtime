import { RuntimeEventSchema } from "@remcod/protocol";
import type { AgentRuntime, EventQuery } from "@remcod/runtime";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeHttpHandler,
  encodeRuntimeEventNdjson,
  encodeRuntimeEventsNdjson,
} from "./index.js";

const decoder = new TextDecoder();

const event = RuntimeEventSchema.parse({
  protocolVersion: "1",
  id: "event-1",
  cursor: 1,
  sessionId: "session-1",
  correlationId: "correlation-1",
  occurredAt: "2026-08-30T10:00:00.000Z",
  type: "session.completed",
  data: { output: { answer: 42 } },
});

async function readBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  let result = "";
  for await (const chunk of body) result += decoder.decode(chunk);
  return result;
}

describe("runtime NDJSON transport", () => {
  it("encodes one validated event per line and round-trips", () => {
    const line = decoder.decode(encodeRuntimeEventNdjson(event));

    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    expect(RuntimeEventSchema.parse(JSON.parse(line))).toEqual(event);
    expect(() => encodeRuntimeEventNdjson({ ...event, cursor: 0 })).toThrow();
  });

  it("pulls with consumer backpressure and aborts only the iterator", async () => {
    let pulls = 0;
    async function* source() {
      pulls += 1;
      yield event;
      pulls += 1;
      yield RuntimeEventSchema.parse({ ...event, id: "event-2", cursor: 2 });
    }
    const controller = new AbortController();
    const iterator = encodeRuntimeEventsNdjson(source(), controller.signal)[
      Symbol.asyncIterator
    ]();

    expect(pulls).toBe(0);
    expect(decoder.decode((await iterator.next()).value)).toContain(
      '"cursor":1',
    );
    expect(pulls).toBe(1);

    controller.abort("client disconnected");
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(pulls).toBe(1);
  });

  it("aborts a stuck pull promptly without awaiting a stuck return", async () => {
    let returnCalls = 0;
    const never = new Promise<IteratorResult<typeof event>>(() => undefined);
    const source: AsyncIterable<typeof event> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => never,
          return() {
            returnCalls += 1;
            return new Promise<IteratorResult<typeof event>>(() => undefined);
          },
        };
      },
    };
    const controller = new AbortController();
    const iterator = encodeRuntimeEventsNdjson(source, controller.signal)[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();
    await Promise.resolve();

    controller.abort("client disconnected");
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("abort timed out")), 100),
      ),
    ]);

    expect(result).toEqual({ done: true, value: undefined });
    expect(returnCalls).toBe(1);
  });

  it("serves strict exclusive reconnect order and clamps the HTTP limit", async () => {
    const events = [1, 2, 3].map((cursor) =>
      RuntimeEventSchema.parse({
        ...event,
        id: `event-${cursor}`,
        cursor,
      }),
    );
    const queries: EventQuery[] = [];
    const closedAfterCursors: number[] = [];
    const runtime = {
      async getSession() {
        return {
          id: "session-1",
          protocolVersion: "1",
          agentId: "agent-1",
          status: "completed",
          createdAt: "2026-08-30T10:00:00.000Z",
          updatedAt: "2026-08-30T10:00:01.000Z",
          version: 1,
          lastEventCursor: 3,
        };
      },
      async *events(query: EventQuery) {
        queries.push(query);
        try {
          for (const item of events) {
            if (item.cursor > (query.afterCursor ?? 0)) yield item;
          }
        } finally {
          closedAfterCursors.push(query.afterCursor ?? 0);
        }
      },
    } as AgentRuntime;
    const handler = createRuntimeHttpHandler(runtime);

    const first = await handler({
      method: "GET",
      url: "/v1/sessions/session-1/events?afterCursor=1&limit=5000",
      signal: new AbortController().signal,
    });
    expect(first).toMatchObject({
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
    expect(
      (await readBody(first.body as AsyncIterable<Uint8Array>))
        .trim()
        .split("\n")
        .map((line) => RuntimeEventSchema.parse(JSON.parse(line)).cursor),
    ).toEqual([2, 3]);

    const reconnect = await handler({
      method: "GET",
      url: "/v1/sessions/session-1/events?afterCursor=2&limit=10",
      signal: new AbortController().signal,
    });
    expect(
      (await readBody(reconnect.body as AsyncIterable<Uint8Array>))
        .trim()
        .split("\n")
        .map((line) => RuntimeEventSchema.parse(JSON.parse(line)).cursor),
    ).toEqual([3]);
    const capped = await handler({
      method: "GET",
      url: "/v1/sessions/session-1/events?afterCursor=0&limit=1",
      signal: new AbortController().signal,
    });
    expect(
      (await readBody(capped.body as AsyncIterable<Uint8Array>))
        .trim()
        .split("\n")
        .map((line) => RuntimeEventSchema.parse(JSON.parse(line)).cursor),
    ).toEqual([1]);
    const lowerClamp = await handler({
      method: "GET",
      url: "/v1/sessions/session-1/events?afterCursor=3&limit=0",
      signal: new AbortController().signal,
    });
    expect(lowerClamp.status).toBe(200);
    expect(await readBody(lowerClamp.body as AsyncIterable<Uint8Array>)).toBe(
      "",
    );
    expect(queries).toEqual([
      { sessionId: "session-1", afterCursor: 1, limit: 1000 },
      { sessionId: "session-1", afterCursor: 2, limit: 10 },
      { sessionId: "session-1", afterCursor: 0, limit: 1 },
      { sessionId: "session-1", afterCursor: 3, limit: 1 },
    ]);
    expect(closedAfterCursors).toEqual([1, 2, 0, 3]);
  });

  it("preserves raw dot and percent-encoded session path segments", async () => {
    const sessionIds: string[] = [];
    const queries: EventQuery[] = [];
    const runtime = {
      async getSession(sessionId: string) {
        sessionIds.push(sessionId);
        return {};
      },
      events(query: EventQuery) {
        queries.push(query);
        return (async function* () {})();
      },
    } as unknown as AgentRuntime;
    const handler = createRuntimeHttpHandler(runtime);
    const signal = new AbortController().signal;

    for (const url of [
      "/v1/sessions/./events",
      "/v1/sessions/../events",
      "/v1/sessions/id%2Fvalue/events",
      "/v1/sessions/id%252Fvalue/events",
    ]) {
      expect(await handler({ method: "GET", url, signal })).toMatchObject({
        status: 200,
      });
    }
    expect(sessionIds).toEqual([".", "..", "id/value", "id%2Fvalue"]);

    expect(
      await handler({
        method: "GET",
        url: "/v1/sessions/query/events?afterCursor=%31&limit=%31",
        signal,
      }),
    ).toMatchObject({ status: 200 });
    expect(queries.at(-1)).toEqual({
      sessionId: "query",
      afterCursor: 1,
      limit: 1,
    });
    expect(
      await handler({
        method: "GET",
        url: "/v1/sessions/query/events?afterCursor=%2531",
        signal,
      }),
    ).toMatchObject({
      status: 400,
      body: { code: "VALIDATION_FAILED" },
    });

    expect(
      await handler({
        method: "GET",
        url: "/v1/sessions/%ZZ/events",
        signal,
      }),
    ).toMatchObject({
      status: 400,
      body: { code: "VALIDATION_FAILED" },
    });
    expect(
      await handler({
        method: "GET",
        url: "/v1/sessions/query/events?limit=%ZZ",
        signal,
      }),
    ).toMatchObject({
      status: 400,
      body: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects malformed absolute URL authorities before raw path routing", async () => {
    const runtime = {
      async getSession() {
        return {};
      },
      async *events() {},
    } as unknown as AgentRuntime;
    const handler = createRuntimeHttpHandler(runtime);
    const signal = new AbortController().signal;

    for (const url of [
      "http://%ZZ/v1/sessions/session-1/events",
      "http://[::1/v1/sessions/session-1/events",
      "http://runtime.local:99999/v1/sessions/session-1/events",
      "http://runtime.local\\evil/v1/sessions/session-1/events",
      "http://runtime.local\n.evil/v1/sessions/session-1/events",
    ]) {
      expect(await handler({ method: "GET", url, signal })).toMatchObject({
        status: 400,
        body: { code: "VALIDATION_FAILED" },
      });
    }

    for (let codePoint = 0; codePoint <= 0x1f; codePoint += 1) {
      const control = String.fromCharCode(codePoint);
      expect(
        await handler({
          method: "GET",
          url: `http://runtime.local${control}evil/v1/sessions/session-1/events`,
          signal,
        }),
      ).toMatchObject({
        status: 400,
        body: { code: "VALIDATION_FAILED" },
      });
    }
  });

  it("disconnects without cancelling or mutating runtime state", async () => {
    const state = { status: "running", version: 7 };
    let cancelCalls = 0;
    let iteratorClosed = false;
    const runtime = {
      async getSession() {
        return { ...state };
      },
      async *events() {
        try {
          yield event;
          yield RuntimeEventSchema.parse({
            ...event,
            id: "event-2",
            cursor: 2,
          });
        } finally {
          iteratorClosed = true;
        }
      },
      async cancelSession() {
        cancelCalls += 1;
        state.status = "cancelled";
      },
    } as unknown as AgentRuntime;
    const controller = new AbortController();
    const response = await createRuntimeHttpHandler(runtime)({
      method: "GET",
      url: "/v1/sessions/session-1/events",
      signal: controller.signal,
    });
    const iterator = (response.body as AsyncIterable<Uint8Array>)[
      Symbol.asyncIterator
    ]();

    expect((await iterator.next()).done).toBe(false);
    controller.abort("socket closed");
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(iteratorClosed).toBe(true));
    expect(cancelCalls).toBe(0);
    expect(state).toEqual({ status: "running", version: 7 });
  });

  it("handler abort closes the real stuck runtime iterator promptly", async () => {
    let returnCalls = 0;
    const source: AsyncIterable<typeof event> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<typeof event>>(() => undefined),
          return() {
            returnCalls += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const runtime = {
      async getSession() {
        return {};
      },
      events() {
        return source;
      },
    } as unknown as AgentRuntime;
    const controller = new AbortController();
    const response = await createRuntimeHttpHandler(runtime)({
      method: "GET",
      url: "/v1/sessions/session-1/events?limit=1",
      signal: controller.signal,
    });
    const iterator = (response.body as AsyncIterable<Uint8Array>)[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();
    await Promise.resolve();

    controller.abort("socket closed");
    expect(
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("handler abort timed out")), 100),
        ),
      ]),
    ).toEqual({ done: true, value: undefined });
    expect(returnCalls).toBe(1);
  });

  it("returns exact method, validation, missing-session, and conflict problems", async () => {
    const controller = new AbortController();
    const runtime = {
      async getSession(sessionId: string) {
        if (sessionId === "missing") return null;
        if (sessionId === "conflict") {
          throw Object.assign(new Error("cursor changed"), {
            code: "CURSOR_CONFLICT",
          });
        }
        if (sessionId === "explode") {
          throw new Error("database password leaked in internal error");
        }
        return {};
      },
    } as AgentRuntime;
    const handler = createRuntimeHttpHandler(runtime);

    const method = await handler({
      method: "POST",
      url: "/v1/sessions/session-1/events",
      signal: controller.signal,
    });
    expect(method).toMatchObject({
      status: 405,
      headers: {
        Allow: "GET",
        "Content-Type": "application/problem+json",
      },
      body: { code: "METHOD_NOT_ALLOWED", status: 405 },
    });

    const invalid = await handler({
      method: "GET",
      url: "/v1/sessions/session-1/events?afterCursor=1.5",
      signal: controller.signal,
    });
    expect(invalid).toMatchObject({
      status: 400,
      headers: { "Content-Type": "application/problem+json" },
      body: { code: "VALIDATION_FAILED", status: 400 },
    });

    const missing = await handler({
      method: "GET",
      url: "/v1/sessions/missing/events",
      signal: controller.signal,
    });
    expect(missing).toMatchObject({
      status: 404,
      body: { code: "SESSION_NOT_FOUND", status: 404 },
    });

    const conflict = await handler({
      method: "GET",
      url: "/v1/sessions/conflict/events",
      signal: controller.signal,
    });
    expect(conflict).toMatchObject({
      status: 409,
      body: { code: "CURSOR_CONFLICT", status: 409 },
    });

    const internal = await handler({
      method: "GET",
      url: "/v1/sessions/explode/events",
      signal: controller.signal,
    });
    expect(internal).toMatchObject({
      status: 500,
      headers: { "Content-Type": "application/problem+json" },
      body: {
        code: "INTERNAL_ERROR",
        detail: "The runtime request failed",
        status: 500,
      },
    });
    expect(JSON.stringify(internal.body)).not.toContain("password");

    const runtimeFailure = await createRuntimeHttpHandler({
      async getSession() {
        return {};
      },
      events() {
        throw new Error("private store topology");
      },
    } as unknown as AgentRuntime)({
      method: "GET",
      url: "/v1/sessions/session-1/events",
      signal: controller.signal,
    });
    expect(runtimeFailure).toMatchObject({
      status: 500,
      body: {
        code: "INTERNAL_ERROR",
        detail: "The runtime request failed",
      },
    });
    expect(JSON.stringify(runtimeFailure.body)).not.toContain("topology");
  });
});
