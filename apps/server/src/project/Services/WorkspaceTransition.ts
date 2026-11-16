import type {
  WorktreesMoveThreadInput,
  WorktreesMoveThreadResult,
  WorktreesDiscardMovedChangesInput,
  WorktreesDiscardMovedChangesResult,
  ThreadId,
  WorkspaceTransitionSnapshot,
  WorktreesSwitchWorkspaceInput,
  WorktreesResolveTransitionInput,
  WorkspaceTransitionRecoveryPreview,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
export interface WorkspaceTransitionShape {
  readonly moveThread: (
    input: WorktreesMoveThreadInput,
  ) => Effect.Effect<WorktreesMoveThreadResult, Error>;
  readonly discardMovedChanges: (
    input: WorktreesDiscardMovedChangesInput,
  ) => Effect.Effect<WorktreesDiscardMovedChangesResult, Error>;
  readonly switchWorkspace: (
    input: WorktreesSwitchWorkspaceInput,
    setupOwnerToken?: string,
  ) => Effect.Effect<WorkspaceTransitionSnapshot, Error>;
  readonly getTransition: (input: {
    threadId: ThreadId;
  }) => Effect.Effect<WorkspaceTransitionSnapshot | null, Error>;
  readonly previewRecovery: (input: {
    operationId: string;
  }) => Effect.Effect<WorkspaceTransitionRecoveryPreview, Error>;
  readonly resolve: (
    input: WorktreesResolveTransitionInput,
  ) => Effect.Effect<WorkspaceTransitionSnapshot, Error>;
  readonly cancel: (threadId: ThreadId, retainBarrier?: boolean) => Effect.Effect<void, Error>;
}
export class WorkspaceTransition extends ServiceMap.Service<
  WorkspaceTransition,
  WorkspaceTransitionShape
>()("t3/project/Services/WorkspaceTransition") {}
