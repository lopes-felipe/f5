import {
  CommandId,
  type ThreadId,
  WORKSPACE_BRANCH_CHANGED_ACTIVITY_KIND,
} from "@t3tools/contracts";
import { timeOrderedUuid } from "@t3tools/shared/ids";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { Effect } from "effect";
import * as NodePath from "node:path";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { isLegacyPlaceholderBranch } from "@t3tools/shared/branchNaming";
import { canonicalWorktreePath, isPlaceholderBranch } from "../git/worktreePaths.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { pathContains } from "./Layers/WorktreeLifecycleCoordinator.ts";
import { appendWorkspaceNote } from "./workspaceNotes.ts";
import { dispatchVerifiedWorkspace, WorkspaceWriteContext } from "./workspaceTransitionContext.ts";

/**
 * A thread's folder is its identity; the branch it records is only the last
 * branch F5 saw there. These helpers keep that record current, so a checkout
 * the agent (or the user) switched is followed instead of reported as an error.
 *
 * A detached HEAD records nothing: the last attached branch stays, because that
 * is what a removed worktree is recreated from. Temporary branches are skipped
 * too, since F5 renames them itself.
 */
export { WORKSPACE_BRANCH_CHANGED_ACTIVITY_KIND };

export interface ObservedBranchDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">;
  readonly git: Pick<
    GitCoreShape,
    | "inspectCheckoutIdentity"
    | "inspectWorktreeGroup"
    | "prepareObservedWorktreeBranch"
    | "readWorktreeGroup"
  >;
  /**
   * The project's effective Branch prefix, so only F5's own `<prefix>/wip/…`
   * placeholders are skipped. Without it the default `f5` prefix applies.
   */
  readonly readBranchNamePrefix?: (project: ReadModelProject) => Effect.Effect<string>;
}

type ReadModel = Effect.Success<ReturnType<OrchestrationEngineShape["getReadModel"]>>;
type ReadModelThread = ReadModel["threads"][number];
type ReadModelProject = ReadModel["projects"][number];

const turnIsActive = (thread: ReadModelThread) =>
  Boolean(thread.session?.activeTurnId) || thread.latestTurn?.state === "running";

const invariant = (error: { readonly message: string }) =>
  new OrchestrationCommandInvariantError({
    commandType: "thread.meta.update",
    detail: error.message,
  });

const appendBranchNote = (
  engine: ObservedBranchDeps["engine"],
  threadId: ThreadId,
  branch: string,
  previousBranch: string | null,
) =>
  appendWorkspaceNote(engine, threadId, {
    kind: WORKSPACE_BRANCH_CHANGED_ACTIVITY_KIND,
    summary: previousBranch ? `Now on ${branch} (was ${previousBranch})` : `Now on ${branch}`,
    payload: { branch, previousBranch },
  });

/**
 * Records `branch` for one thread whose folder is already known to be on it.
 * Resolves to whether the record changed.
 */
const recordObservedBranch = (
  deps: ObservedBranchDeps,
  thread: ReadModelThread,
  project: ReadModelProject,
  branch: string,
) =>
  Effect.gen(function* () {
    if (thread.branch === branch) return false;
    const prefix = deps.readBranchNamePrefix ? yield* deps.readBranchNamePrefix(project) : "";
    if (isPlaceholderBranch(branch, prefix)) return false;
    const previousBranch = thread.branch;
    const command = {
      type: "thread.meta.update" as const,
      commandId: CommandId.makeUnsafe(`server:workspace-branch:${timeOrderedUuid()}`),
      threadId: thread.id,
      branch,
      expectedBranch: thread.branch,
      expectedWorktreePath: thread.worktreePath,
    };
    const prepare = deps.git.prepareObservedWorktreeBranch;
    // Between turns the checkout is verified again inside the write, and a
    // worktree group's own record and its members' receipts move to the new
    // branch in the same transaction. A single worktree has nothing else to
    // move. A turn that is ending, and the project folder, only re-record the
    // branch.
    if (prepare && thread.worktreePath !== null && !turnIsActive(thread)) {
      const prepared = yield* prepare({
        projectRoot: project.workspaceRoot,
        path: thread.worktreePath,
        threadId: thread.id,
        previousBranch: thread.branch,
        branch,
      });
      // A group that is not on the branch as a whole has nothing to record yet.
      if (prepared === null) return false;
      yield* deps.engine.dispatch({ ...command, worktreePath: thread.worktreePath }).pipe(
        Effect.provideService(WorkspaceWriteContext, {
          expected: {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            sessionUpdatedAt: thread.session?.updatedAt ?? null,
          },
          observation: true,
          verifyObservation: prepared.verifyBranch.pipe(Effect.mapError(invariant)),
          commitObservation: prepared.commit.pipe(Effect.mapError(invariant)),
        }),
      );
    } else {
      yield* dispatchVerifiedWorkspace(deps.engine, deps.git, command, { observation: true });
    }
    yield* appendBranchNote(deps.engine, thread.id, branch, previousBranch);
    return true;
  });

const liveThread = (model: ReadModel, threadId: ThreadId) => {
  const thread = model.threads.find((entry) => entry.id === threadId && entry.deletedAt === null);
  const project = thread
    ? model.projects.find((entry) => entry.id === thread.projectId && entry.deletedAt === null)
    : undefined;
  return thread && project && !isScratchProject(project) ? { thread, project } : null;
};

/**
 * Reads HEAD in the thread's folder (its worktree, or the project folder for a
 * Local thread) and records the branch it is on. Never fails: an unreadable
 * checkout is the readiness check's concern, not this one's.
 */
export const syncObservedBranch = (deps: ObservedBranchDeps, threadId: ThreadId) =>
  Effect.gen(function* () {
    const found = liveThread(yield* deps.engine.getReadModel(), threadId);
    if (!found) return false;
    const cwd = threadWorkspaceCwd(found.thread, found.project);
    if (!cwd) return false;
    const head = (yield* deps.git.inspectCheckoutIdentity(cwd)).branch;
    if (!head) return false;
    return yield* recordObservedBranch(deps, found.thread, found.project, head);
  }).pipe(Effect.catch(() => Effect.succeed(false)));

const pathSegments = (value: string) => NodePath.resolve(value).split(NodePath.sep);

/**
 * The threads whose worktree could be `cwd` or a folder above it, judged by
 * name alone: a worktree's own folder name is one of the segments of any path
 * at or below it, whichever way the folders above it are linked. This keeps a
 * status read from resolving every worktree in the profile on disk.
 */
export const observedCheckoutCandidates = <
  Thread extends Pick<ReadModelThread, "branch" | "deletedAt" | "worktreePath">,
>(
  threads: ReadonlyArray<Thread>,
  paths: ReadonlyArray<string>,
  branch: string,
) => {
  const segments = new Set(paths.flatMap(pathSegments));
  return threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.worktreePath !== null &&
      thread.branch !== branch &&
      segments.has(NodePath.basename(NodePath.resolve(thread.worktreePath))),
  );
};

/**
 * Records `branch` for every thread whose worktree is the checkout at `cwd`.
 * Threads with a running turn are left to the end-of-turn sync, so a rebase
 * that moves HEAD repeatedly is recorded once.
 *
 * A worktree group with a root follows its root, so a member that moves on its
 * own records nothing. A group made of members alone is reached through any of
 * them, and moves once all of them are on the branch.
 *
 * Local threads are not swept here: one project folder can back hundreds of
 * them, so each follows the folder when its own turn starts or ends.
 */
export const syncObservedCheckout = (deps: ObservedBranchDeps, cwd: string, branch: string) =>
  Effect.gen(function* () {
    // Each thread's own project decides which placeholders are skipped.
    if (isLegacyPlaceholderBranch(branch)) return;
    const model = yield* deps.engine.getReadModel();
    if (!model.threads.some((thread) => thread.deletedAt === null && thread.worktreePath !== null))
      return;
    const canonical = yield* Effect.tryPromise(() => canonicalWorktreePath(cwd));
    const candidates = observedCheckoutCandidates(model.threads, [cwd, canonical], branch);
    const targets: ReadModelThread[] = [];
    let memberOwner: ReadModelThread | undefined;
    for (const candidate of candidates) {
      const candidatePath = yield* Effect.tryPromise(() =>
        canonicalWorktreePath(candidate.worktreePath!),
      ).pipe(Effect.orElseSucceed(() => null));
      if (candidatePath === canonical) {
        targets.push(candidate);
        continue;
      }
      if (!candidatePath || !deps.git.readWorktreeGroup || !pathContains(candidatePath, canonical))
        continue;
      const group = yield* deps.git.readWorktreeGroup(candidatePath);
      if (
        group?.threadId === candidate.id &&
        !group.root &&
        group.members.some((member) => member.path === canonical)
      )
        memberOwner = candidate;
    }
    if (targets.length === 0 && memberOwner) targets.push(memberOwner);
    let failure: string | null = null;
    for (const thread of targets) {
      if (turnIsActive(thread)) continue;
      const project = model.projects.find(
        (entry) => entry.id === thread.projectId && entry.deletedAt === null,
      );
      if (!project) continue;
      // One thread's stale context must not stop the others sharing the folder.
      yield* recordObservedBranch(deps, thread, project, branch).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failure = error.message;
          }),
        ),
      );
    }
    // The caller backs off before it reports this branch again.
    if (failure !== null) return yield* Effect.fail(new Error(failure));
  }).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))));
