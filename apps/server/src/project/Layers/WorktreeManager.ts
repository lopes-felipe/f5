import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { listWorktreeInventory } from "../worktreeInventory.ts";
import { WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import { transitionIsActive } from "../../persistence/Services/WorkspaceTransitions.ts";
import {
  type ThreadId,
  type WorktreesInspectInput,
  type WorktreesInspectResult,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option } from "effect";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
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
  const inspect = (input: WorktreesInspectInput, approvedIgnoredEntries?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const project = yield* projectFor(input.projectId);
      const gate = yield* evaluateWorktreeRemoval({
        projectCwd: project.workspaceRoot,
        path: input.path,
        policy: { kind: "manual", ownThreadId: null, approvedIgnoredEntries },
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
      return {
        ...gate,
        linkedThreads,
        branch,
        headSha,
        ...facts,
      } satisfies WorktreesInspectResult;
    });
  const remove: WorktreeManagerShape["remove"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projectFor(input.projectId);
      const preview = yield* inspect(input, input.approvedIgnoredEntries);
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
      const state =
        thread.worktreePath !== null
          ? yield* readWorktreeState(git, {
              projectCwd: project.workspaceRoot,
              worktreePath: thread.worktreePath,
              branch: thread.branch,
            })
          : {
              worktreePath: null,
              branch: thread.branch,
              directoryExists: yield* fileSystem.exists(project.workspaceRoot),
              registration: "none" as const,
              branchExists: false,
              defaultBranch: null,
            };
      const data = yield* queue.listByThread(thread.id);
      const token = data.state.worktreeBlockToken;
      const receipt =
        token === null && thread.worktreePath
          ? yield* git.readWorktreePreparation(thread.worktreePath)
          : null;
      const preparationInterrupted =
        receipt !== null &&
        ["allocated", "setup_failed", "setup_indeterminate"].includes(receipt.phase);
      const transition = Option.isSome(transitions)
        ? yield* transitions.value.getTransition(input)
        : null;
      // A switch is either running or settled; only setup can be left interrupted.
      const recovery =
        transition && transitionIsActive(transition)
          ? "running"
          : token?.startsWith("recovery:") || token?.startsWith("preparation:")
            ? (yield* setup.check(thread.id, token)) === "gating"
              ? "running"
              : "interrupted"
            : preparationInterrupted
              ? "interrupted"
              : "none";
      return {
        worktreePath: state.worktreePath,
        branch: state.branch,
        directoryExists: state.directoryExists,
        registration: state.registration,
        branchExists: state.branchExists,
        defaultBranch: state.defaultBranch,
        recovery,
      } as const;
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
  const recover: WorktreeManagerShape["recover"] = (input) =>
    Effect.gen(function* () {
      const { thread, project } = yield* context(input.threadId);
      const data = yield* queue.listByThread(thread.id);
      if (data.state.revision !== input.expectedQueueRevision)
        return yield* Effect.fail(new Error("The queue changed. Refresh and try again."));
      if (
        input.action === "recreate" &&
        thread.worktreePath &&
        thread.branch &&
        git.readWorktreeGroup &&
        (yield* git.readWorktreeGroup(thread.worktreePath))
      ) {
        const target = thread.worktreePath;
        const branch = thread.branch;
        yield* withWorktreeLifecycleLock(
          target,
          Effect.gen(function* () {
            const latest = yield* queue.listByThread(thread.id);
            if (
              latest.state.revision !== input.expectedQueueRevision ||
              latest.state.worktreeBlockToken
            )
              return yield* Effect.fail(
                new Error("The queue changed or workspace setup is active."),
              );
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
                new Error("A conversation, session, or terminal is using this workspace."),
              );
            yield* git.ensureWorktree({
              cwd: project.workspaceRoot,
              path: target,
              branch,
              owner: "thread:" + thread.id,
            });
          }),
        );
        return yield* resumeAfterRecovery(thread.id, input);
      }
      if (Option.isNone(transitions))
        return yield* Effect.fail(new Error("Workspace transitions are unavailable."));
      if (input.action === "cancel") {
        // Settles the switch at once: nothing is left to resolve before the next action.
        yield* transitions.value.cancel(thread.id);
        return yield* threadState(input);
      }
      const orphanedOwner =
        data.state.worktreeBlockToken &&
        (data.state.worktreeBlockToken.startsWith("recovery:") ||
          data.state.worktreeBlockToken.startsWith("preparation:")) &&
        (yield* setup.check(thread.id, data.state.worktreeBlockToken)) === "orphaned"
          ? data.state.worktreeBlockToken
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
          intent:
            input.action === "recreateFromBase"
              ? "recreate_from_base"
              : input.action === "useProjectCheckout"
                ? "use_project_checkout"
                : "recreate",
        },
        orphanedOwner,
      );
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
      return yield* resumeAfterRecovery(thread.id, input);
    });
  const resumeAfterRecovery = (threadId: ThreadId, input: { threadId: ThreadId }) =>
    Effect.gen(function* () {
      const latest = yield* queue.listByThread(threadId);
      if (latest.state.paused && latest.state.pauseReasonCode === "worktree_missing")
        yield* queue.setPaused({
          threadId,
          paused: false,
          expectedRevision: latest.state.revision,
        });
      yield* dispatcher.notify(threadId);
      return yield* threadState(input);
    });
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
