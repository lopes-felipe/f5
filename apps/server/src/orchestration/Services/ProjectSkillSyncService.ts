import type { WorkerAdmissionError } from "@t3tools/shared/DrainableWorker";
import type { ProjectId } from "@t3tools/contracts";
import type { ProjectSkillScanWarning } from "../projectSkills.ts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProjectSkillSyncServiceShape {
  readonly getWarnings: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ProjectSkillScanWarning>>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void, WorkerAdmissionError>;
}

export class ProjectSkillSyncService extends ServiceMap.Service<
  ProjectSkillSyncService,
  ProjectSkillSyncServiceShape
>()("t3/orchestration/Services/ProjectSkillSyncService") {}
