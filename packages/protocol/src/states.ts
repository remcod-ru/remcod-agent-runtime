import { z } from "zod";

export const SessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_input",
  "waiting_event",
  "waiting_schedule",
  "waiting_next_turn",
  "completed",
  "failed",
  "cancelled",
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const TurnStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
]);

export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const StepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type StepStatus = z.infer<typeof StepStatusSchema>;

const sessionTransitions: Readonly<
  Record<SessionStatus, readonly SessionStatus[]>
> = {
  idle: ["running", "cancelled"],
  running: [
    "waiting_input",
    "waiting_event",
    "waiting_schedule",
    "waiting_next_turn",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_input: ["running", "cancelled"],
  waiting_event: ["running", "cancelled"],
  waiting_schedule: ["running", "cancelled"],
  waiting_next_turn: ["running", "completed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const turnTransitions: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = {
  queued: ["running"],
  running: ["waiting_input", "completed", "failed", "cancelled"],
  waiting_input: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const stepTransitions: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ["running"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionSession(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return sessionTransitions[from].includes(to);
}

export function canTransitionTurn(from: TurnStatus, to: TurnStatus): boolean {
  return turnTransitions[from].includes(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return stepTransitions[from].includes(to);
}
