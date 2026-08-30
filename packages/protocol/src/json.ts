import { z } from "zod";

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const ProtocolVersionSchema = z.literal("1");
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export const UtcDateTimeSchema = z.iso.datetime({ offset: false });
