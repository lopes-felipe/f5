import { userFacingCauseMessage } from "../causeMessage.ts";
import { enumerateFiles } from "./diskUsage.ts";
import { removeFileIfSafe } from "./storagePathSafety.ts";
import { storageLstat } from "./diskUsage.ts";
import * as OS from "node:os";
import * as Path from "node:path";

import type {
  OrchestrationProject,
  OrchestrationThread,
  ServerSettings,
  StorageAutomationDryRunResult,
  StorageAutomationTarget,
  ThreadId,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolveWorktreeCleanupRules } from "@t3tools/shared/projectSettings";
import { Cause, Effect, Layer, Option, Schedule, ServiceMap, Stream } from "effect";
import type { Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { GitManager } from "../git/Services/GitManager.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { retainedWorkflowThreadIds } from "../orchestration/workflowArchiveLifecycle.ts";
import {
  pathContains,
  RepositoryBusyError,
  withRepositoryLifecycleLock,
  withWorktreeLifecycleLock,
} from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { readProjectSettings } from "../project/projectSettings.ts";
import {
  evaluateWorktreeRemoval,
  readWorktreeClaims,
  stopDeletedWorktreeClaims,
  removeWorktreeSafely,
} from "../project/worktreeClaims.ts";
import { resolveHeadInDefaultBranch } from "../project/worktreeMerge.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { pruneStorageAutomationAudit, recordStorageAutomationAudit } from "./automationAudit.ts";
import {
  CODEX_MARKETPLACE_LEFTOVER_MIN_AGE_MS,
  type CodexMarketplaceLeftover,
  listCodexMarketplaceLeftovers,
  removeCodexMarketplaceLeftover,
  resolveCodexLaunchHomes,
} from "./codexMarketplaceStaging.ts";
import { DiskSpaceMonitor } from "./DiskSpaceMonitor.ts";
import { compactThreadEvents } from "./eventCompaction.ts";
import { StorageMaintenance } from "./StorageMaintenance.ts";

/**
 * Automatic storage cleanup: removes idle managed worktrees under the rules a
 * project resolves to, provider logs past their retention, and archived
 * threads past `archivedThreadsPurgeAfterDays`. Off by default.
 *
 * Some jobs run even when cleanup is off, because they remove nothing anyone
 * can still open:
 * - Codex marketplace upgrade clones that Codex app-servers F5 spawned left
 *   behind (see `codexMarketplaceStaging.ts`).
 * - Purging threads deleted more than `deletedThreadsPurgeAfterDays` ago.
 * - Provider logs of deleted threads past `terminalThreadLogsAfterDays`.
 *   Archived threads can be unarchived, so their logs go only with cleanup on.
 * - Event compaction (`eventCompaction.ts`) and returning free database pages
 *   to the file system (`databaseSpace.ts`).
 *
 * A worktree is removed only when it lives under this profile's managed
 * worktrees directory, contains no project root, is a linked worktree, has a
 * clean tree (ignored environment files block removal; other ignored paths
 * are recorded in the audit entry), and
 * nothing else claims it: no other thread, queued turn, live terminal or
 * agent session. Every check is repeated under the worktree lifecycle lock
 * right before `git worktree remove` (never `--force`). The branch and the
 * thread's worktree path are kept, so resuming the thread recreates it.
 * The content rules (`unchanged`, `onMerge`) also wait until every thread
 * using the worktree has been idle `minIdleHours`: a new worktree has no
 * commits until the agent makes one, and after a restart an interrupted thread
 * has no session claiming it. Idle age (`afterDays`) also counts from the
 * latest of those threads.
 *
 * With `storageCleanup.inactiveWorktrees`, each pass also runs the Storage
 * settings cleanup of inactive F5 worktrees and missing registrations (see
 * `StorageMaintenance.cleanInactiveWorktreesAutomatically`), which has its own
 * rules: merged or pushed, rebuildable build output deleted, and the
 * project's disposable paths discarded.
 */
export interface StorageCleanupWorkerShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Read-only: every target a rule matches, with the action or exact skip reason. */
  readonly dryRun: Effect.Effect<StorageAutomationDryRunResult>;
  /** One full pass; also what the schedule runs. */
  readonly runOnce: Effect.Effect<ReadonlyArray<StorageAutomationTarget>>;
}

export class StorageCleanupWorker extends ServiceMap.Service<
  StorageCleanupWorker,
  StorageCleanupWorkerShape
>()("t3/storage/StorageCleanupWorker") {}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const STARTUP_DELAY = "30 seconds";
const CLEANUP_INTERVAL = "1 hour";
const EVALUATION_CONCURRENCY = 2;
/** Per-pass time budgets: the database connection is shared with the server. */
const EVENT_COMPACTION_BUDGET_MS = 60_000;
const INCREMENTAL_VACUUM_BUDGET_MS = 15_000;
/** A purge pauses command dispatch while it runs, so a backlog drains over several passes. */
const PURGE_THREADS_PER_PASS = 10;

export { blockingIgnoredEntries } from "../project/worktreeClaims.ts";

/** Keep path previews small and unambiguous even for unusual filesystem names. */
export function summarizeIgnoredCleanupPaths(entries: ReadonlyArray<string>): string {
  const paths: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const label = JSON.stringify(entry);
    const size = Buffer.byteLength(label) + 2;
    if (paths.length === 32 || bytes + size > 4096) break;
    paths.push(label);
    bytes += size;
  }
  const omitted = entries.length - paths.length;
  return `${entries.length} path(s): ${paths.join(", ")}${omitted ? ` (${omitted} more paths)` : ""}`;
}

/** Audit and dry-run label for a path: `~`-relative when under the user's home. */
export function redactHomePath(value: string, home: string = OS.homedir()): string {
  const relative = Path.relative(home, value);
  return relative.length > 0 && !relative.startsWith("..") && !Path.isAbsolute(relative)
    ? Path.join("~", relative)
    : value;
}

/** Archived threads can be unarchived, so their logs go only with cleanup on. */
const terminalLogsLabel = (includeArchived: boolean) =>
  includeArchived ? "deleted and archived thread logs" : "deleted thread logs";

const CODEX_LEFTOVER_MIN_AGE_HOURS = CODEX_MARKETPLACE_LEFTOVER_MIN_AGE_MS / (60 * 60 * 1_000);

export type WorktreeCleanupRuleMatch =
  | { readonly kind: "remove"; readonly reason: string }
  /** A content rule matched, but the thread was active too recently. */
  | { readonly kind: "wait"; readonly reason: string };

/** Which rule makes a worktree eligible, or null when none applies. */
export function matchWorktreeCleanupRule(input: {
  readonly rules: WorktreeCleanupRules;
  readonly deleted: boolean;
  readonly settled?: boolean;
  readonly lastInteractionAt: string;
  readonly nowMs: number;
  readonly headInDefaultBranch: boolean | null;
  readonly pullRequestMerged: boolean | null;
  /** The merged pull request names the worktree's exact HEAD as its head commit. */
  readonly pullRequestHeadIsWorktreeHead?: boolean;
}): WorktreeCleanupRuleMatch | null {
  if (input.deleted && input.rules.onDelete) {
    return { kind: "remove", reason: "the thread was deleted" };
  }
  if (input.deleted) return null;
  if (input.settled && input.rules.onSettle)
    return { kind: "remove", reason: "the thread was settled" };
  // An unreadable timestamp counts as just active: never removes early.
  const parsedIdleMs = input.nowMs - Date.parse(input.lastInteractionAt);
  const idleMs = Number.isFinite(parsedIdleMs) ? parsedIdleMs : 0;
  if (input.rules.afterDays !== null && idleMs >= input.rules.afterDays * DAY_MS) {
    return { kind: "remove", reason: `idle for ${Math.floor(idleMs / DAY_MS)} days` };
  }
  const contentReason =
    input.rules.unchanged && input.headInDefaultBranch === true
      ? "no commits beyond the default branch"
      : // A squash or rebase merge leaves HEAD outside the default branch, so the
        // merged pull request must then name this exact commit.
        input.rules.onMerge &&
          input.pullRequestMerged &&
          (input.headInDefaultBranch === true || input.pullRequestHeadIsWorktreeHead === true)
        ? "the pull request was merged"
        : null;
  if (contentReason === null) return null;
  const hours = input.rules.minIdleHours;
  return idleMs >= hours * HOUR_MS
    ? { kind: "remove", reason: contentReason }
    : {
        kind: "wait",
        reason: `${contentReason}, but a thread using it was active within the last ${hours} ${
          hours === 1 ? "hour" : "hours"
        }`,
      };
}

/** The later of two interaction times; an unreadable one wins, so it never removes early. */
export function newerInteraction(a: string, b: string): string {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return a;
  if (!Number.isFinite(bMs)) return b;
  return aMs >= bMs ? a : b;
}

/** What a removal re-checks under the lock, with the activity read again. */
interface RuleInputs {
  readonly rules: WorktreeCleanupRules;
  readonly headInDefaultBranch: boolean | null;
  readonly pullRequestMerged: boolean | null;
  readonly pullRequestHeadIsWorktreeHead: boolean;
}

type Evaluation =
  | { readonly kind: "ignore" }
  | {
      readonly kind: "target";
      readonly target: StorageAutomationTarget;
      readonly worktreePath: string;
      readonly projectRoot: string;
      readonly headSha: string | null;
      /** Null for targets skipped before any rule ran. */
      readonly ruleInputs: RuleInputs | null;
    };

export const makeStorageCleanupWorker = Effect.gen(function* () {
  const services = yield* Effect.services<
    | OrchestrationEngineService
    | TerminalManager
    | ProviderService
    | NextTurnQueueStore
    | SqlClient.SqlClient
    | GitCore
    | ServerConfig
  >();
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const git = yield* GitCore;
  const gitManager = yield* Effect.serviceOption(GitManager);
  const storageMaintenance = yield* StorageMaintenance;
  const diskSpaceMonitor = yield* Effect.serviceOption(DiskSpaceMonitor);

  const canonical = (value: string) =>
    Effect.tryPromise(() => canonicalWorktreePath(value)).pipe(
      Effect.orElseSucceed(() => null as string | null),
    );
  const exists = (value: string) =>
    Effect.tryPromise(() => storageLstat(value)).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    );
  const isFile = (value: string) =>
    Effect.tryPromise(() => storageLstat(value)).pipe(
      Effect.map((stat) => stat.isFile()),
      Effect.orElseSucceed(() => false),
    );

  const rulesFor = (global: ServerSettings, project: OrchestrationProject) =>
    readProjectSettings(global, project).pipe(
      Effect.map((resolved) => resolveWorktreeCleanupRules(resolved.settings)),
    );

  const skip = (
    base: Omit<StorageAutomationTarget, "action" | "reason">,
    reason: string,
  ): StorageAutomationTarget => ({ ...base, action: "skip", reason });

  /**
   * The latest interaction of every non-deleted thread per canonical worktree
   * path: one idle thread must not evict a worktree another thread just used.
   */
  const activityByWorktree = (threads: ReadonlyArray<OrchestrationThread>) =>
    Effect.gen(function* () {
      const activity = new Map<string, string>();
      for (const thread of threads) {
        if (thread.worktreePath === null || thread.deletedAt !== null) continue;
        const path = yield* canonical(thread.worktreePath);
        if (path === null) continue;
        const previous = activity.get(path);
        activity.set(
          path,
          previous === undefined
            ? thread.lastInteractionAt
            : newerInteraction(previous, thread.lastInteractionAt),
        );
      }
      return activity as ReadonlyMap<string, string>;
    });

  const worktreeLastInteraction = (
    thread: OrchestrationThread,
    worktreePath: string,
    activity: ReadonlyMap<string, string>,
  ) => {
    const shared = activity.get(worktreePath);
    return shared === undefined
      ? thread.lastInteractionAt
      : newerInteraction(thread.lastInteractionAt, shared);
  };

  /** Safety checks shared by the dry run and the re-check under the lock. */
  const safetyBlock = (thread: OrchestrationThread, worktreePath: string) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      const project = model.projects.find((entry) => entry.id === thread.projectId);
      if (!project) return "Unknown project";
      const result = yield* evaluateWorktreeRemoval({
        projectCwd: project.workspaceRoot,
        path: worktreePath,
        policy: { kind: "autoCleanup", ownThreadId: thread.id },
      }).pipe(Effect.provideServices(services));
      return result.blockedReasons.length ? result.blockedReasons.join(", ") : null;
    });

  const evaluate = (input: {
    readonly thread: OrchestrationThread;
    readonly projects: ReadonlyArray<OrchestrationProject>;
    readonly global: ServerSettings;
    readonly worktreesRoot: string;
    readonly nowMs: number;
    readonly activity: ReadonlyMap<string, string>;
  }): Effect.Effect<Evaluation> =>
    Effect.gen(function* () {
      const { thread } = input;
      if (thread.worktreePath === null) return { kind: "ignore" } as const;
      const project = input.projects.find((entry) => entry.id === thread.projectId);
      if (!project) return { kind: "ignore" } as const;
      const worktreePath = yield* canonical(thread.worktreePath);
      if (worktreePath === null || !pathContains(input.worktreesRoot, worktreePath)) {
        return { kind: "ignore" } as const;
      }
      if (worktreePath === input.worktreesRoot) return { kind: "ignore" } as const;
      if (!(yield* exists(worktreePath))) return { kind: "ignore" } as const;
      const rules = yield* rulesFor(input.global, project);
      if (rules === null) return { kind: "ignore" } as const;

      const base = {
        job: "worktree-cleanup" as const,
        target: Path.relative(input.worktreesRoot, worktreePath),
        projectId: project.id,
        threadId: thread.id,
      };
      const projectRoot = project.workspaceRoot;
      for (const other of input.projects) {
        const root = yield* canonical(other.workspaceRoot);
        if (root !== null && pathContains(worktreePath, root)) {
          return {
            kind: "target",
            target: skip(base, "it contains a project root"),
            worktreePath,
            projectRoot,
            headSha: null,
            ruleInputs: null,
          } as const;
        }
      }
      if (!(yield* isFile(Path.join(worktreePath, ".git")))) {
        return {
          kind: "target",
          target: skip(base, "it is not a linked worktree"),
          worktreePath,
          projectRoot,
          headSha: null,
          ruleInputs: null,
        } as const;
      }

      const headSha = yield* git
        .resolveCommit(worktreePath, "HEAD")
        .pipe(Effect.orElseSucceed(() => null));
      let headInDefaultBranch: boolean | null = null;
      let pullRequestMerged: boolean | null = null;
      let pullRequestHeadIsWorktreeHead = false;
      if ((rules.unchanged || rules.onMerge) && headSha !== null && thread.deletedAt === null) {
        headInDefaultBranch = (yield* resolveHeadInDefaultBranch(git, projectRoot, headSha)).merged;
        if (rules.onMerge && headInDefaultBranch !== null && Option.isSome(gitManager)) {
          const pr = yield* gitManager.value.status({ cwd: worktreePath }).pipe(
            Effect.map((status) => status.pr),
            Effect.orElseSucceed(() => undefined),
          );
          if (pr !== undefined) {
            pullRequestMerged = pr?.state === "merged";
            pullRequestHeadIsWorktreeHead = pr?.headOid?.toLowerCase() === headSha.toLowerCase();
          }
        }
      }
      const ruleInputs = {
        rules,
        headInDefaultBranch,
        pullRequestMerged,
        pullRequestHeadIsWorktreeHead,
      };
      const matched = matchWorktreeCleanupRule({
        ...ruleInputs,
        deleted: thread.deletedAt !== null,
        settled: !!thread.settledAt,
        lastInteractionAt: worktreeLastInteraction(thread, worktreePath, input.activity),
        nowMs: input.nowMs,
      });
      if (matched === null) return { kind: "ignore" } as const;
      // A waiting worktree skips the safety checks and their git work; any
      // other blocker shows up once the wait is over.
      if (matched.kind === "wait") {
        return {
          kind: "target",
          target: skip(base, matched.reason),
          worktreePath,
          projectRoot,
          headSha,
          ruleInputs,
        } as const;
      }
      const blocked = yield* safetyBlock(thread, worktreePath);
      return {
        kind: "target",
        target:
          blocked === null
            ? { ...base, action: "remove" as const, reason: matched.reason }
            : skip(base, `${matched.reason}, but ${blocked}`),
        worktreePath,
        projectRoot,
        headSha,
        ruleInputs,
      } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("storage cleanup evaluation failed", {
          threadId: input.thread.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({ kind: "ignore" } as const)),
      ),
    );

  const evaluateAll = Effect.gen(function* () {
    const global = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (global === null || !global.storageCleanup.enabled) {
      return { global, evaluations: [] as Evaluation[] };
    }
    const worktreesRoot = yield* canonical(config.worktreesDir);
    if (worktreesRoot === null || !(yield* exists(worktreesRoot))) {
      return { global, evaluations: [] as Evaluation[] };
    }
    const model = yield* engine.getReadModel();
    const nowMs = Date.now();
    const activity = yield* activityByWorktree(model.threads);
    const evaluations = yield* Effect.forEach(
      model.threads.filter((thread) => thread.worktreePath !== null),
      (thread) =>
        evaluate({ thread, projects: model.projects, global, worktreesRoot, nowMs, activity }),
      { concurrency: EVALUATION_CONCURRENCY },
    );
    return { global, evaluations };
  });

  const providerLogTargets = (days: number | null) =>
    Effect.gen(function* () {
      if (days === null) return [];
      const cutoff = Date.now() - days * DAY_MS;
      const threads = yield* storageMaintenance.listTerminalThreadLogs({
        modifiedBefore: new Date(cutoff).toISOString(),
        includeArchived: true,
      });
      const rotations = yield* Effect.tryPromise(() =>
        enumerateFiles(config.providerLogsDir, { maxDepth: 1 }),
      );
      return [
        ...threads,
        ...rotations.files.filter(
          (file) => /^events\.log\.\d+$/.test(file.name) && file.mtimeMs < cutoff,
        ),
      ];
    });

  const removeWorktree = (
    operationId: string,
    evaluation: Extract<Evaluation, { kind: "target" }>,
  ) =>
    Effect.gen(function* () {
      const thread = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === evaluation.target.threadId,
      );
      if (!thread) return evaluation.target;
      const claims = yield* readWorktreeClaims(evaluation.worktreePath).pipe(
        Effect.provideServices(services),
      );
      yield* stopDeletedWorktreeClaims(claims.deletedThreadIds).pipe(
        Effect.provideServices(services),
      );
      const commonDir = yield* git.resolveCommonDir(evaluation.projectRoot);
      return yield* withWorktreeLifecycleLock(
        evaluation.worktreePath,
        withRepositoryLifecycleLock(
          config.baseDir,
          commonDir,
          Effect.gen(function* () {
            // Re-check everything under the locks: a send, a terminal or a new
            // thread may have claimed the worktree since the evaluation, and
            // any activity restarts the content rules' wait.
            const model = yield* engine.getReadModel();
            const current =
              model.threads.find((entry) => entry.id === evaluation.target.threadId) ?? thread;
            if (evaluation.ruleInputs !== null) {
              const activity = yield* activityByWorktree(model.threads);
              const rematched = matchWorktreeCleanupRule({
                ...evaluation.ruleInputs,
                deleted: current.deletedAt !== null,
                settled: !!current.settledAt,
                lastInteractionAt: worktreeLastInteraction(
                  current,
                  evaluation.worktreePath,
                  activity,
                ),
                nowMs: Date.now(),
              });
              if (rematched?.kind !== "remove") {
                return skip(
                  evaluation.target,
                  rematched?.reason ?? `${evaluation.target.reason}, but no rule applies any more`,
                );
              }
            }
            const blocked = yield* safetyBlock(current, evaluation.worktreePath);
            const head = yield* git
              .resolveCommit(evaluation.worktreePath, "HEAD")
              .pipe(Effect.orElseSucceed(() => null));
            if (blocked !== null || head !== evaluation.headSha) {
              const reason = blocked ?? "HEAD moved since the check";
              yield* recordStorageAutomationAudit({
                operationId,
                job: "worktree-cleanup",
                target: evaluation.target.target,
                projectId: evaluation.target.projectId,
                threadId: evaluation.target.threadId,
                beforeRef: evaluation.headSha,
                result: "skipped",
                reason: `${evaluation.target.reason}, but ${reason}`,
              });
              return skip(evaluation.target, `${evaluation.target.reason}, but ${reason}`);
            }
            const removed = yield* removeWorktreeSafely({
              projectCwd: evaluation.projectRoot,
              path: evaluation.worktreePath,
              policy: { kind: "autoCleanup", ownThreadId: current.id },
            }).pipe(Effect.provideServices(services));
            if (removed.blockedReasons.length)
              return skip(evaluation.target, removed.blockedReasons.join("; "));
            yield* recordStorageAutomationAudit({
              operationId,
              job: "worktree-cleanup",
              target: evaluation.target.target,
              projectId: evaluation.target.projectId,
              threadId: evaluation.target.threadId,
              beforeRef: head,
              afterRef: null,
              result: "removed",
              reason: removed.ignoredEntries.length
                ? `${evaluation.target.reason}; removed ignored paths: ${summarizeIgnoredCleanupPaths(removed.ignoredEntries)}`
                : evaluation.target.reason,
            });
            yield* storageMaintenance.noteStorageMutated;
            return evaluation.target;
          }),
          { mode: "background" },
        ),
      );
    }).pipe(
      Effect.provideServices(services),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        const busy = error instanceof RepositoryBusyError;
        const message = error instanceof Error ? error.message : "removal failed";
        return recordStorageAutomationAudit({
          operationId,
          job: "worktree-cleanup",
          target: evaluation.target.target,
          projectId: evaluation.target.projectId,
          threadId: evaluation.target.threadId,
          beforeRef: evaluation.headSha,
          result: busy ? "skipped" : "failed",
          reason: message,
        }).pipe(
          Effect.provideServices(services),
          Effect.as(skip(evaluation.target, `${evaluation.target.reason}, but ${message}`)),
        );
      }),
    );

  const codexMarketplaceLeftovers = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return [] as ReadonlyArray<CodexMarketplaceLeftover>;
    const homes = resolveCodexLaunchHomes({
      settings,
      profile: config.profile,
      stateDir: config.stateDir,
    });
    return yield* Effect.promise(() => listCodexMarketplaceLeftovers({ homes, nowMs: Date.now() }));
  });

  const codexLeftoverDryRunTargets = (leftovers: ReadonlyArray<CodexMarketplaceLeftover>) => {
    const byHome = new Map<string, number>();
    for (const leftover of leftovers) {
      byHome.set(leftover.home, (byHome.get(leftover.home) ?? 0) + 1);
    }
    return [...byHome].map(
      ([home, count]): StorageAutomationTarget => ({
        job: "codex-marketplace-staging",
        target: redactHomePath(Path.join(home, ".tmp", "marketplaces")),
        projectId: null,
        threadId: null,
        action: "remove",
        reason: `${count} leftover marketplace upgrade dir(s) older than ${CODEX_LEFTOVER_MIN_AGE_HOURS} hours`,
      }),
    );
  };

  const removeCodexMarketplaceLeftovers = (operationId: string) =>
    Effect.gen(function* () {
      const leftovers = yield* codexMarketplaceLeftovers;
      for (const leftover of leftovers) {
        const outcome = yield* Effect.promise(() => removeCodexMarketplaceLeftover(leftover));
        if (outcome.kind === "removed") yield* storageMaintenance.noteStorageMutated;
        yield* recordStorageAutomationAudit(
          {
            operationId,
            job: "codex-marketplace-staging",
            target: redactHomePath(leftover.path),
            result: outcome.warning ? "failed" : "removed",
            reason: outcome.warning
              ? outcome.warning.reason
              : `${leftover.kind === "staging" ? "upgrade clone" : "upgrade backup"} older than ${CODEX_LEFTOVER_MIN_AGE_HOURS} hours; ${outcome.reclaimedBytes} bytes`,
            // A dir that cannot be deleted fails again on every pass.
          },
          { skipIfRepeated: outcome.warning !== undefined },
        ).pipe(Effect.provideServices(services));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("codex marketplace staging cleanup failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const logJobFailure =
    (job: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(`${job} failed`, { cause: Cause.pretty(cause) }),
        ),
      );

  const daysAgoIso = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

  /** Retention cutoffs; archived threads are purged only with cleanup on. */
  const purgeCutoffs = (settings: ServerSettings) => {
    const deletedDays = settings.storageCleanup.deletedThreadsPurgeAfterDays;
    const archivedDays = settings.storageCleanup.enabled
      ? settings.storageCleanup.archivedThreadsPurgeAfterDays
      : null;
    return {
      deletedDays,
      archivedDays,
      deletedBefore: deletedDays === null ? null : daysAgoIso(deletedDays),
      archivedBefore: archivedDays === null ? null : daysAgoIso(archivedDays),
    };
  };

  const purgeThreadDryRunTargets = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const cutoffs = purgeCutoffs(settings);
      const model = yield* engine.getReadModel();
      const retained = retainedWorkflowThreadIds(model);
      const threads = model.threads.filter((thread) => !retained.has(thread.id));
      const deleted = threads.filter(
        (thread) =>
          cutoffs.deletedBefore !== null &&
          thread.deletedAt !== null &&
          thread.deletedAt <= cutoffs.deletedBefore,
      ).length;
      const archived = threads.filter(
        (thread) =>
          cutoffs.archivedBefore !== null &&
          thread.deletedAt === null &&
          thread.archivedAt !== null &&
          thread.archivedAt <= cutoffs.archivedBefore,
      ).length;
      const targets: StorageAutomationTarget[] = [];
      const target = (label: string, reason: string): StorageAutomationTarget => ({
        job: "thread-purge",
        target: label,
        projectId: null,
        threadId: null,
        action: "remove",
        reason,
      });
      if (deleted > 0) {
        targets.push(
          target(
            "deleted threads",
            `${deleted} thread(s) deleted more than ${cutoffs.deletedDays} days ago`,
          ),
        );
      }
      if (archived > 0) {
        targets.push(
          target(
            "archived threads",
            `${archived} thread(s) archived more than ${cutoffs.archivedDays} days ago`,
          ),
        );
      }
      return targets;
    });

  const purgeThreads = (operationId: string, settings: ServerSettings) =>
    Effect.gen(function* () {
      const cutoffs = purgeCutoffs(settings);
      if (cutoffs.deletedBefore === null && cutoffs.archivedBefore === null) return;
      const result = yield* storageMaintenance.purgeThreads({
        operationId,
        deletedBefore: cutoffs.deletedBefore,
        archivedBefore: cutoffs.archivedBefore,
        maxThreads: PURGE_THREADS_PER_PASS,
      });
      const archived = new Set<string>(result.archivedThreadIds);
      for (const threadId of result.purgedThreadIds) {
        yield* recordStorageAutomationAudit({
          operationId,
          job: "thread-purge",
          target: threadId,
          threadId,
          result: "removed",
          reason: archived.has(threadId)
            ? `archived more than ${cutoffs.archivedDays} days ago`
            : `deleted more than ${cutoffs.deletedDays} days ago`,
        });
      }
      for (const warning of result.warnings) {
        yield* recordStorageAutomationAudit(
          {
            operationId,
            job: "thread-purge",
            target: redactHomePath(warning.path),
            result: "skipped",
            reason: warning.reason,
          },
          { skipIfRepeated: true },
        );
      }
    }).pipe(Effect.provideServices(services), logJobFailure("automatic thread purge"));

  const pruneTerminalThreadLogs = (operationId: string, settings: ServerSettings) =>
    Effect.gen(function* () {
      const days = settings.storageCleanup.terminalThreadLogsAfterDays;
      if (days === null) return;
      const includeArchived = settings.storageCleanup.enabled;
      const result = yield* storageMaintenance.pruneTerminalThreadLogs({
        operationId,
        modifiedBefore: daysAgoIso(days),
        includeArchived,
      });
      const removed = result.perTargetReclaimed.length;
      if (removed === 0 && result.warnings.length === 0) return;
      yield* recordStorageAutomationAudit(
        {
          operationId,
          job: "provider-logs",
          target: terminalLogsLabel(includeArchived),
          result: result.warnings.length === 0 ? "removed" : "failed",
          reason: `removed ${removed} file(s) (${result.reclaimedBytes} bytes) not written for ${days} days${
            result.warnings.length > 0 ? `; ${result.warnings.length} could not be removed` : ""
          }`,
        },
        { skipIfRepeated: removed === 0 },
      );
    }).pipe(Effect.provideServices(services), logJobFailure("terminal thread log cleanup"));

  /** Audit label: relative to the managed worktrees directory, else `~`-relative. */
  const worktreeAuditTarget = (path: string) => {
    const relative = Path.relative(config.worktreesDir, path);
    return relative.length > 0 && !relative.startsWith("..") && !Path.isAbsolute(relative)
      ? relative
      : redactHomePath(path);
  };

  /** Opt-in: the Storage settings "inactive F5 worktrees" and "missing entries" cleanup, hourly. */
  const removeInactiveWorktrees = (operationId: string, settings: ServerSettings) =>
    Effect.gen(function* () {
      if (!settings.storageCleanup.enabled || !settings.storageCleanup.inactiveWorktrees) return;
      const results = yield* storageMaintenance.cleanInactiveWorktreesAutomatically({
        operationId,
      });
      if (results === null) return;
      for (const result of results) {
        const pruning = result.categoryId === "staleWorktreeRegistrations";
        for (const target of result.perTargetReclaimed) {
          yield* recordStorageAutomationAudit({
            operationId,
            job: "worktree-cleanup",
            target: worktreeAuditTarget(target.path ?? target.id),
            result: "removed",
            reason: pruning
              ? "the worktree folder was missing; its registration was pruned"
              : `inactive worktree${
                  target.branch === "deleted"
                    ? "; its merged branch was deleted"
                    : target.branch === "kept"
                      ? "; its branch was kept"
                      : ""
                }`,
          });
        }
        for (const warning of result.warnings) {
          yield* recordStorageAutomationAudit(
            {
              operationId,
              job: "worktree-cleanup",
              target: worktreeAuditTarget(warning.path),
              result: "skipped",
              reason: warning.reason,
            },
            { skipIfRepeated: true },
          );
        }
      }
    }).pipe(Effect.provideServices(services), logJobFailure("inactive worktree cleanup"));

  const compactDatabase = (operationId: string) =>
    Effect.gen(function* () {
      const compaction = yield* compactThreadEvents({
        nowMs: Date.now(),
        maxDurationMs: EVENT_COMPACTION_BUDGET_MS,
      });
      if (
        compaction.eventsRemoved > 0 ||
        compaction.receiptsRemoved > 0 ||
        compaction.commandOutputsCompacted > 0 ||
        compaction.messagesCompacted > 0
      ) {
        yield* storageMaintenance.noteStorageMutated;
        yield* recordStorageAutomationAudit({
          operationId,
          job: "event-compaction",
          target: "orchestration events",
          result: "removed",
          reason: `compacted ${compaction.commandOutputsCompacted} command output(s) and ${compaction.messagesCompacted} message(s) in ${compaction.threadsCompacted} thread(s); removed ${compaction.eventsRemoved} event(s) and ${compaction.receiptsRemoved} receipt(s), about ${compaction.bytesRemoved} bytes`,
        });
      }
      if (compaction.threadsFailed > 0 || compaction.groupsSkipped > 0) {
        yield* recordStorageAutomationAudit(
          {
            operationId,
            job: "event-compaction",
            target: "orchestration events",
            result: "failed",
            reason: `${compaction.threadsFailed} thread(s) failed and wait a day; ${compaction.groupsSkipped} group(s) with malformed payloads were left alone`,
          },
          { skipIfRepeated: true },
        );
      }
      const space = yield* storageMaintenance.reclaimDatabaseSpace({
        maxDurationMs: INCREMENTAL_VACUUM_BUDGET_MS,
      });
      if (space.action !== "none") {
        yield* recordStorageAutomationAudit({
          operationId,
          job: "database-vacuum",
          target: "state database",
          result: "removed",
          reason:
            space.action === "converted"
              ? `switched to incremental auto-vacuum; the file shrank by ${space.reclaimedBytes} bytes`
              : `returned ${space.reclaimedBytes} free bytes to the file system`,
        });
      } else if (space.skippedReason !== undefined) {
        yield* recordStorageAutomationAudit(
          {
            operationId,
            job: "database-vacuum",
            target: "state database",
            result: "skipped",
            reason: `switching to incremental auto-vacuum waits: ${space.skippedReason}`,
          },
          { skipIfRepeated: true },
        );
      }
    }).pipe(Effect.provideServices(services), logJobFailure("database compaction"));

  const dryRun: StorageCleanupWorkerShape["dryRun"] = Effect.gen(function* () {
    const { global, evaluations } = yield* evaluateAll;
    const targets: StorageAutomationTarget[] = evaluations.flatMap((evaluation) =>
      evaluation.kind === "target" ? [evaluation.target] : [],
    );
    if (global?.storageCleanup.enabled) {
      const logs = yield* providerLogTargets(global.storageCleanup.providerLogsAfterDays);
      if (logs.length > 0) {
        targets.push({
          job: "provider-logs",
          target: "provider logs",
          projectId: null,
          threadId: null,
          action: "remove",
          reason: `${logs.length} file(s) older than ${global.storageCleanup.providerLogsAfterDays} days`,
        });
      }
    }
    targets.push(...codexLeftoverDryRunTargets(yield* codexMarketplaceLeftovers));
    if (global?.storageCleanup.enabled && global.storageCleanup.inactiveWorktrees) {
      const previews = yield* storageMaintenance.previewInactiveWorktrees.pipe(
        Effect.orElseSucceed(() => []),
      );
      for (const preview of previews)
        targets.push({
          job: "worktree-cleanup",
          target: worktreeAuditTarget(preview.path),
          projectId: null,
          threadId: null,
          action: preview.action,
          reason: preview.reason,
        });
    }
    if (global !== null) {
      targets.push(...(yield* purgeThreadDryRunTargets(global)));
      const days = global.storageCleanup.terminalThreadLogsAfterDays;
      if (days !== null) {
        const includeArchived = global.storageCleanup.enabled;
        const logs = yield* storageMaintenance
          .listTerminalThreadLogs({ modifiedBefore: daysAgoIso(days), includeArchived })
          .pipe(Effect.orElseSucceed(() => []));
        if (logs.length > 0) {
          targets.push({
            job: "provider-logs",
            target: terminalLogsLabel(includeArchived),
            projectId: null,
            threadId: null,
            action: "remove",
            reason: `${logs.length} file(s) not written for ${days} days`,
          });
        }
      }
    }
    return {
      storageCleanupEnabled: global?.storageCleanup.enabled ?? false,
      generatedAt: new Date().toISOString(),
      targets,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Storage automation preview failed", { cause: Cause.pretty(cause) }).pipe(
        Effect.as({
          storageCleanupEnabled: false,
          generatedAt: new Date().toISOString(),
          targets: [
            {
              job: "provider-logs" as const,
              target: "Storage inspection",
              projectId: null,
              threadId: null,
              action: "skip" as const,
              reason: userFacingCauseMessage(cause, "Could not inspect storage.", {
                maxLength: 300,
              }),
            },
          ],
        }),
      ),
    ),
  );

  const runOnce: StorageCleanupWorkerShape["runOnce"] = Effect.gen(function* () {
    const operationId = crypto.randomUUID();
    const { global, evaluations } = yield* evaluateAll;
    const results: StorageAutomationTarget[] = [];
    // Removals run one at a time; a failure is isolated to its target.
    for (const evaluation of evaluations) {
      if (evaluation.kind !== "target") continue;
      results.push(
        evaluation.target.action === "remove"
          ? yield* removeWorktree(operationId, evaluation)
          : evaluation.target,
      );
    }
    if (global !== null) yield* removeInactiveWorktrees(operationId, global);
    if (global?.storageCleanup.enabled) {
      const days = global.storageCleanup.providerLogsAfterDays;
      const logs = yield* providerLogTargets(days);
      const threadLogs =
        days === null
          ? null
          : yield* storageMaintenance.pruneTerminalThreadLogs({
              operationId,
              modifiedBefore: daysAgoIso(days),
              includeArchived: true,
            });
      let removed = threadLogs?.perTargetReclaimed.length ?? 0;
      for (const file of logs.filter((file) => /^events\.log\.\d+$/.test(file.name))) {
        const outcome = yield* Effect.promise(() =>
          removeFileIfSafe({
            path: file.path,
            allowedRoot: config.providerLogsDir,
            expectedIdentity: file.identity,
          }),
        );
        if (outcome.kind === "removed") {
          removed++;
          yield* storageMaintenance.noteStorageMutated;
        }
      }
      if (logs.length > 0) {
        yield* recordStorageAutomationAudit({
          operationId,
          job: "provider-logs",
          target: "provider logs",
          result: removed === logs.length ? "removed" : "failed",
          reason: `removed ${removed} of ${logs.length} file(s) older than ${days} days`,
        }).pipe(Effect.provideServices(services));
      }
    }
    // Runs regardless of `storageCleanup.enabled`: F5-spawned app-servers
    // leave these behind and nothing else ever removes them.
    yield* removeCodexMarketplaceLeftovers(operationId);
    // Also regardless of `enabled`: each removes only data nothing can open,
    // and purges run first so compaction and vacuum see their freed pages.
    if (global !== null) {
      yield* purgeThreads(operationId, global);
      yield* pruneTerminalThreadLogs(operationId, global);
    }
    yield* compactDatabase(operationId);
    yield* pruneStorageAutomationAudit.pipe(Effect.provideServices(services));
    return results;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("storage cleanup pass failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as([] as StorageAutomationTarget[]),
          ),
    ),
    // Space a pass freed, even partway, releases held turns without waiting
    // for the next periodic disk check.
    Effect.ensuring(
      diskSpaceMonitor._tag === "Some" ? diskSpaceMonitor.value.noteStorageChanged : Effect.void,
    ),
  );

  const cleanupFields = (settings: ServerSettings) =>
    JSON.stringify([
      settings.storageCleanup,
      settings.worktreeCleanup,
      Object.entries(settings.projectSettingsOverrides).map(([id, overrides]) => [
        id,
        overrides.worktreeCleanup ?? null,
      ]),
    ]);

  const start: StorageCleanupWorkerShape["start"] = Effect.gen(function* () {
    let pending = false;
    let running = false;
    const trigger: Effect.Effect<void> = Effect.suspend(() => {
      if (running) {
        pending = true;
        return Effect.void;
      }
      running = true;
      return runOnce.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            running = false;
            if (!pending) return Effect.void;
            pending = false;
            return trigger;
          }),
        ),
        Effect.asVoid,
      );
    });
    yield* trigger.pipe(
      Effect.delay(STARTUP_DELAY),
      Effect.andThen(trigger.pipe(Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)))),
      Effect.forkScoped,
    );
    const changes = yield* settingsService.subscribeChanges;
    let last = yield* settingsService.getSettings.pipe(
      Effect.map(cleanupFields),
      Effect.orElseSucceed(() => ""),
    );
    yield* Stream.runForEach(changes, (settings) => {
      const next = cleanupFields(settings);
      if (next === last) return Effect.void;
      last = next;
      return trigger.pipe(Effect.forkScoped, Effect.asVoid);
    }).pipe(Effect.forkScoped);
    yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
      event.type === "thread.deleted" ||
      event.type === "thread.settled" ||
      (event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "settlement.script")
        ? trigger.pipe(Effect.forkScoped, Effect.asVoid)
        : Effect.void,
    ).pipe(Effect.forkScoped({ startImmediately: true }));
  });

  return { start, dryRun, runOnce } satisfies StorageCleanupWorkerShape;
});

export const StorageCleanupWorkerLive = Layer.effect(
  StorageCleanupWorker,
  makeStorageCleanupWorker,
);

export type { ThreadId };
