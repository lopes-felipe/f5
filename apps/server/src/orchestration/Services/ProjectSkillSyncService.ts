import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProjectSkillSyncServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ProjectSkillSyncService extends ServiceMap.Service<
  ProjectSkillSyncService,
  ProjectSkillSyncServiceShape
>()("t3/orchestration/Services/ProjectSkillSyncService") {}
