import type { RuntimeLimits } from "./agent.js";

const runtimeLimitNames = [
  "maxSteps",
  "maxModelCalls",
  "maxToolCalls",
  "maxInputTokens",
  "maxOutputTokens",
] as const satisfies readonly (keyof RuntimeLimits)[];

export const defaultRuntimeLimits: Readonly<RuntimeLimits> = Object.freeze({
  maxSteps: 32,
  maxModelCalls: 16,
  maxToolCalls: 64,
  maxInputTokens: 100_000,
  maxOutputTokens: 16_000,
});

export class InvalidRuntimeLimitError extends TypeError {
  readonly code = "INVALID_RUNTIME_LIMIT";

  constructor(
    readonly limit: keyof RuntimeLimits,
    readonly value: number,
  ) {
    super(`${limit} must be a finite non-negative integer`);
    this.name = "InvalidRuntimeLimitError";
  }
}

export function resolveRuntimeLimits(
  overrides: Partial<RuntimeLimits> = {},
): RuntimeLimits {
  const resolved: RuntimeLimits = { ...defaultRuntimeLimits, ...overrides };
  for (const name of runtimeLimitNames) {
    const value = resolved[name];
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new InvalidRuntimeLimitError(name, value);
    }
  }
  return Object.freeze(resolved);
}
