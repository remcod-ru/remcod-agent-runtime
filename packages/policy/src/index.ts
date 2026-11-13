import {
  SessionIdSchema,
  StepIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
  type JsonValue,
  type SessionId,
  type StepId,
  type ToolCallId,
  type TurnId,
} from "@remcod/protocol";
import { ToolRiskSchema, type ToolRisk } from "@remcod/tools";
import { z } from "zod";

export { ToolRiskSchema };
export type { ToolRisk };

const digestPattern = /^[a-f0-9]{64}$/;

export const PolicyActionSchema = z
  .object({
    policyVersion: z.literal("1"),
    policyDigest: z.string().regex(digestPattern),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    stepId: StepIdSchema,
    toolCallId: ToolCallIdSchema,
    toolName: z.string().min(1),
    risk: ToolRiskSchema,
    inputDigest: z.string().regex(digestPattern),
  })
  .strict();

export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicyDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("allow") }).strict(),
  z.object({ outcome: z.literal("deny"), reason: z.string().min(1) }).strict(),
  z
    .object({
      outcome: z.literal("require_approval"),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export type PolicyErrorCode =
  | "INVALID_POLICY_CONFIG"
  | "INVALID_ACTION"
  | "INVALID_APPROVAL"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_ALREADY_DECIDED"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_WITHDRAWN"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_ALREADY_CONSUMED"
  | "APPROVAL_MISMATCH"
  | "NON_CANONICAL_JSON";

export class PolicyError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Deterministic JSON serialization: object keys sorted at every depth, no
 * insignificant whitespace, `undefined` impossible because callers pass JSON.
 * Two structurally equal values always produce the same string, which is what
 * an approval digest binds to.
 */
export function canonicalJson(value: JsonValue): string {
  return canonicalize(value);
}

function canonicalize(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new PolicyError(
          "NON_CANONICAL_JSON",
          "Cannot digest a non-finite number",
        );
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

const sha256Constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * SHA-256 over the UTF-8 bytes of `message`, lowercase hex. Implemented here
 * rather than imported so the policy package stays dependency-free and
 * environment-neutral (no Node built-ins in the decision path).
 */
export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = schedule[index - 15] as number;
      const recent = schedule[index - 2] as number;
      const s0 =
        rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const s1 =
        rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      schedule[index] =
        ((schedule[index - 16] as number) +
          s0 +
          (schedule[index - 7] as number) +
          s1) >>>
        0;
    }

    let a = hash[0] as number;
    let b = hash[1] as number;
    let c = hash[2] as number;
    let d = hash[3] as number;
    let e = hash[4] as number;
    let f = hash[5] as number;
    let g = hash[6] as number;
    let h = hash[7] as number;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          s1 +
          choice +
          (sha256Constants[index] as number) +
          (schedule[index] as number)) >>>
        0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    hash[0] = ((hash[0] as number) + a) >>> 0;
    hash[1] = ((hash[1] as number) + b) >>> 0;
    hash[2] = ((hash[2] as number) + c) >>> 0;
    hash[3] = ((hash[3] as number) + d) >>> 0;
    hash[4] = ((hash[4] as number) + e) >>> 0;
    hash[5] = ((hash[5] as number) + f) >>> 0;
    hash[6] = ((hash[6] as number) + g) >>> 0;
    hash[7] = ((hash[7] as number) + h) >>> 0;
  }

  return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

/** SHA-256 of the canonical `{ input, toolName }` pair, lowercase hex. */
export function digestToolAction(action: {
  readonly toolName: string;
  readonly input: JsonValue;
}): string {
  if (action.toolName.length === 0) {
    throw new PolicyError("INVALID_ACTION", "Tool name cannot be empty");
  }
  const canonical = canonicalJson({
    input: action.input,
    toolName: action.toolName,
  });
  return sha256Hex(canonical);
}

export interface PolicyRule {
  readonly name: string;
  readonly toolNames: readonly string[];
  readonly decision: PolicyDecision;
}

export interface PolicyConfig {
  /** Evaluated in order; the first rule matching the tool name wins. */
  readonly rules?: readonly PolicyRule[];
  /** Default for `write`/`privileged` when no rule matches. */
  readonly sideEffectDecision?: "deny" | "require_approval";
}

export interface PolicyEngine {
  readonly policyVersion: "1";
  /** Digest of the exact ruleset; an approval issued under another digest never matches. */
  readonly policyDigest: string;
  evaluate(action: PolicyAction): PolicyDecision;
  readonly rules: readonly PolicyRule[];
}

const defaultSideEffectDecision = "require_approval" as const;

function freezeDecision(decision: PolicyDecision): PolicyDecision {
  return Object.freeze({ ...decision });
}

function validateRules(rules: readonly PolicyRule[]): readonly PolicyRule[] {
  const names = new Set<string>();
  const frozen = rules.map((rule) => {
    if (rule.name.length === 0) {
      throw new PolicyError(
        "INVALID_POLICY_CONFIG",
        "Rule name cannot be empty",
      );
    }
    if (names.has(rule.name)) {
      throw new PolicyError(
        "INVALID_POLICY_CONFIG",
        `Duplicate policy rule: ${rule.name}`,
      );
    }
    names.add(rule.name);
    if (rule.toolNames.length === 0) {
      throw new PolicyError(
        "INVALID_POLICY_CONFIG",
        `Policy rule ${rule.name} must name at least one tool`,
      );
    }
    for (const toolName of rule.toolNames) {
      if (toolName.length === 0) {
        throw new PolicyError(
          "INVALID_POLICY_CONFIG",
          `Policy rule ${rule.name} has an empty tool name`,
        );
      }
    }
    const parsed = PolicyDecisionSchema.safeParse(rule.decision);
    if (!parsed.success) {
      throw new PolicyError(
        "INVALID_POLICY_CONFIG",
        `Policy rule ${rule.name} has an invalid decision`,
      );
    }
    return Object.freeze({
      name: rule.name,
      toolNames: Object.freeze([...rule.toolNames]),
      decision: freezeDecision(parsed.data),
    });
  });
  return Object.freeze(frozen);
}

/**
 * Digest of the exact ruleset. Two engines built from different documents have
 * different digests, so an approval issued under one never authorizes an action
 * evaluated under the other.
 */
function policyDocumentJson(
  rules: readonly PolicyRule[],
  sideEffectDecision: string,
): JsonValue {
  return {
    policyVersion: "1",
    rules: rules.map((rule) => ({
      name: rule.name,
      toolNames: [...rule.toolNames],
      decision: { ...rule.decision },
    })),
    sideEffectDecision,
  } as unknown as JsonValue;
}

/**
 * Builds an immutable policy engine. Evaluation is pure: the same action always
 * yields the same decision, and no decision depends on model output beyond the
 * tool name and risk already declared by the tool definition.
 */
export function createPolicyEngine(config: PolicyConfig = {}): PolicyEngine {
  const rules = validateRules(config.rules ?? []);
  const sideEffectDecision =
    config.sideEffectDecision ?? defaultSideEffectDecision;
  if (
    sideEffectDecision !== "deny" &&
    sideEffectDecision !== "require_approval"
  ) {
    throw new PolicyError(
      "INVALID_POLICY_CONFIG",
      "sideEffectDecision must be deny or require_approval",
    );
  }

  const policyDigest = sha256Hex(
    canonicalJson(policyDocumentJson(rules, sideEffectDecision)),
  );

  const engine: PolicyEngine = {
    policyVersion: "1",
    policyDigest,
    rules,
    evaluate(action: PolicyAction): PolicyDecision {
      const parsed = PolicyActionSchema.safeParse(action);
      if (!parsed.success) {
        throw new PolicyError("INVALID_ACTION", "Policy action is not valid");
      }
      if (parsed.data.policyDigest !== policyDigest) {
        throw new PolicyError(
          "INVALID_ACTION",
          "Policy action was built for a different ruleset",
        );
      }
      for (const rule of rules) {
        if (rule.toolNames.includes(parsed.data.toolName)) return rule.decision;
      }
      if (parsed.data.risk === "read" || parsed.data.risk === "draft") {
        return freezeDecision({ outcome: "allow" });
      }
      return freezeDecision({
        outcome: sideEffectDecision,
        reason: `risk:${parsed.data.risk} requires an explicit approval`,
      });
    },
  };
  return Object.freeze(engine);
}

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "withdrawn",
]);

export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly action: PolicyAction;
  readonly principalId: string;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly status: ApprovalStatus;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly consumedAt: string | null;
  readonly consumedByToolCallId: ToolCallId | null;
}

export interface RequestApprovalInput {
  readonly principalId: string;
  readonly ttlMs?: number;
}

export interface DecideApprovalInput {
  readonly principalId: string;
  readonly approved: boolean;
}

export interface ApprovalLedgerOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  /** Default lifetime of a pending approval; `null` means no expiry. */
  readonly defaultTtlMs?: number | null;
}

export interface ApprovalLedger {
  request(action: PolicyAction, input: RequestApprovalInput): ApprovalRecord;
  decide(approvalId: string, input: DecideApprovalInput): ApprovalRecord;
  /**
   * Withdraw a still-pending request (the asker gave up: aborted, timed out, or
   * the turn ended). A late decision or a later consumption is then refused, so
   * an answer that arrives after the question is gone never authorizes work.
   */
  withdraw(approvalId: string, input: DecideApprovalInput): ApprovalRecord;
  /** One-shot, fail-closed consumption bound to the exact action. */
  consume(action: PolicyAction): ApprovalRecord;
  /** First record for this exact action, or null when none was ever requested. */
  find(action: PolicyAction): ApprovalRecord | null;
  get(approvalId: string): ApprovalRecord | null;
  list(): readonly ApprovalRecord[];
}

const defaultApprovalTtlMs = 15 * 60 * 1000;

function cloneAction(action: PolicyAction): PolicyAction {
  const parsed = PolicyActionSchema.safeParse(action);
  if (!parsed.success) {
    throw new PolicyError("INVALID_ACTION", "Policy action is not valid");
  }
  return Object.freeze(parsed.data);
}

function cloneRecord(record: ApprovalRecord): ApprovalRecord {
  return Object.freeze({
    ...record,
    action: record.action,
  });
}

/**
 * In-memory approval ledger. Only a trusted caller (a server-side principal)
 * issues decisions; the model can never add, widen or reuse one. An approval is
 * bound to the exact session, tool name and canonical input digest.
 */
export function createApprovalLedger(
  options: ApprovalLedgerOptions = {},
): ApprovalLedger {
  const clock = options.clock ?? (() => new Date());
  let sequence = 0;
  const idFactory =
    options.idFactory ?? (() => `apv_${(sequence += 1).toString(36)}`);
  const defaultTtlMs =
    options.defaultTtlMs === undefined
      ? defaultApprovalTtlMs
      : options.defaultTtlMs;
  const records = new Map<string, ApprovalRecord>();

  function now(): Date {
    const value = clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new PolicyError(
        "INVALID_APPROVAL",
        "Clock returned an invalid date",
      );
    }
    return value;
  }

  function require(approvalId: string): ApprovalRecord {
    const record = records.get(approvalId);
    if (!record) {
      throw new PolicyError(
        "APPROVAL_NOT_FOUND",
        `Unknown approval: ${approvalId}`,
      );
    }
    return record;
  }

  function sameAction(left: PolicyAction, right: PolicyAction): boolean {
    return (
      left.policyVersion === right.policyVersion &&
      left.policyDigest === right.policyDigest &&
      left.sessionId === right.sessionId &&
      left.toolName === right.toolName &&
      left.inputDigest === right.inputDigest
    );
  }

  const ledger: ApprovalLedger = {
    request(action, input): ApprovalRecord {
      const bounded = cloneAction(action);
      if (input.principalId.length === 0) {
        throw new PolicyError(
          "INVALID_APPROVAL",
          "Approval requires a trusted principal",
        );
      }
      const requestedAt = now();
      const ttlMs = input.ttlMs === undefined ? defaultTtlMs : input.ttlMs;
      if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
        throw new PolicyError(
          "INVALID_APPROVAL",
          "Approval ttlMs must be a positive finite number or null",
        );
      }
      const approvalId = idFactory();
      if (approvalId.length === 0 || records.has(approvalId)) {
        throw new PolicyError(
          "INVALID_APPROVAL",
          "Approval id factory produced an empty or duplicate id",
        );
      }
      const record: ApprovalRecord = Object.freeze({
        approvalId,
        action: bounded,
        principalId: input.principalId,
        requestedAt: requestedAt.toISOString(),
        expiresAt:
          ttlMs === null
            ? null
            : new Date(requestedAt.getTime() + ttlMs).toISOString(),
        status: "pending",
        decidedAt: null,
        decidedBy: null,
        consumedAt: null,
        consumedByToolCallId: null,
      });
      records.set(approvalId, record);
      return cloneRecord(record);
    },

    decide(approvalId, input): ApprovalRecord {
      const record = require(approvalId);
      if (input.principalId.length === 0) {
        throw new PolicyError(
          "INVALID_APPROVAL",
          "Decision requires a trusted principal",
        );
      }
      if (record.status !== "pending") {
        throw new PolicyError(
          "APPROVAL_ALREADY_DECIDED",
          `Approval ${approvalId} is already ${record.status}`,
        );
      }
      const decidedAt = now();
      if (
        record.expiresAt !== null &&
        decidedAt.getTime() >= Date.parse(record.expiresAt)
      ) {
        throw new PolicyError(
          "APPROVAL_EXPIRED",
          `Approval ${approvalId} expired`,
        );
      }
      const next: ApprovalRecord = Object.freeze({
        ...record,
        status: input.approved ? "approved" : "denied",
        decidedAt: decidedAt.toISOString(),
        decidedBy: input.principalId,
      });
      records.set(approvalId, next);
      return cloneRecord(next);
    },

    withdraw(approvalId, input): ApprovalRecord {
      const record = require(approvalId);
      if (input.principalId.length === 0) {
        throw new PolicyError(
          "INVALID_APPROVAL",
          "Withdrawal requires a trusted principal",
        );
      }
      if (record.status !== "pending") {
        throw new PolicyError(
          "APPROVAL_ALREADY_DECIDED",
          `Approval ${approvalId} is already ${record.status}`,
        );
      }
      const withdrawnAt = now();
      const next: ApprovalRecord = Object.freeze({
        ...record,
        status: "withdrawn",
        decidedAt: withdrawnAt.toISOString(),
        decidedBy: input.principalId,
      });
      records.set(approvalId, next);
      return cloneRecord(next);
    },

    consume(action): ApprovalRecord {
      const wanted = cloneAction(action);
      const matches = [...records.values()].filter((record) =>
        sameAction(record.action, wanted),
      );
      const at = now();
      const usable = matches
        .filter(
          (record) =>
            record.status === "approved" &&
            record.consumedAt === null &&
            (record.expiresAt === null ||
              at.getTime() < Date.parse(record.expiresAt)),
        )
        .sort((left, right) => left.approvalId.localeCompare(right.approvalId));
      if (usable.length === 0) {
        if (matches.some((record) => record.consumedAt !== null)) {
          throw new PolicyError(
            "APPROVAL_ALREADY_CONSUMED",
            "The matching approval was already consumed",
          );
        }
        if (
          matches.some(
            (record) =>
              record.status === "approved" &&
              record.expiresAt !== null &&
              at.getTime() >= Date.parse(record.expiresAt),
          )
        ) {
          throw new PolicyError(
            "APPROVAL_EXPIRED",
            "The matching approval expired",
          );
        }
        if (matches.some((record) => record.status === "pending")) {
          throw new PolicyError(
            "APPROVAL_NOT_APPROVED",
            "The matching approval is still pending",
          );
        }
        if (matches.some((record) => record.status === "withdrawn")) {
          throw new PolicyError(
            "APPROVAL_WITHDRAWN",
            "The matching approval was withdrawn before it was decided",
          );
        }
        if (matches.some((record) => record.status === "denied")) {
          throw new PolicyError(
            "APPROVAL_NOT_APPROVED",
            "The matching approval was denied",
          );
        }
        throw new PolicyError(
          "APPROVAL_MISMATCH",
          "No approval matches this exact action",
        );
      }
      const candidate = usable[0] as ApprovalRecord;
      const next: ApprovalRecord = Object.freeze({
        ...candidate,
        consumedAt: at.toISOString(),
        consumedByToolCallId: wanted.toolCallId,
      });
      records.set(candidate.approvalId, next);
      return cloneRecord(next);
    },

    get(approvalId): ApprovalRecord | null {
      const record = records.get(approvalId);
      return record ? cloneRecord(record) : null;
    },

    find(action): ApprovalRecord | null {
      const wanted = cloneAction(action);
      const match = [...records.values()]
        .filter((record) => sameAction(record.action, wanted))
        .sort((left, right) =>
          left.approvalId.localeCompare(right.approvalId),
        )[0];
      return match ? cloneRecord(match) : null;
    },

    list(): readonly ApprovalRecord[] {
      return Object.freeze(
        [...records.values()]
          .sort((left, right) =>
            left.approvalId.localeCompare(right.approvalId),
          )
          .map((record) => cloneRecord(record)),
      );
    },
  };

  return Object.freeze(ledger);
}
