import {
  defaultContextCompactor,
  type ContextCompactor,
} from "./compaction.js";
import { defaultRuntimeLimits } from "./limits.js";
import { defaultRetryPolicy, type RetryPolicy } from "./retry.js";
import type { RuntimeLimits } from "./agent.js";

export interface RuntimeConfigDefaults {
  readonly compactor: ContextCompactor;
  readonly retry: RetryPolicy;
  readonly defaults: Readonly<RuntimeLimits>;
}

export const defaultRuntimeConfig: Readonly<RuntimeConfigDefaults> =
  Object.freeze({
    compactor: defaultContextCompactor,
    retry: defaultRetryPolicy,
    defaults: defaultRuntimeLimits,
  });
