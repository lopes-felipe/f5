import { randomUUID } from "node:crypto";

import {
  type GitActionProgressEvent,
  type GitCreateWorktreeResult,
  type GitPrepareWorktreeInput,
  type OrchestrationProject,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import { Effect, Struct } from "effect";
import type { WebSocket } from "ws";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import type { GitManagerShape } from "../../git/Services/GitManager.ts";
import { GitWorkspaceSwitch, type GitWorkspaceSwitchHandler } from "../../git/workspaceSwitch.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import type { WorktreeManagerShape } from "../../project/Services/WorktreeManager.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { RouteTable } from "./routeTable.ts";

type GitMethod =
  | typeof WS_METHODS.gitStatus
  | typeof WS_METHODS.gitPull
  | typeof WS_METHODS.gitRunStackedAction
  | typeof WS_METHODS.gitResolvePullRequest
  | typeof WS_METHODS.gitPreparePullRequestThread
  | typeof WS_METHODS.gitListBranches
  | typeof WS_METHODS.gitCreateWorktree
  | typeof WS_METHODS.gitPrepareWorktree
  | typeof WS_METHODS.gitRemoveWorktree
  | typeof WS_METHODS.gitCreateBranch
  | typeof WS_METHODS.gitCheckout
  | typeof WS_METHODS.gitInit;

export interface GitRouteDependencies {
  readonly git: Pick<
    GitCoreShape,
    "pullCurrentBranch" | "listBranches" | "createBranch" | "initRepo" | "allocateWorktreePath"
  >;
  readonly gitManager: Pick<
    GitManagerShape,
    "status" | "resolvePullRequest" | "preparePullRequestThread" | "runStackedAction"
  >;
  /**
   * Checks out a branch in a thread's workspace as a tracked workspace
   * transition, or directly when no thread is named.
   */
  readonly switchWorkspace: (
    threadId?: ThreadId,
    operationId?: string,
  ) => GitWorkspaceSwitchHandler;
  /** Sends one progress event of a stacked action to the client that asked for it. */
  readonly publishActionProgress: (
    ws: WebSocket,
    event: GitActionProgressEvent,
  ) => Effect.Effect<void>;
  readonly observeStatus?: (cwd: string, branch: string | null) => Effect.Effect<void>;
  /** Creates a worktree with the project's worktree settings applied. */
  readonly createWorktree: GitCoreShape["createWorktree"];
  /** Creates a thread's worktree once per operation and runs the project's setup script. */
  readonly prepareWorktree: (
    input: GitPrepareWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, Error>;
  /**
   * What only exists once the server has started: the projects that are not
   * deleted, and the worktree manager. Fails with the server's starting or
   * startup-failed answer until then.
   */
  readonly runtime: Effect.Effect<
    {
      readonly liveProjects: Effect.Effect<
        ReadonlyArray<Pick<OrchestrationProject, "id" | "workspaceRoot" | "scripts">>
      >;
      readonly worktrees: Pick<WorktreeManagerShape, "inspect" | "remove">;
    },
    RouteRequestError
  >;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * Git on a workspace: status, branches, worktrees and the stacked
 * commit/push/PR action. Git failures are passed on as they are, not as
 * `RouteRequestError`s; `formatRouteFailure` in `wsServer.ts` gives a checkout
 * that local changes block its own answer.
 */
export const gitRoutes = ({
  git,
  gitManager,
  switchWorkspace,
  publishActionProgress,
  observeStatus,
  createWorktree,
  prepareWorktree,
  runtime,
}: GitRouteDependencies): RouteTable<GitMethod, never, Error> => ({
  [WS_METHODS.gitStatus]: (body) =>
    gitManager
      .status(withoutTag(body))
      .pipe(Effect.tap((status) => observeStatus?.(body.cwd, status.branch) ?? Effect.void)),
  [WS_METHODS.gitPull]: (body) => git.pullCurrentBranch(body.cwd),
  [WS_METHODS.gitRunStackedAction]: (request, ws) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const actionId = body.actionId ?? randomUUID();
      const progress = { actionId, cwd: body.cwd, action: body.action };
      yield* publishActionProgress(ws, {
        ...progress,
        kind: "action_started",
        phases: ["branch", "commit", "push", "pr"],
      });
      return yield* gitManager
        .runStackedAction(body, {
          actionId,
          progressReporter: { publish: (event) => publishActionProgress(ws, event) },
        })
        .pipe(
          Effect.provideService(
            GitWorkspaceSwitch,
            switchWorkspace(body.threadId, `git-action:${actionId}`),
          ),
          Effect.tap((result) =>
            publishActionProgress(ws, { ...progress, kind: "action_finished", result }),
          ),
          Effect.tapError((cause) =>
            publishActionProgress(ws, {
              ...progress,
              kind: "action_failed",
              phase: null,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        );
    }),
  [WS_METHODS.gitResolvePullRequest]: (body) => gitManager.resolvePullRequest(withoutTag(body)),
  [WS_METHODS.gitPreparePullRequestThread]: (request) => {
    const body = withoutTag(request);
    return gitManager
      .preparePullRequestThread(body)
      .pipe(Effect.provideService(GitWorkspaceSwitch, switchWorkspace(body.threadId)));
  },
  [WS_METHODS.gitListBranches]: (body) => git.listBranches(withoutTag(body)),
  [WS_METHODS.gitCreateWorktree]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      return yield* createWorktree({
        ...body,
        path:
          body.path ??
          (yield* git.allocateWorktreePath({
            cwd: body.cwd,
            branch: body.newBranch ?? body.branch,
          })),
      });
    }),
  [WS_METHODS.gitPrepareWorktree]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const { liveProjects } = yield* runtime;
      const canonicalProject = yield* Effect.promise(() => canonicalWorktreePath(body.projectCwd));
      // The project's setup script decides the default, and identifies the setup that ran.
      let script: ReturnType<typeof setupProjectScript> = null;
      for (const project of yield* liveProjects) {
        if (
          (yield* Effect.promise(() => canonicalWorktreePath(project.workspaceRoot))) ===
          canonicalProject
        ) {
          script = setupProjectScript(project.scripts);
          break;
        }
      }
      return yield* prepareWorktree({
        ...body,
        runSetupScript: body.runSetupScript ?? script !== null,
        setupIdentity: script?.command ?? null,
      });
    }),
  [WS_METHODS.gitRemoveWorktree]: (body) =>
    Effect.gen(function* () {
      const { liveProjects, worktrees } = yield* runtime;
      const canonical = (path: string) =>
        Effect.tryPromise(() => canonicalWorktreePath(path)).pipe(Effect.orElseSucceed(() => null));
      const cwd = yield* canonical(body.cwd);
      let projectId: OrchestrationProject["id"] | undefined;
      for (const project of yield* liveProjects) {
        if (cwd !== null && (yield* canonical(project.workspaceRoot)) === cwd) {
          projectId = project.id;
          break;
        }
      }
      if (!projectId) return yield* new RouteRequestError({ message: "Unknown project" });
      const asRouteError = (error: Error) => new RouteRequestError({ message: error.message });
      // Removal is refused when the worktree moved on since it was inspected.
      const preview = yield* worktrees
        .inspect({ projectId, path: body.path })
        .pipe(Effect.mapError(asRouteError));
      const result = yield* worktrees
        .remove({ projectId, path: body.path, deleteBranch: false, expectedHead: preview.headSha })
        .pipe(Effect.mapError(asRouteError));
      if (!result.removed)
        return yield* new RouteRequestError({
          message: result.blockedReasons.join("; ") || "Worktree was not removed.",
        });
      return;
    }),
  [WS_METHODS.gitCreateBranch]: (body) => git.createBranch(withoutTag(body)),
  [WS_METHODS.gitCheckout]: (body) =>
    switchWorkspace(
      body.threadId,
      body.operationId,
    )({ cwd: body.cwd, branch: body.branch, create: body.create === true }),
  [WS_METHODS.gitInit]: (body) => git.initRepo(withoutTag(body)),
});
