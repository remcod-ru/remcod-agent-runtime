import {
  SessionIdSchema,
  RuntimeEventSchema,
  type JsonValue,
  type RuntimeEvent,
} from "@remcod/protocol";
import type { AgentRuntime } from "@remcod/runtime";

const encoder = new TextEncoder();

export function encodeRuntimeEventNdjson(event: RuntimeEvent): Uint8Array {
  const parsed = RuntimeEventSchema.parse(event);
  return encoder.encode(`${JSON.stringify(parsed)}\n`);
}

const abortedPull = Symbol("aborted-pull");

async function nextOrAbort<Value>(
  iterator: AsyncIterator<Value>,
  signal: AbortSignal,
): Promise<IteratorResult<Value> | typeof abortedPull> {
  if (signal.aborted) return abortedPull;
  let onAbort!: () => void;
  const abort = new Promise<typeof abortedPull>((resolve) => {
    onAbort = () => resolve(abortedPull);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const next = Promise.resolve().then(() => iterator.next());
  try {
    return await Promise.race([next, abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function closeIteratorBestEffort<Value>(iterator: AsyncIterator<Value>): void {
  try {
    void iterator.return?.().then(undefined, () => undefined);
  } catch {
    // A disconnected consumer must not wait for or expose source cleanup errors.
  }
}

export async function* encodeRuntimeEventsNdjson(
  events: AsyncIterable<RuntimeEvent>,
  signal?: AbortSignal,
  limit: number = Number.POSITIVE_INFINITY,
): AsyncIterable<Uint8Array> {
  if (
    limit !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(limit) || limit <= 0)
  ) {
    throw new TypeError("limit must be a positive integer");
  }
  const iterator = events[Symbol.asyncIterator]();
  let emitted = 0;
  try {
    while (!signal?.aborted && emitted < limit) {
      const next = signal
        ? await nextOrAbort(iterator, signal)
        : await iterator.next();
      if (next === abortedPull || next.done || signal?.aborted) return;
      yield encodeRuntimeEventNdjson(next.value);
      emitted += 1;
    }
  } finally {
    closeIteratorBestEffort(iterator);
  }
}

export interface RuntimeHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly signal: AbortSignal;
}

export interface RuntimeHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array> | JsonValue;
}

export type RuntimeHttpHandler = (
  request: RuntimeHttpRequest,
) => Promise<RuntimeHttpResponse>;

export interface RuntimeProblem extends Readonly<Record<string, JsonValue>> {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
}

const streamHeaders = Object.freeze({
  "Cache-Control": "no-cache, no-transform",
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "X-Accel-Buffering": "no",
});

const problemHeaders = Object.freeze({
  "Content-Type": "application/problem+json",
});

function problem(
  status: number,
  code: string,
  title: string,
  detail: string,
  headers: Readonly<Record<string, string>> = problemHeaders,
): RuntimeHttpResponse {
  return {
    status,
    headers,
    body: { type: "about:blank", title, status, code, detail },
  };
}

function parseInteger(
  search: URLSearchParams,
  name: string,
  defaultValue: number,
): number {
  const values = search.getAll(name);
  if (values.length === 0) return defaultValue;
  if (values.length !== 1 || !/^-?\d+$/.test(values[0] ?? "")) {
    throw new TypeError(`${name} must be an integer`);
  }
  const parsed = Number(values[0]);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return parsed;
}

function assertValidPercentEncoding(value: string): void {
  for (
    let index = value.indexOf("%");
    index !== -1;
    index = value.indexOf("%", index + 1)
  ) {
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      throw new TypeError("URL contains malformed percent encoding");
    }
  }
}

function parseRawRequestUrl(value: string): {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
} {
  let target = value;
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.exec(value);
  if (scheme) {
    const authorityStart = scheme[0].length;
    const pathStart = value.indexOf("/", authorityStart);
    const queryStart = value.indexOf("?", authorityStart);
    const fragmentStart = value.indexOf("#", authorityStart);
    const candidates = [pathStart, queryStart, fragmentStart].filter(
      (index) => index >= 0,
    );
    const authorityEnd =
      candidates.length === 0 ? value.length : Math.min(...candidates);
    if (authorityEnd === authorityStart) {
      throw new TypeError("The request URL is invalid");
    }
    const rawAuthority = value.slice(authorityStart, authorityEnd);
    if (/[\\\u0000-\u001f]/.test(rawAuthority)) {
      throw new TypeError("The request URL is invalid");
    }
    try {
      new URL(value);
    } catch {
      throw new TypeError("The request URL is invalid");
    }
    target = value.slice(authorityEnd);
    if (target === "" || target.startsWith("?") || target.startsWith("#")) {
      target = `/${target}`;
    }
  } else if (!value.startsWith("/")) {
    throw new TypeError("The request URL is invalid");
  }

  const fragmentIndex = target.indexOf("#");
  const withoutFragment =
    fragmentIndex === -1 ? target : target.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf("?");
  const pathname =
    queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutFragment.slice(queryIndex + 1);
  assertValidPercentEncoding(pathname);
  assertValidPercentEncoding(query);
  return { pathname, searchParams: new URLSearchParams(query) };
}

function conflictCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { readonly code?: unknown }).code === "VERSION_CONFLICT" ||
      (error as { readonly code?: unknown }).code === "CURSOR_CONFLICT")
  ) {
    return (error as { readonly code: string }).code;
  }
  return null;
}

export function createRuntimeHttpHandler(
  runtime: AgentRuntime,
): RuntimeHttpHandler {
  return async (request) => {
    let url;
    try {
      url = parseRawRequestUrl(request.url);
    } catch {
      return problem(
        400,
        "VALIDATION_FAILED",
        "Invalid request",
        "The request URL is invalid",
      );
    }

    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (!match) {
      return problem(404, "NOT_FOUND", "Not found", "Route not found");
    }
    if (request.method !== "GET") {
      return problem(
        405,
        "METHOD_NOT_ALLOWED",
        "Method not allowed",
        "Only GET is supported for this route",
        Object.freeze({ ...problemHeaders, Allow: "GET" }),
      );
    }

    let sessionId;
    let afterCursor;
    let limit;
    try {
      sessionId = SessionIdSchema.parse(decodeURIComponent(match[1] ?? ""));
      const allowed = new Set(["afterCursor", "limit"]);
      for (const name of url.searchParams.keys()) {
        if (!allowed.has(name)) throw new TypeError(`Unknown query: ${name}`);
      }
      afterCursor = parseInteger(url.searchParams, "afterCursor", 0);
      if (afterCursor < 0) {
        throw new TypeError("afterCursor must be a non-negative integer");
      }
      limit = Math.min(
        1000,
        Math.max(1, parseInteger(url.searchParams, "limit", 1000)),
      );
    } catch (error) {
      return problem(
        400,
        "VALIDATION_FAILED",
        "Invalid request",
        error instanceof Error ? error.message : "Invalid request parameters",
      );
    }

    try {
      if ((await runtime.getSession(sessionId)) === null) {
        return problem(
          404,
          "SESSION_NOT_FOUND",
          "Session not found",
          `Unknown session: ${sessionId}`,
        );
      }
    } catch (error) {
      const code = conflictCode(error);
      if (code === null) {
        return problem(
          500,
          "INTERNAL_ERROR",
          "Internal server error",
          "The runtime request failed",
        );
      }
      return problem(
        409,
        code,
        "Runtime conflict",
        error instanceof Error ? error.message : "Runtime conflict",
      );
    }

    let events: AsyncIterable<RuntimeEvent>;
    try {
      events = runtime.events({ sessionId, afterCursor, limit });
    } catch {
      return problem(
        500,
        "INTERNAL_ERROR",
        "Internal server error",
        "The runtime request failed",
      );
    }

    return {
      status: 200,
      headers: streamHeaders,
      body: encodeRuntimeEventsNdjson(events, request.signal, limit),
    };
  };
}
