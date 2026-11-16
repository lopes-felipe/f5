import type { WorkerAdmissionError } from "@t3tools/shared/DrainableWorker";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface SessionNotesServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void, WorkerAdmissionError>;
}

export class SessionNotesService extends ServiceMap.Service<
  SessionNotesService,
  SessionNotesServiceShape
>()("t3/orchestration/Services/SessionNotesService") {}
