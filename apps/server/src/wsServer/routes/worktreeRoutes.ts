import { type ThreadId, WS_METHODS } from "@t3tools/contracts";
import { Effect, Struct } from "effect";

import { WorkspaceRequiresNewWorktreeError } from "../../git/workspaceSwitch.ts";
import type { WorkspaceTransitionShape } from "../../project/Services/WorkspaceTransition.ts";
import type { WorktreeManagerShape } from "../../project/Services/WorktreeManager.ts";
import type { WorktreeSetupShape } from "../../project/Services/WorktreeSetup.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { RouteTable } from "./routeTable.ts";

type WorktreeMethod =
  | typeof WS_METHODS.worktreesMoveThread
  | typeof WS_METHODS.worktreesDiscardMovedChanges
  | typeof WS_METHODS.worktreesSwitchWorkspace
  | typeof WS_METHODS.worktreesGetTransition
  | typeof WS_METHODS.worktreesList
  | typeof WS_METHODS.worktreesInspect
  | typeof WS_METHODS.worktreesRemove
  | typeof WS_METHODS.worktreesThreadState
  | typeof WS_METHODS.worktreesSwitchAvailability
  | typeof WS_METHODS.worktreesRecover
  | typeof WS_METHODS.worktreeSetupSubscribe
  | typeof WS_METHODS.worktreeSetupCancel
  | typeof WS_METHODS.worktreeSetupRetry
  | typeof WS_METHODS.worktreeSetupWorkLocally
  | typeof WS_METHODS.worktreeSetupRerunScript;

export interface WorktreeRouteDependencies {
  readonly runtime: Effect.Effect<
    {
      readonly workspaceTransition: WorkspaceTransitionShape;
      readonly worktreeManager: WorktreeManagerShape;
      readonly worktreeSetup: WorktreeSetupShape;
    },
    RouteRequestError
  >;
  readonly publishNextTurnQueueSnapshot: (threadId: ThreadId) => Effect.Effect<void, Error>;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * Managed worktree lifecycle, workspace transitions, and worktree setup
 * subscription/action routes.
 */
export const worktreeRoutes = ({
  runtime,
  publishNextTurnQueueSnapshot,
}: WorktreeRouteDependencies): RouteTable<WorktreeMethod, never, Error> => {
  const handleWorktreeSetupAction = (
    actionKind: "cancel" | "retry" | "workLocally" | "rerunScript",
    body: { readonly threadId: ThreadId; readonly expectedOperationId: string },
  ) =>
    Effect.gen(function* () {
      const { worktreeSetup } = yield* runtime;
      const action = worktreeSetup[actionKind];
      const snapshot = yield* action(body.threadId, body.expectedOperationId).pipe(
        Effect.mapError(
          (error) =>
            new RouteRequestError({
              message: error.message,
              ...(error.code !== undefined ? { code: error.code } : {}),
            }),
        ),
      );
      yield* publishNextTurnQueueSnapshot(body.threadId).pipe(Effect.ignoreCause({ log: true }));
      return {
        snapshot,
        ...(snapshot
          ? { generation: snapshot.generation, sequence: snapshot.sequence }
          : yield* worktreeSetup.ordering(body.threadId)),
      };
    });

  return {
    [WS_METHODS.worktreesMoveThread]: (request) =>
      Effect.gen(function* () {
        const { workspaceTransition } = yield* runtime;
        return yield* workspaceTransition
          .moveThread(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesDiscardMovedChanges]: (request) =>
      Effect.gen(function* () {
        const { workspaceTransition } = yield* runtime;
        return yield* workspaceTransition
          .discardMovedChanges(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesSwitchWorkspace]: (request) =>
      Effect.gen(function* () {
        const { workspaceTransition } = yield* runtime;
        return yield* workspaceTransition.switchWorkspace(withoutTag(request)).pipe(
          Effect.mapError(
            (error) =>
              new RouteRequestError({
                message: error.message,
                ...(error instanceof WorkspaceRequiresNewWorktreeError ? { code: error.code } : {}),
              }),
          ),
        );
      }),

    [WS_METHODS.worktreesGetTransition]: (request) =>
      Effect.gen(function* () {
        const { workspaceTransition } = yield* runtime;
        return yield* workspaceTransition
          .getTransition(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesList]: (request) =>
      Effect.gen(function* () {
        const { worktreeManager } = yield* runtime;
        return yield* worktreeManager
          .list(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesInspect]: (request) =>
      Effect.gen(function* () {
        const { worktreeManager } = yield* runtime;
        return yield* worktreeManager
          .inspect(request)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesRemove]: (request) =>
      Effect.gen(function* () {
        const { worktreeManager } = yield* runtime;
        return yield* worktreeManager
          .remove(request)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesThreadState]: (request) =>
      Effect.gen(function* () {
        const { worktreeManager } = yield* runtime;
        return yield* worktreeManager
          .threadState(request)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesSwitchAvailability]: (request) =>
      Effect.gen(function* () {
        const { worktreeManager } = yield* runtime;
        return yield* worktreeManager
          .switchAvailability(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreesRecover]: (request) =>
      Effect.gen(function* () {
        const { worktreeManager } = yield* runtime;
        return yield* worktreeManager
          .recover(request)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }),

    [WS_METHODS.worktreeSetupSubscribe]: (request) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        const { worktreeSetup } = yield* runtime;
        const snapshot = yield* worktreeSetup.get(body.threadId);
        return {
          snapshot,
          ...(snapshot
            ? { generation: snapshot.generation, sequence: snapshot.sequence }
            : yield* worktreeSetup.ordering(body.threadId)),
        };
      }),

    [WS_METHODS.worktreeSetupCancel]: (request) =>
      handleWorktreeSetupAction("cancel", withoutTag(request)),

    [WS_METHODS.worktreeSetupRetry]: (request) =>
      handleWorktreeSetupAction("retry", withoutTag(request)),

    [WS_METHODS.worktreeSetupWorkLocally]: (request) =>
      handleWorktreeSetupAction("workLocally", withoutTag(request)),

    [WS_METHODS.worktreeSetupRerunScript]: (request) =>
      handleWorktreeSetupAction("rerunScript", withoutTag(request)),
  };
};
