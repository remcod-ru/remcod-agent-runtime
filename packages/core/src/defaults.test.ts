import { describe, expect, it } from "vitest";

import {
  defaultContextCompactor,
  defaultRetryPolicy,
  defaultRuntimeConfig,
  defaultRuntimeLimits,
} from "./index.js";

describe("defaultRuntimeConfig", () => {
  it("bundles immutable injectable defaults without environment lookup", () => {
    expect(defaultRuntimeConfig).toEqual({
      compactor: defaultContextCompactor,
      retry: defaultRetryPolicy,
      defaults: defaultRuntimeLimits,
    });
    expect(Object.isFrozen(defaultRuntimeConfig)).toBe(true);
  });
});
