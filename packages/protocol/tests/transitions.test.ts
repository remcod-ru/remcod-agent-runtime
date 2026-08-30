import { describe, expect, it } from "vitest";

import {
  SessionStatusSchema,
  StepStatusSchema,
  TurnStatusSchema,
  canTransitionSession,
  canTransitionStep,
  canTransitionTurn,
} from "../src/index.js";

const sessionTransitions = new Set([
  "idle->running",
  "idle->cancelled",
  "running->waiting_input",
  "running->waiting_event",
  "running->waiting_schedule",
  "running->waiting_next_turn",
  "running->completed",
  "running->failed",
  "running->cancelled",
  "waiting_input->running",
  "waiting_input->cancelled",
  "waiting_event->running",
  "waiting_event->cancelled",
  "waiting_schedule->running",
  "waiting_schedule->cancelled",
  "waiting_next_turn->running",
  "waiting_next_turn->completed",
  "waiting_next_turn->cancelled",
]);

const turnTransitions = new Set([
  "queued->running",
  "running->waiting_input",
  "running->completed",
  "running->failed",
  "running->cancelled",
  "waiting_input->running",
  "waiting_input->cancelled",
]);

const stepTransitions = new Set([
  "pending->running",
  "running->completed",
  "running->failed",
  "running->cancelled",
]);

function assertMatrix<State extends string>(
  states: readonly State[],
  legal: ReadonlySet<string>,
  canTransition: (from: State, to: State) => boolean,
) {
  for (const from of states) {
    for (const to of states) {
      expect(canTransition(from, to), `${from}->${to}`).toBe(
        legal.has(`${from}->${to}`),
      );
    }
  }
}

describe("state transition matrices", () => {
  it("accepts every legal edge and rejects every other pair", () => {
    assertMatrix(
      SessionStatusSchema.options,
      sessionTransitions,
      canTransitionSession,
    );
    assertMatrix(TurnStatusSchema.options, turnTransitions, canTransitionTurn);
    assertMatrix(StepStatusSchema.options, stepTransitions, canTransitionStep);
  });
});
