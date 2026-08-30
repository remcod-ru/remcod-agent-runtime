import type {
  JsonValue,
  RuntimeError,
  RuntimeEvent,
  Session,
  Step,
  StepId,
  Turn,
  TurnId,
} from "@remcod/protocol";

export interface ReducedRuntimeState {
  readonly session: Session | null;
  readonly turns: ReadonlyMap<TurnId, Turn>;
  readonly steps: ReadonlyMap<StepId, Step>;
  readonly modelCalls: number;
  readonly toolCalls: number;
}

export function reduceRuntimeEvents(
  events: readonly RuntimeEvent[],
): ReducedRuntimeState {
  let session: Session | null = null;
  const turns = new Map<TurnId, Turn>();
  const steps = new Map<StepId, Step>();
  const terminalModelOutputs = new Map<TurnId, JsonValue>();
  let modelCalls = 0;
  let toolCalls = 0;

  for (const event of events) {
    switch (event.type) {
      case "session.created":
        session = structuredClone(event.data.session);
        break;
      case "session.status_changed": {
        const currentSession = session as Session | null;
        if (currentSession !== null) {
          session = {
            ...currentSession,
            status: event.data.to,
            updatedAt: event.occurredAt,
            version: currentSession.version + 1,
          };
        }
        break;
      }
      case "turn.created":
        turns.set(event.data.turn.id, structuredClone(event.data.turn));
        break;
      case "turn.status_changed": {
        if (!event.turnId) break;
        const turn = turns.get(event.turnId);
        if (turn) {
          const output = terminalModelOutputs.get(event.turnId);
          turns.set(event.turnId, {
            ...turn,
            status: event.data.to,
            updatedAt: event.occurredAt,
            ...(event.data.to === "completed" && output !== undefined
              ? { output: structuredClone(output) }
              : {}),
          });
        }
        break;
      }
      case "step.started":
        steps.set(event.data.step.id, structuredClone(event.data.step));
        break;
      case "step.completed": {
        const step = steps.get(event.stepId);
        if (step) {
          steps.set(event.stepId, {
            ...step,
            status: "completed",
            completedAt: event.occurredAt,
          });
          if (step.kind === "model" && event.data.output !== undefined) {
            terminalModelOutputs.set(
              step.turnId,
              structuredClone(event.data.output),
            );
          }
        }
        break;
      }
      case "step.failed": {
        const step = steps.get(event.stepId);
        if (step) {
          steps.set(event.stepId, {
            ...step,
            status: "failed",
            completedAt: event.occurredAt,
            error: structuredClone(event.data.error) as RuntimeError,
          });
        }
        break;
      }
      case "step.cancelled": {
        const step = steps.get(event.stepId);
        if (step) {
          steps.set(event.stepId, {
            ...step,
            status: "cancelled",
            completedAt: event.occurredAt,
          });
        }
        break;
      }
      case "model.requested":
        modelCalls += 1;
        break;
      case "tool.requested":
        toolCalls += 1;
        break;
      default:
        break;
    }
    if (session && session.id === event.sessionId) {
      session = { ...session, lastEventCursor: event.cursor };
    }
  }

  return {
    session,
    turns,
    steps,
    modelCalls,
    toolCalls,
  };
}
