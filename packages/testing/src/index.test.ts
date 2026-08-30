import { describe, expect, it } from "vitest";

import type { ModelRequest, ModelResponse } from "@remcod/model-router";

import { ScriptedModel, ScriptExhaustedError } from "./index.js";

const request: ModelRequest = {
  model: "test-model",
  messages: [],
  tools: [],
  remaining: {
    maxSteps: 4,
    maxModelCalls: 3,
    maxToolCalls: 2,
    maxInputTokens: 100,
    maxOutputTokens: 50,
  },
};

const response: ModelResponse = {
  kind: "message",
  content: { answer: 42 },
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
};

describe("ScriptedModel", () => {
  it("snapshots and freezes scripts and recorded requests without cloning errors", async () => {
    const plannedError = new Error("preserve-error-identity");
    const scriptedResponse: ModelResponse = {
      kind: "message",
      content: { nested: { value: 1 } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const responseItem: { kind: "response"; response: ModelResponse } = {
      kind: "response",
      response: scriptedResponse,
    };
    const errorItem: { kind: "error"; error: unknown } = {
      kind: "error",
      error: plannedError,
    };
    const scripted = new ScriptedModel("immutable", [responseItem, errorItem]);
    const mutableRequest: ModelRequest = {
      model: "original-model",
      messages: [{ role: "user", content: { prompt: "original" } }],
      tools: [],
      remaining: {
        maxSteps: 4,
        maxModelCalls: 3,
        maxToolCalls: 2,
        maxInputTokens: 100,
        maxOutputTokens: 50,
      },
    };

    (scriptedResponse.content as { nested: { value: number } }).nested.value =
      99;
    responseItem.response = response;
    errorItem.error = new Error("replacement-error");

    const generated = await scripted.generate(mutableRequest, {
      signal: new AbortController().signal,
    });
    mutableRequest.model = "mutated-model";
    (mutableRequest.messages[0]?.content as { prompt: string }).prompt =
      "mutated";
    mutableRequest.remaining.maxSteps = 999;

    expect(generated).toEqual({
      kind: "message",
      content: { nested: { value: 1 } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    expect(Object.isFrozen(generated)).toBe(true);
    if (generated.kind !== "message") throw new Error("Expected message");
    expect(Object.isFrozen(generated.content)).toBe(true);
    expect(scripted.requests[0]).toMatchObject({
      model: "original-model",
      messages: [{ content: { prompt: "original" } }],
      remaining: { maxSteps: 4 },
    });
    expect(Object.isFrozen(scripted.requests)).toBe(true);
    expect(Object.isFrozen(scripted.requests[0])).toBe(true);
    expect(Object.isFrozen(scripted.requests[0]?.messages)).toBe(true);

    await expect(
      scripted.generate(request, { signal: new AbortController().signal }),
    ).rejects.toBe(plannedError);
  });

  it("consumes a deterministic response/error script and records requests", async () => {
    const scripted = new ScriptedModel("scripted", [
      { kind: "response", response },
      { kind: "error", error: new Error("planned") },
    ]);
    const signal = new AbortController().signal;

    await expect(scripted.generate(request, { signal })).resolves.toEqual(
      response,
    );
    await expect(scripted.generate(request, { signal })).rejects.toThrow(
      "planned",
    );
    expect(scripted.requests).toEqual([request, request]);
    expect(() => scripted.assertExhausted()).not.toThrow();
  });

  it("does not consume the next item when the signal is already aborted", async () => {
    const scripted = new ScriptedModel("scripted", [
      { kind: "response", response },
    ]);
    const controller = new AbortController();
    controller.abort("stopped");

    await expect(
      scripted.generate(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError", retryable: false });

    await expect(
      scripted.generate(request, { signal: new AbortController().signal }),
    ).resolves.toEqual(response);
    expect(scripted.requests).toHaveLength(2);
  });

  it("fails with a non-retryable typed error when the script is exhausted", async () => {
    const scripted = new ScriptedModel("scripted", []);

    await expect(
      scripted.generate(request, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ScriptExhaustedError);
    await expect(
      scripted.generate(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "SCRIPT_EXHAUSTED",
      retryable: false,
    });
  });
});
