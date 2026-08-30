import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@remcod/model-router";

export type ScriptedModelItem =
  | { readonly kind: "response"; readonly response: ModelResponse }
  | { readonly kind: "error"; readonly error: unknown };

function cloneAndFreezePlainData<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezePlainData)) as Value;
  }
  if (typeof value !== "object" || value === null) return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const clone = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      cloneAndFreezePlainData(entry),
    ]),
  );
  return Object.freeze(clone) as Value;
}

function snapshotScriptItem(item: ScriptedModelItem): ScriptedModelItem {
  return item.kind === "response"
    ? Object.freeze({
        kind: "response",
        response: cloneAndFreezePlainData(item.response),
      })
    : Object.freeze({ kind: "error", error: item.error });
}

export class ScriptExhaustedError extends Error {
  readonly code = "SCRIPT_EXHAUSTED";
  readonly retryable = false;

  constructor() {
    super("Scripted model has no remaining items");
    this.name = "ScriptExhaustedError";
  }
}

export class ScriptedModelAbortError extends Error {
  readonly code = "CANCELLED";
  readonly retryable = false;

  constructor() {
    super("Scripted model call was aborted");
    this.name = "AbortError";
  }
}

export class ScriptNotExhaustedError extends Error {
  readonly code = "SCRIPT_NOT_EXHAUSTED";

  constructor(readonly remaining: number) {
    super(`Scripted model has ${remaining} remaining item(s)`);
    this.name = "ScriptNotExhaustedError";
  }
}

export class ScriptedModel implements ModelProvider {
  readonly #script: readonly ScriptedModelItem[];
  readonly #requests: ModelRequest[] = [];
  #cursor = 0;

  constructor(
    readonly id: string,
    script: readonly ScriptedModelItem[],
  ) {
    this.#script = Object.freeze(script.map(snapshotScriptItem));
  }

  get requests(): readonly ModelRequest[] {
    return Object.freeze([...this.#requests]);
  }

  async generate(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): Promise<ModelResponse> {
    this.#requests.push(cloneAndFreezePlainData(request));
    if (options.signal.aborted) {
      throw new ScriptedModelAbortError();
    }

    const item = this.#script[this.#cursor];
    if (!item) {
      throw new ScriptExhaustedError();
    }
    this.#cursor += 1;

    if (item.kind === "error") {
      throw item.error;
    }
    return item.response;
  }

  assertExhausted(): void {
    const remaining = this.#script.length - this.#cursor;
    if (remaining !== 0) {
      throw new ScriptNotExhaustedError(remaining);
    }
  }
}
