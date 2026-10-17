import type {
  WorktreesInspectInput,
  WorktreesInspectResult,
  WorktreesRemoveInput,
  WorktreesRemoveResult,
  WorktreesThreadStateInput,
  WorktreesThreadStateResult,
  WorktreesRecoverInput,
  WorktreesRecoverResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
export interface WorktreeManagerShape {
  readonly inspect: (input: WorktreesInspectInput) => Effect.Effect<WorktreesInspectResult, Error>;
  readonly remove: (input: WorktreesRemoveInput) => Effect.Effect<WorktreesRemoveResult, Error>;
  readonly threadState: (
    input: WorktreesThreadStateInput,
  ) => Effect.Effect<WorktreesThreadStateResult, Error>;
  readonly recover: (input: WorktreesRecoverInput) => Effect.Effect<WorktreesRecoverResult, Error>;
}
export class WorktreeManager extends ServiceMap.Service<WorktreeManager, WorktreeManagerShape>()(
  "t3/project/Services/WorktreeManager",
) {}
