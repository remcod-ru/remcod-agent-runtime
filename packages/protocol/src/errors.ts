import { z } from "zod";

import { JsonValueSchema } from "./json.js";

export const RuntimeErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "INVALID_TRANSITION",
  "VERSION_CONFLICT",
  "CURSOR_CONFLICT",
  "PROVIDER_FAILED",
  "TOOL_FAILED",
  "POLICY_REQUIRED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "STRUCTURED_OUTPUT_INVALID",
  "SCRIPT_EXHAUSTED",
]);

export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>;

export const RuntimeErrorSchema = z
  .object({
    code: RuntimeErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: JsonValueSchema.optional(),
  })
  .strict();

export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;
