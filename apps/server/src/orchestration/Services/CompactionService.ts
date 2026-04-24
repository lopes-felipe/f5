import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface CompactionServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class CompactionService extends ServiceMap.Service<
  CompactionService,
  CompactionServiceShape
>()("t3/orchestration/Services/CompactionService") {}
