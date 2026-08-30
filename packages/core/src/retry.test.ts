import { describe, expect, it } from "vitest";

import { defaultRetryPolicy, type RetryPolicy } from "./index.js";

describe("retry contract", () => {
  it("retries only explicitly transient errors with deterministic defaults", () => {
    expectType(defaultRetryPolicy);
    expect(defaultRetryPolicy.maxAttempts).toBe(3);
    expect(defaultRetryPolicy.classify({ retryable: true })).toBe("transient");
    expect(defaultRetryPolicy.classify({ retryable: false })).toBe("permanent");
    expect(defaultRetryPolicy.classify(new Error("unclassified"))).toBe(
      "permanent",
    );
    expect(defaultRetryPolicy.delayMs(1)).toBe(100);
    expect(defaultRetryPolicy.delayMs(2)).toBe(200);
    expect(Object.isFrozen(defaultRetryPolicy)).toBe(true);
  });
});

function expectType(_policy: RetryPolicy): void {}
