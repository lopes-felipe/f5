import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { listWorktreeInventory } from "../worktreeInventory.ts";
import { switchWasCancelled, WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import nodePath from "node:path";
import {
  type ThreadId,
  type WorktreesInspectInput,
  type WorktreesInspectResult,
  type WorktreesRemoveInput,
  type WorktreesSwitchWorkspaceInput,
} from "@t3tools/contracts";
import { transitionIsActive } from "../../persistence/Services/WorkspaceTransitions.ts";
import {
  deriveThreadWorkspaceStatus,
  isSetupFailure,
  planRestore,
  readBranchHolder,
} from "../threadWorkspaceStatus.ts";
import { appendWorkspaceNote } from "../workspaceNotes.ts";
import { Effect, FileSystem, Layer, Option } from "effect";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import {
  NextTurnQueueDispatcher,
  WorkspaceRestoreCancelledError,
} from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import {
  captureOptionalClaimServices,
  evaluateWorktreeRemoval,
  inPlaceSwitchBlockers,
  type InPlaceSwitchBlocker,
  readWorktreeClaims,
  removeWorktreeSafely,
  stopDeletedWorktreeClaims,
} from "../worktreeClaims.ts";
import { assertExclusiveProfileCheckout } from "../../profiles/RepositorySharing.ts";
import { WorkspaceRequiresNewWorktreeError } from "../../git/workspaceSwitch.ts";
import { readWorktreeState } from "../worktreeReadiness.ts";
import { isProjectOrManagedPath } from "../workspaceAttachment.ts";
import { WorktreeManager, type WorktreeManagerShape } from "../Services/WorktreeManager.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import { withWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";

export const makeWorktreeManager = Effect.gen(function* () {
  const services = yield* Effect.services<
    | GitCore
    | ServerConfig
    | OrchestrationEngineService
    | NextTurnQueueStore
    | TerminalManager
    | ProviderService
    | WorktreeSetupGate
  >();
  const git = yield* GitCore;
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const queue = yield* NextTurnQueueStore;
  const setup = yield* WorktreeSetupGate;
  const transitions = yield* Effect.serviceOption(WorkspaceTransition);
  const dispatcher = yield* NextTurnQueueDispatcher;
  const fileSystem = yield* FileSystem.FileSystem;
  const withClaimServices = yield* captureOptionalClaimServices();
  const canonical = (path: string) => Effect.tryPromise(() => canonicalWorktreePath(path));
  const projectFor = (id: WorktreesInspectInput["projectId"]) =>
    Effect.gen(function* () {
      const project = (yield* engine.getReadModel()).projects.find(
        (entry) => entry.id === id && entry.deletedAt === null,
      );
      if (!project) return yield* Effect.fail(new Error("Unknown project"));
      return project;
    });
  const context = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null,
      );
      if (!thread) return yield* Effect.fail(new Error("Unknown conversation"));
      return { thread, project: yield* projectFor(thread.projectId) };
    });
  const inspectBranch = (
    project: { workspaceRoot: string },
    path: string,
    branch: string | null,
    headSha: string | null,
    allowTargetCheckout = true,
  ) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      let branchExists = false,
        branchMerged = false,
        branchPushed = false,
        branchUpstreamGone = false;
      let branchBlockedReason: string | null = "No branch is registered.";
      if (branch) {
        branchExists = yield* git.branchExists(project.workspaceRoot, branch);
        const defaultBranch = yield* git.readDefaultBranch(project.workspaceRoot);
        const remotes = yield* git.listRemotes(project.workspaceRoot);
        const primaryRemote =
          remotes.find((remote) => remote.name === "origin")?.name ?? remotes[0]?.name;
        const defaultShas = defaultBranch
          ? [
              yield* git.resolveCommit(project.workspaceRoot, `refs/heads/${defaultBranch}`),
              primaryRemote
                ? yield* git.resolveCommit(
                    project.workspaceRoot,
                    `refs/remotes/${primaryRemote}/${defaultBranch}`,
                  )
                : null,
            ]
          : [];
        for (const sha of defaultShas)
          if (headSha && sha && (yield* git.isAncestor(project.workspaceRoot, headSha, sha)))
            branchMerged = true;
        const remote = yield* git.readConfigValue(project.workspaceRoot, `branch.${branch}.remote`);
        const merge = yield* git.readConfigValue(project.workspaceRoot, `branch.${branch}.merge`);
        const upstream =
          remote && merge
            ? remote === "."
              ? merge
              : `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, "")}`
            : null;
        const upstreamSha = upstream
          ? yield* git.resolveCommit(project.workspaceRoot, upstream)
          : null;
        branchUpstreamGone = upstream !== null && upstreamSha === null;
        branchPushed =
          headSha !== null &&
          upstreamSha !== null &&
          (yield* git.isAncestor(project.workspaceRoot, headSha, upstreamSha));
        const target = yield* canonical(path);
        const checkedOutElsewhere = (yield* git.listWorktrees(project.workspaceRoot)).some(
          (entry) =>
            entry.branch === branch && (!allowTargetCheckout || entry.canonicalPath !== target),
        );
        const common = yield* canonical(yield* git.resolveCommonDir(project.workspaceRoot));
        const repositories = new Map<string, string | null>();
        let linked = false;
        for (const thread of model.threads) {
          if (thread.deletedAt !== null) continue;
          const owner = model.projects.find((entry) => entry.id === thread.projectId);
          const workspace = threadWorkspaceCwd(thread, owner);
          // Unknown references remain fail-closed, but equal branch names in other
          // repositories do not protect this repository's ref.
          if (!workspace || (yield* canonical(workspace)) === target) linked = true;
          if (thread.branch !== branch) continue;
          if (!owner) {
            linked = true;
            continue;
          }
          if (!repositories.has(owner.workspaceRoot))
            repositories.set(
              owner.workspaceRoot,
              yield* git.resolveCommonDir(owner.workspaceRoot).pipe(
                Effect.flatMap(canonical),
                Effect.orElseSucceed(() => null),
              ),
            );
          const ownerCommon = repositories.get(owner.workspaceRoot);
          if (!ownerCommon || ownerCommon === common) linked = true;
        }
        branchBlockedReason = !branchExists
          ? "Branch no longer exists."
          : !defaultBranch
            ? "Default branch is unknown."
            : branch === defaultBranch
              ? "The default branch is protected."
              : checkedOutElsewhere
                ? "Branch is checked out elsewhere."
                : linked
                  ? "A conversation still references this branch or checkout."
                  : !(branchMerged || branchPushed)
                    ? "Branch has commits that are neither merged nor pushed."
                    : null;
      }
      return {
        branchExists,
        branchMerged,
        branchPushed,
        branchUpstreamGone,
        branchDeletable: branchBlockedReason === null,
        branchBlockedReason,
      };
    });
  const inspect = (
    input: WorktreesInspectInput,
    /** How removal will treat ignored files; a plain inspection names none. */
    ignored: Partial<
      Pick<WorktreesRemoveInput, "approvedIgnoredEntries" | "disposableIgnoredOnly">
    > = {},
  ) =>
    Effect.gen(function* () {
      const project = yield* projectFor(input.projectId);
      const gate = yield* evaluateWorktreeRemoval({
        projectCwd: project.workspaceRoot,
        path: input.path,
        policy: {
          kind: "manual",
          ownThreadId: null,
          approvedIgnoredEntries: ignored.approvedIgnoredEntries,
          disposableIgnoredOnly: ignored.disposableIgnoredOnly,
        },
      }).pipe(Effect.provideServices(services));
      const branch = gate.registration?.branch ?? null;
      const headSha = gate.registration?.headSha ?? null;
      const model = yield* engine.getReadModel();
      const linkedThreads = model.threads
        .filter((thread) => gate.linkedThreads.includes(thread.id))
        .map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          archived: thread.archivedAt !== null,
        }));
      const facts = yield* inspectBranch(project, input.path, branch, headSha);
      // A worktree group is several checkouts; removing one always asks.
      const grouped = git.readWorktreeGroup
        ? (yield* git.readWorktreeGroup(input.path)) !== null
        : false;
      // The gate already refuses a dirty tree, a live turn, an open terminal
      // and the rest. What is left to decide is whether a person has anything
      // to look at: another thread that would lose the folder, or ignored
      // files that a build does not bring back.
      const onlyDisposableIgnored =
        gate.ignoredFiles?.canRemoveAfterApproval === true && gate.ignoredFiles.disposableOnly;
      return {
        ...gate,
        safeToRemoveSilently:
          !grouped &&
          linkedThreads.length === 0 &&
          (gate.blockedReasons.length === 0 || onlyDisposableIgnored),
        linkedThreads,
        branch,
        headSha,
        ...facts,
      } satisfies WorktreesInspectResult;
    });
  const remove: WorktreeManagerShape["remove"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projectFor(input.projectId);
      const preview = yield* inspect(input, input);
      if (preview.blockedReasons.length)
        return { removed: false, branchDeleted: false, blockedReasons: preview.blockedReasons };
      yield* stopDeletedWorktreeClaims(preview.deletedThreadClaims).pipe(
        Effect.provideServices(services),
      );
      let branchDeleted = false;
      const branchReasons: string[] = [];
      const layoutRemove = project.scripts.find(
        (script) => script.worktreeLayout === "remove",
      )?.command;
      const checked = yield* removeWorktreeSafely({
        ...(layoutRemove ? { layoutRemove } : {}),
        projectCwd: project.workspaceRoot,
        path: input.path,
        policy: {
          kind: "manual",
          ownThreadId: null,
          approvedIgnoredEntries: input.approvedIgnoredEntries,
          disposableIgnoredOnly: input.disposableIgnoredOnly,
        },
        expectedHead: input.expectedHead,
        afterRemoval: (registration) =>
          Effect.gen(function* () {
            if (!input.deleteBranch || !registration?.branch || !registration.headSha) return;
            const facts = yield* inspectBranch(
              project,
              input.path,
              registration.branch,
              registration.headSha,
              false,
            );
            if (!facts.branchDeletable) {
              branchReasons.push(facts.branchBlockedReason ?? "Branch could not be verified.");
              return;
            }
            branchDeleted = yield* git.deleteBranchIfAt({
              cwd: project.workspaceRoot,
              branch: registration.branch,
              expectedSha: registration.headSha,
            });
            if (!branchDeleted) branchReasons.push("Branch moved; it was retained.");
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                branchReasons.push(`Branch retained: ${error.message}`);
              }),
            ),
          ),
      }).pipe(Effect.provideServices(services));
      return {
        removed: checked.blockedReasons.length === 0,
        branchDeleted,
        blockedReasons: [...checked.blockedReasons, ...branchReasons],
      };
    });
  const threadState: WorktreeManagerShape["threadState"] = (input) =>
    Effect.gen(function* () {
      const { thread, project } = yield* context(input.threadId);
      // Reading the switch settles one nobody is running any more, so the
      // status never reports a switch that has already ended.
      const transition = Option.isSome(transitions)
        ? yield* transitions.value.getTransition(input)
        : null;
      const { state } = yield* queue.listByThread(thread.id);
      return yield* deriveThreadWorkspaceStatus(git, {
        thread,
        project,
        holder: readBranchHolder({
          config,
          project,
          threadId: thread.id,
          threads: (yield* engine.getReadModel()).threads,
        }),
        switching: transition && transitionIsActive(transition) ? transition.intent : null,
        // The queue's own snapshot covers the moment before a restore reserves its switch.
        restoring: false,
        setup: yield* setup.check(thread.id, state.worktreeBlockToken),
        setupToken: state.worktreeBlockToken,
        queue: state,
      });
    });
  const switchAvailability: WorktreeManagerShape["switchAvailability"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projectFor(input.projectId);
      const [target, root] = yield* Effect.all([
        canonical(input.path),
        canonical(project.workspaceRoot),
      ]);
      if (!(yield* isProjectOrManagedPath(config, root, target)))
        return yield* Effect.fail(
          new Error("Only the project folder and this profile's managed worktrees can switch."),
        );
      const usage = yield* withClaimServices(
        readWorktreeClaims(target).pipe(Effect.provideServices(services)),
      );
      const requester = input.threadId ?? null;
      const blockers: InPlaceSwitchBlocker[] = [...inPlaceSwitchBlockers(usage, { requester })];
      // The predicate ignores the requester, whose own session the transition stops
      // first. Its own running turn or queued messages still make the switch refuse.
      if (requester !== null && !usage.unknown) {
        if (usage.activeThreadIds.includes(requester as ThreadId))
          blockers.unshift({ kind: "turn", threadId: requester });
        else if (usage.queuedThreadIds.includes(requester as ThreadId))
          blockers.unshift({ kind: "queued", threadId: requester });
      }
      const otherProfile = yield* Effect.tryPromise(() =>
        assertExclusiveProfileCheckout(config, target),
      ).pipe(
        Effect.as(null),
        Effect.catch((error) =>
          Effect.succeed<InPlaceSwitchBlocker>({
            kind:
              error.cause instanceof WorkspaceRequiresNewWorktreeError ? "otherProfile" : "unknown",
            threadId: null,
          }),
        ),
      );
      if (otherProfile) blockers.push(otherProfile);
      const model = yield* engine.getReadModel();
      return {
        blockers: blockers.map((blocker) => {
          // Only name conversations of the requesting project.
          const thread = blocker.threadId
            ? model.threads.find(
                (entry) => entry.id === blocker.threadId && entry.projectId === input.projectId,
              )
            : undefined;
          return {
            kind: blocker.kind,
            threadId: thread?.id ?? null,
            title: thread?.title ?? null,
          };
        }),
      };
    });
  type Recovering = Effect.Success<ReturnType<typeof context>>;
  /** A worktree group is put back by Git alone: its folders, on the branch it records. */
  const restoreGroup = ({ thread, project }: Recovering, target: string, branch: string) =>
    withWorktreeLifecycleLock(
      target,
      Effect.gen(function* () {
        const latest = yield* queue.listByThread(thread.id);
        if (latest.state.worktreeBlockToken)
          return yield* Effect.fail(new Error("Worktree setup is still running."));
        yield* Effect.tryPromise(() => assertExclusiveProfileCheckout(config, target));
        const claims = yield* withClaimServices(
          readWorktreeClaims(target).pipe(Effect.provideServices(services)),
        );
        if (
          claims.unknown ||
          claims.activeThreadIds.length ||
          claims.setupThreadIds.length ||
          claims.sessions.length ||
          claims.terminals.length ||
          claims.threadIds.some((owner) => owner !== thread.id)
        )
          return yield* Effect.fail(
            new Error("Another thread, an agent session or a terminal is using this worktree."),
          );
        yield* git.ensureWorktree({
          cwd: project.workspaceRoot,
          path: target,
          branch,
          owner: "thread:" + thread.id,
        });
      }),
    );
  /** One switch on behalf of a recovery action; fails with the reason when it does not finish. */
  const switchTo = (
    { thread }: Recovering,
    request: Pick<
      WorktreesSwitchWorkspaceInput,
      "intent" | "targetPath" | "branch" | "sharedFilesystemConfirmed"
    >,
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(transitions))
        return yield* Effect.fail(new Error("Workspace switching is unavailable."));
      const token = (yield* queue.listByThread(thread.id)).state.worktreeBlockToken;
      // A preparation the server no longer runs is taken over rather than waited for.
      const orphanedOwner =
        token &&
        (token.startsWith("recovery:") || token.startsWith("preparation:")) &&
        (yield* setup.check(thread.id, token)) === "orphaned"
          ? token
          : undefined;
      const result = yield* transitions.value.switchWorkspace(
        {
          operationId: crypto.randomUUID(),
          threadId: thread.id,
          expected: {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            sessionUpdatedAt: thread.session?.updatedAt ?? null,
          },
          ...request,
        },
        orphanedOwner,
      );
      // Cancelling is the user's decision: the automatic restore must not try again.
      if (
        switchWasCancelled(result) &&
        (request.intent === "recreate" || request.intent === "recreate_from_base")
      )
        return yield* Effect.fail(new WorkspaceRestoreCancelledError());
      if (result.phase !== "completed")
        return yield* Effect.fail(
          new Error(result.error ?? "The workspace switch did not finish. Try again."),
        );
      if (orphanedOwner)
        yield* queue.setWorktreeBlockToken({
          threadId: thread.id,
          token: null,
          expectedToken: orphanedOwner,
        });
      return result;
    });
  /**
   * Lets the message go that stopped on the missing worktree, or on a setup
   * that failed and that the recovery just dealt with. A setup that still owns
   * the thread keeps its pause: its own card resolves it.
   */
  const resume = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { state } = yield* queue.listByThread(threadId);
      const reason = state.pauseReasonCode;
      if (
        state.paused &&
        (reason === "worktree_missing" ||
          (isSetupFailure(reason) && state.worktreeBlockToken === null))
      )
        yield* queue.setPaused({
          threadId,
          paused: false,
          expectedRevision: state.revision,
        });
      yield* dispatcher.notify(threadId);
    });
  const inspectRecorded = ({ thread, project }: Recovering) =>
    thread.worktreePath === null
      ? Effect.succeed(null)
      : readWorktreeState(git, {
          projectCwd: project.workspaceRoot,
          worktreePath: thread.worktreePath,
          branch: thread.branch,
        });
  /**
   * Brings the thread's worktree back without asking, as `planRestore` decides,
   * and says in the timeline what it did. Resolves to false when only the user
   * can decide (the branch is checked out elsewhere, or nothing can be restored).
   */
  const restore = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const found = yield* context(threadId);
      const { thread } = found;
      const state = yield* inspectRecorded(found);
      const plan = state ? planRestore(state) : ({ kind: "none" } as const);
      if (plan.kind === "branchInUse" || plan.kind === "impossible") return false;
      if (plan.kind === "none" && thread.worktreePath !== null) {
        // The folder is there but its preparation did not finish: a restart cut
        // it short, or it failed and a message is waiting behind that. Run it
        // again; the message goes only if it succeeds.
        const receipt = yield* git.readWorktreePreparation(thread.worktreePath);
        const { state: waiting } = yield* queue.listByThread(thread.id);
        if (
          (receipt !== null &&
            ["allocated", "setup_failed", "setup_indeterminate"].includes(receipt.phase)) ||
          (waiting.paused && isSetupFailure(waiting.pauseReasonCode))
        )
          yield* switchTo(found, { intent: "recreate" });
      } else if (plan.kind === "recreate" && state?.grouped) {
        if (!thread.worktreePath || !thread.branch) return false;
        yield* restoreGroup(found, thread.worktreePath, thread.branch);
        yield* appendWorkspaceNote(engine, thread.id, {
          summary: `Worktree restored on ${thread.branch}`,
        });
      } else if (plan.kind === "recreate") {
        const result = yield* switchTo(found, { intent: "recreate" });
        yield* appendWorkspaceNote(engine, thread.id, {
          summary:
            result.target.path === result.source.path
              ? `Worktree restored on ${result.result?.branch ?? thread.branch}`
              : `Worktree moved to ${nodePath.basename(result.target.path)}`,
        });
      } else if (plan.kind === "fromRemote") {
        // The switch finds the same remote copy and starts the branch from it.
        const result = yield* switchTo(found, { intent: "recreate_from_base" });
        yield* appendWorkspaceNote(engine, thread.id, {
          summary: `Worktree restored on ${result.result?.branch ?? thread.branch} from ${plan.base}`,
        });
      } else if (plan.kind === "fromBase") {
        const result = yield* switchTo(found, { intent: "recreate_from_base" });
        const at = result.target.headSha ? ` at ${result.target.headSha.slice(0, 7)}` : "";
        // The branch's commits are gone, which the user did not ask for.
        yield* appendWorkspaceNote(engine, thread.id, {
          tone: "error",
          summary: thread.branch
            ? `${thread.branch} no longer existed; recreated from ${plan.base}${at}`
            : `Worktree recreated from ${plan.base}${at}`,
        });
      }
      yield* resume(thread.id);
      return true;
    });
  const recover: WorktreeManagerShape["recover"] = (input) =>
    Effect.gen(function* () {
      const found = yield* context(input.threadId);
      const { thread } = found;
      switch (input.action) {
        case "cancel":
          // Settles the switch at once: nothing is left to resolve before the next action.
          if (Option.isSome(transitions)) yield* transitions.value.cancel(thread.id);
          return yield* threadState(input);
        case "restore":
          yield* restore(thread.id);
          return yield* threadState(input);
        case "useProjectFolder":
          yield* switchTo(found, { intent: "use_project_checkout" });
          break;
        case "newWorktree":
          yield* switchTo(found, { intent: "recreate_from_base" });
          break;
        case "attach": {
          const state = yield* inspectRecorded(found);
          const plan = state ? planRestore(state) : null;
          if (plan?.kind !== "branchInUse" || !thread.branch)
            return yield* Effect.fail(
              new Error("No other checkout holds this thread's branch any more. Try again."),
            );
          // Choosing this on the card is the confirmation that the folder is shared.
          yield* switchTo(found, {
            intent: "attach_existing",
            targetPath: plan.at,
            branch: thread.branch,
            sharedFilesystemConfirmed: true,
          });
          break;
        }
      }
      yield* resume(thread.id);
      return yield* threadState(input);
    });
  yield* dispatcher.setWorkspaceRestorer((threadId) =>
    restore(threadId).pipe(
      Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
    ),
  );
  const list: WorktreeManagerShape["list"] = (input) =>
    engine
      .getReadModel()
      .pipe(
        Effect.flatMap((model) => listWorktreeInventory(input, model, git, config, fileSystem)),
      );
  return {
    list,
    inspect,
    remove,
    threadState,
    switchAvailability,
    recover,
  } satisfies WorktreeManagerShape;
});
export const WorktreeManagerLive = Layer.effect(WorktreeManager, makeWorktreeManager);
