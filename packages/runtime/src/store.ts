import {
  RuntimeEventSchema,
  SessionSchema,
  type JsonValue,
  type NewEvent,
  type RuntimeEvent,
  type Session,
  type SessionId,
  type SessionStatus,
} from "@remcod/protocol";

export interface EventQuery {
  readonly sessionId: SessionId;
  readonly afterCursor?: number;
  readonly limit?: number;
}

export interface EventPage {
  readonly events: readonly RuntimeEvent[];
  readonly nextCursor: number | null;
}

export interface SessionUpdate {
  readonly status?: SessionStatus;
  readonly updatedAt: string;
}

export interface RuntimeStore {
  createSession(session: Session, event: NewEvent): Promise<Session>;
  getSession(id: SessionId): Promise<Session | null>;
  compareAndSetSession(
    id: SessionId,
    expectedVersion: number,
    update: SessionUpdate,
    events: readonly NewEvent[],
  ): Promise<Session>;
  appendEvents(
    sessionId: SessionId,
    expectedCursor: number,
    events: readonly NewEvent[],
  ): Promise<readonly RuntimeEvent[]>;
  readEvents(query: EventQuery): Promise<EventPage>;
  claimIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyClaim>;
  completeIdempotency(
    scope: string,
    key: string,
    value: JsonValue,
  ): Promise<void>;
}

export type IdempotencyClaim =
  | { readonly status: "claimed" }
  | { readonly status: "in_flight" }
  | { readonly status: "completed"; readonly value: JsonValue }
  | { readonly status: "conflict" };

export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  readonly retryable = false;

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Session version conflict: expected ${expectedVersion}, received ${actualVersion}`,
    );
    this.name = "VersionConflictError";
  }
}

export class CursorConflictError extends Error {
  readonly code = "CURSOR_CONFLICT";
  readonly retryable = false;

  constructor(
    readonly expectedCursor: number,
    readonly actualCursor: number,
  ) {
    super(
      `Event cursor conflict: expected ${expectedCursor}, received ${actualCursor}`,
    );
    this.name = "CursorConflictError";
  }
}

export class SessionAlreadyExistsError extends Error {
  readonly code = "VERSION_CONFLICT";
  readonly retryable = false;

  constructor(readonly sessionId: SessionId) {
    super(`Session already exists: ${sessionId}`);
    this.name = "SessionAlreadyExistsError";
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "VALIDATION_FAILED";
  readonly retryable = false;

  constructor(readonly sessionId: SessionId) {
    super(`Unknown session: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class IdempotencyStateError extends Error {
  readonly code = "CURSOR_CONFLICT";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "IdempotencyStateError";
  }
}

function snapshot<Value>(value: Value): Value {
  return structuredClone(value);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (!/\S/.test(value)) throw new TypeError(`${name} cannot be blank`);
}

function materializeEvents(
  sessionId: SessionId,
  expectedCursor: number,
  events: readonly NewEvent[],
): readonly RuntimeEvent[] {
  return events.map((event, index) =>
    RuntimeEventSchema.parse({
      ...event,
      protocolVersion: "1",
      sessionId,
      cursor: expectedCursor + index + 1,
    }),
  );
}

class InMemoryRuntimeStore implements RuntimeStore {
  readonly #sessions = new Map<SessionId, Session>();
  readonly #events = new Map<SessionId, readonly RuntimeEvent[]>();
  readonly #idempotency = new Map<
    string,
    | { readonly status: "in_flight"; readonly fingerprint: string }
    | {
        readonly status: "completed";
        readonly fingerprint: string;
        readonly value: JsonValue;
      }
  >();
  readonly #writeTails = new Map<SessionId, Promise<void>>();

  async #serialize<Value>(
    sessionId: SessionId,
    operation: () => Value,
  ): Promise<Value> {
    const previous = this.#writeTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#writeTails.set(sessionId, tail);
    await previous;
    try {
      return operation();
    } finally {
      release();
      if (this.#writeTails.get(sessionId) === tail) {
        this.#writeTails.delete(sessionId);
      }
    }
  }

  async createSession(session: Session, event: NewEvent): Promise<Session> {
    const parsed = SessionSchema.parse(session);
    return this.#serialize(parsed.id, () => {
      if (this.#sessions.has(parsed.id)) {
        throw new SessionAlreadyExistsError(parsed.id);
      }
      if (parsed.version !== 0 || parsed.lastEventCursor !== 0) {
        throw new TypeError(
          "A new session must start at version and cursor zero",
        );
      }
      const storedEvents = materializeEvents(parsed.id, 0, [event]);
      const stored = SessionSchema.parse({ ...parsed, lastEventCursor: 1 });
      this.#sessions.set(parsed.id, snapshot(stored));
      this.#events.set(parsed.id, snapshot(storedEvents));
      return snapshot(stored);
    });
  }

  async getSession(id: SessionId): Promise<Session | null> {
    const stored = this.#sessions.get(id);
    return stored === undefined ? null : snapshot(stored);
  }

  async compareAndSetSession(
    id: SessionId,
    expectedVersion: number,
    update: SessionUpdate,
    events: readonly NewEvent[],
  ): Promise<Session> {
    assertNonNegativeInteger("expectedVersion", expectedVersion);
    return this.#serialize(id, () => {
      const current = this.#sessions.get(id);
      if (!current) throw new SessionNotFoundError(id);
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version);
      }
      const materialized = materializeEvents(
        id,
        current.lastEventCursor,
        events,
      );
      const updated = SessionSchema.parse({
        ...current,
        ...update,
        version: current.version + 1,
        lastEventCursor: current.lastEventCursor + materialized.length,
      });
      this.#events.set(id, [
        ...(this.#events.get(id) ?? []),
        ...snapshot(materialized),
      ]);
      this.#sessions.set(id, snapshot(updated));
      return snapshot(updated);
    });
  }

  async appendEvents(
    sessionId: SessionId,
    expectedCursor: number,
    events: readonly NewEvent[],
  ): Promise<readonly RuntimeEvent[]> {
    assertNonNegativeInteger("expectedCursor", expectedCursor);
    return this.#serialize(sessionId, () => {
      const current = this.#sessions.get(sessionId);
      if (!current) throw new SessionNotFoundError(sessionId);
      if (current.lastEventCursor !== expectedCursor) {
        throw new CursorConflictError(expectedCursor, current.lastEventCursor);
      }
      const materialized = materializeEvents(sessionId, expectedCursor, events);
      const updated = SessionSchema.parse({
        ...current,
        lastEventCursor: expectedCursor + materialized.length,
      });
      this.#events.set(sessionId, [
        ...(this.#events.get(sessionId) ?? []),
        ...snapshot(materialized),
      ]);
      this.#sessions.set(sessionId, snapshot(updated));
      return snapshot(materialized);
    });
  }

  async readEvents(query: EventQuery): Promise<EventPage> {
    const afterCursor = query.afterCursor ?? 0;
    assertNonNegativeInteger("afterCursor", afterCursor);
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit <= 0) {
        throw new TypeError("limit must be a positive integer");
      }
    }
    const all = this.#events.get(query.sessionId) ?? [];
    const available = all.filter((event) => event.cursor > afterCursor);
    const selected = available.slice(0, query.limit);
    const nextCursor =
      selected.length < available.length
        ? (selected.at(-1)?.cursor ?? afterCursor)
        : null;
    return { events: snapshot(selected), nextCursor };
  }

  async claimIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyClaim> {
    assertNonEmpty("scope", scope);
    assertNonEmpty("key", key);
    assertNonEmpty("fingerprint", fingerprint);
    const composite = `${scope}\0${key}`;
    const stored = this.#idempotency.get(composite);
    if (stored && stored.fingerprint !== fingerprint) {
      return { status: "conflict" };
    }
    if (stored?.status === "completed") {
      return { status: "completed", value: snapshot(stored.value) };
    }
    if (stored?.status === "in_flight") return { status: "in_flight" };
    this.#idempotency.set(composite, { status: "in_flight", fingerprint });
    return { status: "claimed" };
  }

  async completeIdempotency(
    scope: string,
    key: string,
    value: JsonValue,
  ): Promise<void> {
    assertNonEmpty("scope", scope);
    assertNonEmpty("key", key);
    const composite = `${scope}\0${key}`;
    const stored = this.#idempotency.get(composite);
    if (stored?.status !== "in_flight") {
      throw new IdempotencyStateError(
        `Idempotency key is not claimed in flight: ${scope}/${key}`,
      );
    }
    this.#idempotency.set(composite, {
      status: "completed",
      fingerprint: stored.fingerprint,
      value: snapshot(value),
    });
  }
}

export function createInMemoryRuntimeStore(): RuntimeStore {
  return new InMemoryRuntimeStore();
}
