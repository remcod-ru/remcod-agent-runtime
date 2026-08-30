import { z } from "zod";

export type BrandedId<Name extends string> = string & {
  readonly __brand: Name;
};

export type AgentId = BrandedId<"AgentId">;
export type SessionId = BrandedId<"SessionId">;
export type TurnId = BrandedId<"TurnId">;
export type StepId = BrandedId<"StepId">;
export type EventId = BrandedId<"EventId">;
export type ToolCallId = BrandedId<"ToolCallId">;

const identifierSchema = z.string().min(1).regex(/\S/, "ID cannot be blank");

function idSchema<Name extends string>(): z.ZodType<BrandedId<Name>> {
  return identifierSchema as unknown as z.ZodType<BrandedId<Name>>;
}

export const AgentIdSchema = idSchema<"AgentId">();
export const SessionIdSchema = idSchema<"SessionId">();
export const TurnIdSchema = idSchema<"TurnId">();
export const StepIdSchema = idSchema<"StepId">();
export const EventIdSchema = idSchema<"EventId">();
export const ToolCallIdSchema = idSchema<"ToolCallId">();

export function createId<Name extends string>(
  brand: Name,
  value: string = globalThis.crypto.randomUUID(),
): BrandedId<Name> {
  if (!/\S/.test(brand)) {
    throw new TypeError("ID brand cannot be blank");
  }
  return identifierSchema.parse(value) as BrandedId<Name>;
}
