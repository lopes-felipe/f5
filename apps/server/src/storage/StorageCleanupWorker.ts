import * as FS from "node:fs/promises";
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
import {
  pathContains,
  RepositoryBusyError,
  withRepositoryLifecycleLock,
  withWorktreeLifecycleLock,
} from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { readProjectSettings } from "../project/projectSettings.ts";
import { foreignClaims, readWorktreeClaims } from "../project/worktreeClaims.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { pruneStorageAutomationAudit, recordStorageAutomationAudit } from "./automationAudit.ts";

/**
 * Automatic storage cleanup: removes idle managed worktrees under the rules a
 * project resolves to, and provider logs past their retention. Off by default.
 *
 * A worktree is removed only when it lives under this profile's managed
 * worktrees directory, contains no project root, is a linked worktree, has a
 * clean tree (ignored `node_modules/` excepted; any other ignored file such as
 * `.env` blocks removal, because `git worktree remove` would delete it), and
 * nothing else claims it: no other thread, queued turn, live terminal or
 * agent session. Every check is repeated under the worktree lifecycle lock
 * right before `git worktree remove` (never `--force`). The branch and the
 * thread's worktree path are kept, so resuming the thread recreates it.
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

const DAY_MS = 24 * 60 * 60 * 1_000;
const STARTUP_DELAY = "30 seconds";
const CLEANUP_INTERVAL = "1 hour";
const EVALUATION_CONCURRENCY = 2;

/** `node_modules/` (at any depth) is reproducible; every other ignored entry is not. */
export function blockingIgnoredEntries(entries: ReadonlyArray<string>): ReadonlyArray<string> {
  return entries.filter((entry) => !/(^|\/)node_modules\/?$/.test(entry));
}

/** Which rule makes a worktree eligible, or null when none applies. */
export function matchWorktreeCleanupRule(input: {
  readonly rules: WorktreeCleanupRules;
  readonly deleted: boolean;
  readonly lastInteractionAt: string;
  readonly nowMs: number;
  readonly headInDefaultBranch: boolean | null;
  readonly pullRequestMerged: boolean | null;
}): string | null {
  if (input.deleted && input.rules.onDelete) return "the thread was deleted";
  if (input.deleted) return null;
  if (input.rules.afterDays !== null) {
    const idleMs = input.nowMs - Date.parse(input.lastInteractionAt);
    if (Number.isFinite(idleMs) && idleMs >= input.rules.afterDays * DAY_MS) {
      return `idle for ${Math.floor(idleMs / DAY_MS)} days`;
    }
  }
  if (input.rules.unchanged && input.headInDefaultBranch === true) {
    return "no commits beyond the default branch";
  }
  if (input.rules.onMerge && input.headInDefaultBranch === true && input.pullRequestMerged) {
    return "the pull request was merged";
  }
  return null;
}

type Evaluation =
  | { readonly kind: "ignore" }
  | {
      readonly kind: "target";
      readonly target: StorageAutomationTarget;
      readonly worktreePath: string;
      readonly projectRoot: string;
      readonly headSha: string | null;
    };

export const makeStorageCleanupWorker = Effect.gen(function* () {
  const services = yield* Effect.services<
    | OrchestrationEngineService
    | TerminalManager
    | ProviderService
    | NextTurnQueueStore
    | SqlClient.SqlClient
  >();
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const git = yield* GitCore;
  const gitManager = yield* Effect.serviceOption(GitManager);

  const canonical = (value: string) =>
    Effect.tryPromise(() => canonicalWorktreePath(value)).pipe(
      Effect.orElseSucceed(() => null as string | null),
    );
  const exists = (value: string) =>
    Effect.tryPromise(() => FS.lstat(value)).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    );
  const isFile = (value: string) =>
    Effect.tryPromise(() => FS.lstat(value)).pipe(
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

  /** Safety checks shared by the dry run and the re-check under the lock. */
  const safetyBlock = (thread: OrchestrationThread, worktreePath: string) =>
    Effect.gen(function* () {
      if (thread.deletedAt === null) {
        const session = thread.session;
        if (
          session &&
          (session.activeTurnId !== null ||
            session.status === "starting" ||
            session.status === "running")
        ) {
          return "the thread is working";
        }
      }
      const claims = yield* readWorktreeClaims(worktreePath).pipe(Effect.provideServices(services));
      if (claims.queuedThreadIds.includes(thread.id)) return "the thread has queued turns";
      if (claims.sessions.some((session) => session.threadId === thread.id)) {
        return "an agent session is open in it";
      }
      const foreign = foreignClaims(claims, thread.id);
      if (foreign.length > 0) return foreign.join(", ");
      const status = yield* git.statusDetails(worktreePath).pipe(Effect.option);
      if (Option.isNone(status)) return "git status could not be read";
      if (status.value.hasWorkingTreeChanges) return "it has uncommitted changes";
      // Removing a detached worktree drops its HEAD reflog, which can leave
      // commits that no branch contains unreachable.
      if (status.value.branch === null) return "HEAD is detached";
      const ignored = yield* git.listIgnoredEntries(worktreePath).pipe(Effect.option);
      if (Option.isNone(ignored)) return "ignored files could not be listed";
      if (ignored.value.truncated) return "too many ignored files to check";
      const blocking = blockingIgnoredEntries(ignored.value.entries);
      if (blocking.length > 0) {
        return `ignored files other than node_modules/ (${blocking.slice(0, 3).join(", ")})`;
      }
      return null;
    });

  const evaluate = (input: {
    readonly thread: OrchestrationThread;
    readonly projects: ReadonlyArray<OrchestrationProject>;
    readonly global: ServerSettings;
    readonly worktreesRoot: string;
    readonly nowMs: number;
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
        } as const;
      }

      const headSha = yield* git
        .resolveCommit(worktreePath, "HEAD")
        .pipe(Effect.orElseSucceed(() => null));
      let headInDefaultBranch: boolean | null = null;
      let pullRequestMerged: boolean | null = null;
      if ((rules.unchanged || rules.onMerge) && headSha !== null && thread.deletedAt === null) {
        const defaultBranch = yield* git
          .readDefaultBranch(projectRoot)
          .pipe(Effect.orElseSucceed(() => null));
        if (defaultBranch !== null) {
          const defaultSha =
            (yield* git
              .resolveCommit(projectRoot, `refs/remotes/origin/${defaultBranch}`)
              .pipe(Effect.orElseSucceed(() => null))) ??
            (yield* git
              .resolveCommit(projectRoot, `refs/heads/${defaultBranch}`)
              .pipe(Effect.orElseSucceed(() => null)));
          if (defaultSha !== null) {
            headInDefaultBranch = yield* git
              .isAncestor(projectRoot, headSha, defaultSha)
              .pipe(Effect.orElseSucceed(() => null));
          }
        }
        if (rules.onMerge && headInDefaultBranch === true && Option.isSome(gitManager)) {
          pullRequestMerged = yield* gitManager.value.status({ cwd: worktreePath }).pipe(
            Effect.map((status) => status.pr?.state === "merged"),
            Effect.orElseSucceed(() => null),
          );
        }
      }
      const matched = matchWorktreeCleanupRule({
        rules,
        deleted: thread.deletedAt !== null,
        lastInteractionAt: thread.lastInteractionAt,
        nowMs: input.nowMs,
        headInDefaultBranch,
        pullRequestMerged,
      });
      if (matched === null) return { kind: "ignore" } as const;
      const blocked = yield* safetyBlock(thread, worktreePath);
      return {
        kind: "target",
        target:
          blocked === null
            ? { ...base, action: "remove" as const, reason: matched }
            : skip(base, `${matched}, but ${blocked}`),
        worktreePath,
        projectRoot,
        headSha,
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
    const evaluations = yield* Effect.forEach(
      model.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => evaluate({ thread, projects: model.projects, global, worktreesRoot, nowMs }),
      { concurrency: EVALUATION_CONCURRENCY },
    );
    return { global, evaluations };
  });

  const providerLogTargets = (days: number | null) =>
    Effect.gen(function* () {
      if (days === null) return [] as string[];
      const cutoff = Date.now() - days * DAY_MS;
      const root = config.providerLogsDir;
      // Top-level provider logs only (per-thread `<id>.log` files and
      // `events.log` rotations). The live `events.log` is never removed; a log
      // still being written has a recent mtime and is out of range anyway.
      return yield* Effect.promise(async () => {
        const files: string[] = [];
        const entries = await FS.readdir(root, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile() || entry.name === "events.log") continue;
          const target = Path.join(root, entry.name);
          const stat = await FS.lstat(target).catch(() => null);
          if (stat !== null && stat.isFile() && stat.mtimeMs < cutoff) files.push(target);
        }
        return files;
      });
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
      const commonDir = yield* git.resolveCommonDir(evaluation.projectRoot);
      return yield* withWorktreeLifecycleLock(
        evaluation.worktreePath,
        withRepositoryLifecycleLock(
          config.baseDir,
          commonDir,
          Effect.gen(function* () {
            // Re-check everything under the locks: a send, a terminal or a new
            // thread may have claimed the worktree since the evaluation.
            const blocked = yield* safetyBlock(thread, evaluation.worktreePath);
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
            yield* git.removeWorktree({
              cwd: evaluation.projectRoot,
              path: evaluation.worktreePath,
              force: false,
            });
            yield* recordStorageAutomationAudit({
              operationId,
              job: "worktree-cleanup",
              target: evaluation.target.target,
              projectId: evaluation.target.projectId,
              threadId: evaluation.target.threadId,
              beforeRef: head,
              afterRef: null,
              result: "removed",
              reason: evaluation.target.reason,
            });
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
    return {
      storageCleanupEnabled: global?.storageCleanup.enabled ?? false,
      generatedAt: new Date().toISOString(),
      targets,
    };
  });

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
    if (global?.storageCleanup.enabled) {
      const days = global.storageCleanup.providerLogsAfterDays;
      const logs = yield* providerLogTargets(days);
      let removed = 0;
      for (const file of logs) {
        const ok = yield* Effect.tryPromise(() => FS.rm(file, { force: true })).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (ok) removed++;
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
      event.type === "thread.deleted"
        ? trigger.pipe(Effect.forkScoped, Effect.asVoid)
        : Effect.void,
    ).pipe(Effect.forkScoped);
  });

  return { start, dryRun, runOnce } satisfies StorageCleanupWorkerShape;
});

export const StorageCleanupWorkerLive = Layer.effect(
  StorageCleanupWorker,
  makeStorageCleanupWorker,
);

export type { ThreadId };
