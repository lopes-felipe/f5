import { existsSync } from "node:fs";

import {
  BOOTSTRAP_THREAD_DELETED_ERROR_CODE,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
  CommandId,
  EventId,
  F5_PROJECT_FILE_NAME,
  LEGACY_T3_PROJECT_FILE_NAME,
  CHECKED_IN_PROJECT_FILE_MAX_BYTES,
  type ProjectId,
  type QueueReasonCode,
  type ThreadId,
  type ThreadTurnStartCommand,
  type TurnSubmissionResult,
  WORKTREE_SETUP_ACTIVITY_KIND,
  WORKTREE_SETUP_DETAIL_MAX_LENGTH,
  WORKTREE_SETUP_ERROR_MAX_LENGTH,
  WORKTREE_SETUP_STAGE_ORDER,
  WORKTREE_SETUP_TAIL_LINES,
  type WorktreeSetupSnapshot,
  WorktreeSetupSnapshot as WorktreeSetupSnapshotSchema,
  type WorktreeSetupStage,
  type WorktreeSetupStageId,
  type WorktreeSetupStageStatus,
  type WorktreeSetupUpdatedPayload,
  type WorktreeSubmodules,
  worktreeSetupActivityId,
} from "@t3tools/contracts";
import { parseCheckedInProjectFile } from "@t3tools/shared/checkedInProjectFile";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/worktree";
import { Cause, Effect, Fiber, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { resolveDefaultWorktreePath } from "../../git/worktreePaths.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { isDefinitelyUncommittedDispatchError } from "../../wsServer/bootstrapTurnStart.ts";
import { startOwnedSetupScript, type OwnedSetupScript } from "../ownedSetupScript.ts";
import { foreignClaims, readWorktreeClaims } from "../worktreeClaims.ts";
import {
  WorktreeSetup,
  WorktreeSetupError,
  type WorktreeSetupShape,
} from "../Services/WorktreeSetup.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import { withWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";

/** Live pushes coalesce to this interval; the durable activity to the persist interval. */
const PUSH_INTERVAL_MS = 100;
const PERSIST_INTERVAL_MS = 500;
const TURN_ACCEPT_POLL_MS = 250;

const SETUP_INTERRUPTED_BY_RESTART =
  "Worktree setup was interrupted by a server restart. Nothing was removed.";
const CANCELLED_KEPT_DETAIL = "Setup cancelled; worktree kept because it may contain changes.";

interface Tracked {
  snapshot: WorktreeSetupSnapshot;
  fiber: Fiber.Fiber<void, never> | null;
  script: OwnedSetupScript | null;
  scriptExit: Fiber.Fiber<void, never> | null;
  lastPushAt: number;
  pushTimer: ReturnType<typeof setTimeout> | null;
  lastPersistAt: number;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

const nowIso = () => new Date().toISOString();
const serverCommandId = (tag: string) =>
  CommandId.makeUnsafe(`server:worktree-setup:${tag}:${crypto.randomUUID()}`);

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function emptyStage(id: WorktreeSetupStageId): WorktreeSetupStage {
  return {
    id,
    status: "pending",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
  };
}

function withStage(
  snapshot: WorktreeSetupSnapshot,
  id: WorktreeSetupStageId,
  patch: (stage: WorktreeSetupStage) => WorktreeSetupStage,
): WorktreeSetupSnapshot {
  return {
    ...snapshot,
    stages: snapshot.stages.map((stage) => (stage.id === id ? patch(stage) : stage)),
  };
}

function stageStatus(
  snapshot: WorktreeSetupSnapshot,
  id: WorktreeSetupStageId,
  status: WorktreeSetupStageStatus,
  detail?: string | null,
): WorktreeSetupSnapshot {
  const at = nowIso();
  return withStage(snapshot, id, (stage) => ({
    ...stage,
    status,
    startedAt: stage.startedAt ?? (status === "pending" ? null : at),
    endedAt: status === "running" || status === "pending" ? null : (stage.endedAt ?? at),
    ...(detail === undefined
      ? {}
      : { detail: detail === null ? null : clamp(detail, WORKTREE_SETUP_DETAIL_MAX_LENGTH) }),
  }));
}

function settle(
  snapshot: WorktreeSetupSnapshot,
  phase: WorktreeSetupSnapshot["phase"],
  error: string | null,
): WorktreeSetupSnapshot {
  const at = nowIso();
  return {
    ...snapshot,
    phase,
    endedAt: at,
    error: error === null ? null : clamp(error, WORKTREE_SETUP_ERROR_MAX_LENGTH),
    stages: snapshot.stages.map((stage) =>
      stage.status === "running"
        ? {
            ...stage,
            status: phase === "done" ? "done" : phase === "failed" ? "failed" : "skipped",
            endedAt: at,
          }
        : stage,
    ),
  };
}

function activitySummary(snapshot: WorktreeSetupSnapshot): string {
  switch (snapshot.phase) {
    case "running":
      return "Setting up worktree";
    case "done":
      return "Worktree ready";
    case "failed":
      return "Worktree setup failed";
    case "cancelled":
      return "Worktree setup cancelled";
    case "cancelled_kept":
      return "Worktree setup cancelled; worktree kept";
  }
}

const decodeSnapshotJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(WorktreeSetupSnapshotSchema),
);

export const makeWorktreeSetup = Effect.gen(function* () {
  const services = yield* Effect.services<
    | OrchestrationEngineService
    | NextTurnQueueStore
    | NextTurnQueueDispatcher
    | GitCore
    | ServerConfig
    | ServerSettingsService
    | WorktreeSetupGate
    | OrchestrationCommandReceiptRepository
    | TerminalManager
    | ProviderService
    | SqlClient.SqlClient
  >();
  const engine = yield* OrchestrationEngineService;
  const store = yield* NextTurnQueueStore;
  const dispatcher = yield* NextTurnQueueDispatcher;
  const git = yield* GitCore;
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const gate = yield* WorktreeSetupGate;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<WorktreeSetupUpdatedPayload>();
  const runFork = Effect.runForkWith(services);

  const tracked = new Map<ThreadId, Tracked>();
  const persistLocks = new Map<ThreadId, Semaphore.Semaphore>();

  const persistLock = (threadId: ThreadId) => {
    const existing = persistLocks.get(threadId);
    if (existing) return existing;
    const created = Semaphore.makeUnsafe(1);
    persistLocks.set(threadId, created);
    return created;
  };

  /** Writes the current snapshot as the thread's worktree-setup activity. */
  const persistNow = (threadId: ThreadId): Effect.Effect<void> =>
    persistLock(threadId).withPermits(1)(
      Effect.gen(function* () {
        const entry = tracked.get(threadId);
        if (!entry) return;
        const snapshot = entry.snapshot;
        entry.lastPersistAt = Date.now();
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("activity"),
          threadId,
          activity: {
            id: EventId.makeUnsafe(worktreeSetupActivityId(threadId)),
            tone:
              snapshot.phase === "failed" ||
              snapshot.stages.some((stage) => stage.status === "failed")
                ? "error"
                : "info",
            kind: WORKTREE_SETUP_ACTIVITY_KIND,
            summary: activitySummary(snapshot),
            payload: snapshot,
            turnId: null,
            createdAt: snapshot.startedAt,
          },
          createdAt: snapshot.endedAt ?? nowIso(),
        });
      }).pipe(
        // The thread may already be gone after a discard; the record is best effort.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logDebug("worktree setup activity write skipped", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );

  const pushNow = (threadId: ThreadId) => {
    const entry = tracked.get(threadId);
    if (!entry) return;
    entry.lastPushAt = Date.now();
    PubSub.publishUnsafe(changes, { threadId, snapshot: entry.snapshot });
  };

  const schedule = (threadId: ThreadId, final: boolean) => {
    const entry = tracked.get(threadId);
    if (!entry) return;
    const now = Date.now();
    if (final || now - entry.lastPushAt >= PUSH_INTERVAL_MS) {
      if (entry.pushTimer) clearTimeout(entry.pushTimer);
      entry.pushTimer = null;
      pushNow(threadId);
    } else if (!entry.pushTimer) {
      entry.pushTimer = setTimeout(
        () => {
          const current = tracked.get(threadId);
          if (current) current.pushTimer = null;
          pushNow(threadId);
        },
        PUSH_INTERVAL_MS - (now - entry.lastPushAt),
      );
    }
    if (final) {
      if (entry.persistTimer) clearTimeout(entry.persistTimer);
      entry.persistTimer = null;
      return;
    }
    if (now - entry.lastPersistAt >= PERSIST_INTERVAL_MS) {
      runFork(persistNow(threadId));
    } else if (!entry.persistTimer) {
      entry.persistTimer = setTimeout(
        () => {
          const current = tracked.get(threadId);
          if (current) current.persistTimer = null;
          runFork(persistNow(threadId));
        },
        PERSIST_INTERVAL_MS - (now - entry.lastPersistAt),
      );
    }
  };

  /** Synchronous so git's progress callbacks can call it directly. */
  const update = (
    threadId: ThreadId,
    mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
  ) => {
    const entry = tracked.get(threadId);
    if (!entry) return;
    const next = mutate(entry.snapshot);
    entry.snapshot = { ...next, sequence: entry.snapshot.sequence + 1 };
    schedule(threadId, false);
  };

  /** Applies a final change, then pushes and persists it before returning. */
  const commit = (
    threadId: ThreadId,
    mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
  ) =>
    Effect.gen(function* () {
      const entry = tracked.get(threadId);
      if (!entry) return null;
      entry.snapshot = { ...mutate(entry.snapshot), sequence: entry.snapshot.sequence + 1 };
      schedule(threadId, true);
      yield* persistNow(threadId);
      return entry.snapshot;
    });

  const track = (snapshot: WorktreeSetupSnapshot): Tracked => {
    const previous = tracked.get(snapshot.threadId);
    if (previous?.pushTimer) clearTimeout(previous.pushTimer);
    if (previous?.persistTimer) clearTimeout(previous.persistTimer);
    const entry: Tracked = {
      snapshot,
      fiber: null,
      script: null,
      scriptExit: null,
      lastPushAt: 0,
      pushTimer: null,
      lastPersistAt: 0,
      persistTimer: null,
    };
    tracked.set(snapshot.threadId, entry);
    return entry;
  };

  const readPersisted = (threadId: ThreadId) =>
    sql<{ readonly payload: string }>`
      SELECT payload_json AS payload
      FROM projection_thread_activities
      WHERE activity_id = ${worktreeSetupActivityId(threadId)}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => {
        const raw = rows[0]?.payload;
        if (raw === undefined) return null;
        return Option.getOrNull(decodeSnapshotJson(raw));
      }),
      Effect.orElseSucceed(() => null),
    );

  /** The tracked snapshot, or the persisted one rehydrated after a restart. */
  const load = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const entry = tracked.get(threadId);
      if (entry) return entry;
      const persisted = yield* readPersisted(threadId);
      return persisted ? track(persisted) : null;
    });

  const projectFor = (projectCwd: string) =>
    engine
      .getReadModel()
      .pipe(
        Effect.map(
          (model) =>
            model.projects.find(
              (project) => project.workspaceRoot === projectCwd && project.deletedAt === null,
            ) ?? null,
        ),
      );

  /** Submodule policy, reading checked-in configuration from the selected base commit. */
  const resolveSubmodules = (projectId: ProjectId | null, projectCwd: string, baseSha: string) =>
    Effect.gen(function* () {
      const global = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (global === null || projectId === null) return undefined;
      let checkedIn: ReturnType<typeof parseCheckedInProjectFile> | null = null;
      let sourceFile: "f5.json" | "t3.json" | null = null;
      for (const file of [F5_PROJECT_FILE_NAME, LEGACY_T3_PROJECT_FILE_NAME] as const) {
        const raw = yield* git
          .readFileAtRevision({
            cwd: projectCwd,
            revision: baseSha,
            path: file,
            maxBytes: CHECKED_IN_PROJECT_FILE_MAX_BYTES,
          })
          .pipe(Effect.orElseSucceed(() => null));
        if (raw !== null) {
          checkedIn = parseCheckedInProjectFile(raw);
          sourceFile = file;
          break;
        }
      }
      return resolveProjectSettings({
        global,
        projectId,
        checkedIn: checkedIn?.settings ?? {},
        sourceFile,
      }).settings.worktreeSubmodules as WorktreeSubmodules;
    });

  const isTurnAccepted = (commandId: CommandId) =>
    receipts.getByCommandId({ commandId }).pipe(
      Effect.map((receipt) => Option.isSome(receipt) && receipt.value.status === "accepted"),
      Effect.orElseSucceed(() => false),
    );

  const queueItem = (snapshot: WorktreeSetupSnapshot) =>
    store.getItem(snapshot.itemId).pipe(Effect.orElseSucceed(() => null));

  const pauseQueue = (threadId: ThreadId, reasonCode: QueueReasonCode, detail: string) =>
    Effect.gen(function* () {
      yield* store
        .setWorktreeBlockToken({ threadId, token: null })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* store
        .setPaused({ threadId, paused: true, reasonCode, detail })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* dispatcher.notify(threadId);
    });

  /**
   * The setup program. Fetch, checkout and submodules run under the worktree
   * lifecycle lock; the setup script runs outside it so a long install never
   * blocks cleanup decisions on other paths or the queue worker.
   */
  const runSetup = (threadId: ThreadId, token: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const initial = tracked.get(threadId)!.snapshot;
      const request = initial.request;
      const project = yield* projectFor(request.projectCwd);
      const worktreePath =
        initial.worktreePath ??
        resolveDefaultWorktreePath({
          worktreesDir: config.worktreesDir,
          cwd: request.projectCwd,
          branch: request.branch,
        });

      yield* withWorktreeLifecycleLock(
        worktreePath,
        Effect.gen(function* () {
          const alreadyPrepared =
            initial.createdWorktree &&
            existsSync(worktreePath) &&
            (yield* git.statusDetails(worktreePath).pipe(
              Effect.map((status) => status.branch === request.branch),
              Effect.orElseSucceed(() => false),
            ));
          if (alreadyPrepared) {
            update(threadId, (snapshot) =>
              ["fetch", "checkout", "submodules"].reduce(
                (next, id) =>
                  stageStatus(next, id as WorktreeSetupStageId, "skipped", "already prepared"),
                snapshot,
              ),
            );
          } else {
            update(threadId, (snapshot) => stageStatus(snapshot, "fetch", "running"));
            const hasRemote = yield* git
              .hasRemote(request.projectCwd)
              .pipe(Effect.orElseSucceed(() => false));
            let baseRef: string = request.baseBranch;
            if (hasRemote) {
              const remote = yield* git
                .fetchRemoteBranchCommit({
                  cwd: request.projectCwd,
                  branch: request.baseBranch,
                  allowMissingBranch: true,
                })
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      update(threadId, (snapshot) =>
                        stageStatus(snapshot, "fetch", "warning", error.message),
                      );
                      return null;
                    }),
                  ),
                );
              if (remote) {
                baseRef = remote.commit;
                update(threadId, (snapshot) =>
                  stageStatus(
                    snapshot,
                    "fetch",
                    "done",
                    `${remote.refName} at ${remote.commit.slice(0, 7)}`,
                  ),
                );
              } else if (
                tracked.get(threadId)?.snapshot.stages.find((stage) => stage.id === "fetch")
                  ?.status === "running"
              ) {
                update(threadId, (snapshot) =>
                  stageStatus(
                    snapshot,
                    "fetch",
                    "warning",
                    `${request.baseBranch} is not on the remote; using the local branch`,
                  ),
                );
              }
            } else {
              update(threadId, (snapshot) =>
                stageStatus(snapshot, "fetch", "skipped", "no remote"),
              );
            }

            const baseSha = yield* git.resolveCommit(request.projectCwd, baseRef);
            if (baseSha === null) {
              return yield* new WorktreeSetupError({
                message: `Base branch ${request.baseBranch} has no commit to start from.`,
              });
            }
            update(threadId, (snapshot) => ({ ...snapshot, baseRef, baseSha }));
            const submodules = yield* resolveSubmodules(
              project?.id ?? null,
              request.projectCwd,
              baseSha,
            );
            const branchExists = yield* git.branchExists(request.projectCwd, request.branch);
            update(threadId, (snapshot) => stageStatus(snapshot, "checkout", "running"));
            let checkoutTotal: number | null = null;
            yield* git.createWorktree({
              cwd: request.projectCwd,
              branch: branchExists ? request.branch : request.baseBranch,
              ...(branchExists ? {} : { baseRefName: baseSha, newBranch: request.branch }),
              path: worktreePath,
              ...(submodules !== undefined ? { submodules } : {}),
              progress: {
                onWorktreeClaimed: (path) =>
                  update(threadId, (snapshot) => ({
                    ...snapshot,
                    worktreePath: path,
                    createdWorktree: true,
                    createdBranch: snapshot.createdBranch || !branchExists,
                  })),
                onCheckoutProgress: ({ percent, completed, total }) => {
                  checkoutTotal = total;
                  update(threadId, (snapshot) =>
                    withStage(snapshot, "checkout", (stage) => ({
                      ...stage,
                      percent,
                      detail: `${completed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`,
                    })),
                  );
                },
                onSubmodulesStarted: () =>
                  update(threadId, (snapshot) =>
                    stageStatus(
                      stageStatus(
                        snapshot,
                        "checkout",
                        "done",
                        checkoutTotal === null
                          ? null
                          : `${checkoutTotal.toLocaleString("en-US")} files`,
                      ),
                      "submodules",
                      "running",
                    ),
                  ),
                onSubmoduleLine: (line) => {
                  const submodulePath = /Submodule path '([^']+)'/.exec(line)?.[1];
                  if (submodulePath)
                    update(threadId, (snapshot) =>
                      withStage(snapshot, "submodules", (stage) => ({
                        ...stage,
                        detail: clamp(submodulePath, WORKTREE_SETUP_DETAIL_MAX_LENGTH),
                      })),
                    );
                },
                onSubmodulesFinished: ({ status, detail }) =>
                  update(threadId, (snapshot) =>
                    stageStatus(snapshot, "submodules", status, detail),
                  ),
              },
            });
            update(threadId, (snapshot) => {
              let next: WorktreeSetupSnapshot = {
                ...snapshot,
                worktreePath,
                createdWorktree: true,
                createdBranch: snapshot.createdBranch || !branchExists,
              };
              const checkout = next.stages.find((stage) => stage.id === "checkout");
              if (checkout?.status === "running") {
                next = withStage(
                  stageStatus(
                    next,
                    "checkout",
                    "done",
                    checkoutTotal === null
                      ? null
                      : `${checkoutTotal.toLocaleString("en-US")} files`,
                  ),
                  "checkout",
                  (stage) => ({ ...stage, percent: 100 }),
                );
              }
              const submodulesStage = next.stages.find((stage) => stage.id === "submodules");
              if (submodulesStage?.status === "pending") {
                next = stageStatus(next, "submodules", "skipped", "none");
              }
              return next;
            });
          }
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("meta"),
            threadId,
            branch: request.branch,
            worktreePath,
          });
        }),
      );

      // Setup script, as an owned process.
      const script = request.runSetupScript && project ? setupProjectScript(project.scripts) : null;
      if (script === null) {
        update(threadId, (snapshot) =>
          stageStatus(
            snapshot,
            "setup-script",
            "skipped",
            request.runSetupScript ? "no setup script" : null,
          ),
        );
      } else {
        const async = script.async ?? true;
        update(threadId, (snapshot) =>
          stageStatus(
            {
              ...snapshot,
              setupScript: { name: script.name, command: script.command, async },
            },
            "setup-script",
            "running",
          ),
        );
        const owned = yield* startOwnedSetupScript({
          command: script.command,
          cwd: worktreePath,
          env: projectScriptRuntimeEnv({
            project: { cwd: request.projectCwd },
            worktreePath,
          }),
          onLine: (line) =>
            update(threadId, (snapshot) =>
              withStage(snapshot, "setup-script", (stage) => ({
                ...stage,
                tail: [...stage.tail, line].slice(-WORKTREE_SETUP_TAIL_LINES),
              })),
            ),
        });
        const entry = tracked.get(threadId);
        if (entry) entry.script = owned;
        const completion = owned.exit.pipe(
          Effect.flatMap((code) =>
            Effect.sync(() =>
              update(threadId, (snapshot) =>
                code === 0
                  ? stageStatus(snapshot, "setup-script", "done")
                  : stageStatus(
                      snapshot,
                      "setup-script",
                      "failed",
                      code === null ? "stopped before it finished" : `exit ${code}`,
                    ),
              ),
            ),
          ),
        );
        if (async) {
          const fiber = yield* completion.pipe(Effect.forkIn(scope));
          if (entry) entry.scriptExit = fiber;
        } else {
          // The agent waits; a failed script still hands off, like upstream:
          // the worktree the user waited for is kept and the card shows the failure.
          yield* completion;
        }
      }

      // Read the first turn's command id before the handoff: once the gate
      // opens, delivery can start the turn and delete its queue row.
      const commandId = (yield* queueItem(tracked.get(threadId)!.snapshot))?.command.commandId;
      // Hand off to the queue. The gate opens atomically with the durable token.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          update(threadId, (snapshot) => stageStatus(snapshot, "agent", "running"));
          yield* gate.open(threadId, token);
          yield* store
            .setWorktreeBlockToken({ threadId, token: null, expectedToken: token })
            .pipe(Effect.ignoreCause({ log: true }));
          yield* persistNow(threadId);
          yield* dispatcher.notify(threadId);
        }),
      );

      while (true) {
        const current = tracked.get(threadId)?.snapshot;
        if (!current) return;
        if (commandId !== undefined && (yield* isTurnAccepted(commandId))) break;
        if ((yield* queueItem(current)) === null) {
          // The turn was discarded or started through another path; check once more.
          if (commandId === undefined || !(yield* isTurnAccepted(commandId))) {
            yield* commit(threadId, (snapshot) =>
              settle(stageStatus(snapshot, "agent", "skipped", "turn removed"), "done", null),
            );
            yield* gate.unregister(threadId, token);
            return;
          }
          break;
        }
        yield* Effect.sleep(`${TURN_ACCEPT_POLL_MS} millis`);
      }
      update(threadId, (snapshot) => ({
        ...stageStatus(snapshot, "agent", "done"),
        agentStarted: true,
      }));
      const scriptExit = tracked.get(threadId)?.scriptExit;
      if (scriptExit) yield* Fiber.join(scriptExit);
      yield* commit(threadId, (snapshot) => settle(snapshot, "done", null));
      yield* gate.unregister(threadId, token);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Worktree setup failed.";
        return Effect.uninterruptible(
          Effect.gen(function* () {
            yield* commit(threadId, (snapshot) => settle(snapshot, "failed", message));
            yield* gate.unregister(threadId, token);
            yield* pauseQueue(threadId, "worktree_setup_failed", message);
          }),
        );
      }),
      Effect.ignoreCause({ log: true }),
    );

  const fork = (threadId: ThreadId, token: string) =>
    Effect.gen(function* () {
      const fiber = yield* runSetup(threadId, token).pipe(Effect.forkIn(scope));
      const entry = tracked.get(threadId);
      if (entry) entry.fiber = fiber;
    });

  /**
   * Removes what this setup created, but only when that is provably safe:
   * it created the worktree, the tree is clean, nothing else claims it, and
   * git agrees without `--force`. The branch is deleted only if this setup
   * created it and it still points at the base commit.
   */
  const releaseCreated = (snapshot: WorktreeSetupSnapshot) =>
    Effect.gen(function* () {
      const request = snapshot.request;
      if (!snapshot.createdWorktree || snapshot.worktreePath === null) {
        return { kept: null as string | null };
      }
      const worktreePath = snapshot.worktreePath;
      return yield* withWorktreeLifecycleLock(
        worktreePath,
        Effect.gen(function* () {
          if (existsSync(worktreePath)) {
            const status = yield* git.statusDetails(worktreePath).pipe(Effect.option);
            if (Option.isNone(status) || status.value.hasWorkingTreeChanges) {
              return { kept: CANCELLED_KEPT_DETAIL };
            }
            const claims = yield* readWorktreeClaims(worktreePath).pipe(
              Effect.provideServices(services),
            );
            // foreignClaims ignores this thread's own session, but an agent
            // that started without writing files still needs its worktree.
            if (claims.sessions.some((session) => session.threadId === snapshot.threadId)) {
              return { kept: "Setup cancelled; worktree kept because the agent session uses it." };
            }
            const foreign = foreignClaims(claims, snapshot.threadId);
            if (foreign.length > 0) {
              return { kept: `Setup cancelled; worktree kept because ${foreign.join(", ")}.` };
            }
            const removed = yield* git
              .removeWorktree({ cwd: request.projectCwd, path: worktreePath, force: false })
              .pipe(Effect.exit);
            if (removed._tag === "Failure") {
              return { kept: `Setup cancelled; worktree kept: ${Cause.pretty(removed.cause)}` };
            }
          }
          if (snapshot.createdBranch && snapshot.baseSha !== null) {
            const deleted = yield* git
              .deleteBranchIfAt({
                cwd: request.projectCwd,
                branch: request.branch,
                expectedSha: snapshot.baseSha,
              })
              .pipe(Effect.orElseSucceed(() => false));
            if (!deleted) {
              return {
                kept: `Setup cancelled; branch ${request.branch} kept because it has new commits.`,
              };
            }
          }
          return { kept: null as string | null };
        }),
      ).pipe(
        Effect.catchTag("RepositoryLifecycleError", (error) =>
          Effect.succeed({ kept: `Setup cancelled; worktree kept: ${error.message}` }),
        ),
      );
    });

  /** Interrupts the setup fiber and kills its owned script, waiting for both. */
  const stopRunning = (entry: Tracked) =>
    Effect.gen(function* () {
      if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
      entry.fiber = null;
      if (entry.scriptExit) yield* Fiber.interrupt(entry.scriptExit);
      entry.scriptExit = null;
      if (entry.script) yield* entry.script.kill;
      entry.script = null;
    });

  const failFor = (message: string) => new WorktreeSetupError({ message });

  const start: WorktreeSetupShape["start"] = (input) =>
    Effect.gen(function* () {
      const bootstrap = input.command.bootstrap;
      const createThread = bootstrap?.createThread;
      const prepareWorktree = bootstrap?.prepareWorktree;
      if (!createThread || !prepareWorktree) {
        return yield* failFor("Worktree setup needs a new thread and a base branch.");
      }
      const projectCwd = prepareWorktree.projectCwd;
      const isRepo = yield* git.resolveCommonDir(projectCwd).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const localBase = isRepo
        ? yield* git
            .resolveCommit(projectCwd, prepareWorktree.baseBranch)
            .pipe(Effect.orElseSucceed(() => null))
        : null;
      const hasRemote = isRepo
        ? yield* git.hasRemote(projectCwd).pipe(Effect.orElseSucceed(() => false))
        : false;
      if (!isRepo || (localBase === null && !hasRemote)) {
        return {
          kind: "unavailable" as const,
          detail: !isRepo
            ? "A separate worktree requires a Git repository."
            : `A separate worktree requires a base branch with a commit; ${prepareWorktree.baseBranch} has none.`,
        };
      }
      const threadId = input.command.threadId;
      const branch = prepareWorktree.branch ?? buildTemporaryWorktreeBranchName();
      const createdAt = createThread.createdAt;

      const created = yield* engine
        .dispatch({
          type: "thread.create",
          commandId: serverCommandId("thread-create"),
          threadId,
          projectId: createThread.projectId,
          title: createThread.title,
          model: createThread.model,
          ...(createThread.modelSelection ? { modelSelection: createThread.modelSelection } : {}),
          runtimeMode: createThread.runtimeMode,
          interactionMode: createThread.interactionMode,
          branch: null,
          worktreePath: null,
          ...(createThread.pullRequest ? { pullRequest: createThread.pullRequest } : {}),
          createdAt,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorktreeSetupError({
                message: error.message,
                ...(isDefinitelyUncommittedDispatchError(error)
                  ? { code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE }
                  : {}),
              }),
          ),
        );
      void created;

      const rollbackThread = (message: string) =>
        Effect.gen(function* () {
          yield* input.discardAttachments;
          const deleted = yield* engine
            .dispatch({
              type: "thread.delete",
              commandId: serverCommandId("thread-delete"),
              threadId,
            })
            .pipe(Effect.isSuccess);
          return yield* new WorktreeSetupError({
            message,
            ...(deleted ? { code: BOOTSTRAP_THREAD_DELETED_ERROR_CODE } : {}),
          });
        });

      yield* input.persistAttachments.pipe(Effect.catch((error) => rollbackThread(error.message)));

      const operationId = crypto.randomUUID();
      const itemId = CommandId.makeUnsafe(crypto.randomUUID());
      const startedAt = nowIso();
      const snapshot: WorktreeSetupSnapshot = {
        threadId,
        operationId,
        itemId,
        phase: "running",
        startedAt,
        endedAt: null,
        request: {
          projectCwd,
          baseBranch: prepareWorktree.baseBranch,
          branch,
          runSetupScript: bootstrap.runSetupScript === true,
          requireWorktree: prepareWorktree.requireWorktree === true,
        },
        baseRef: null,
        baseSha: null,
        worktreePath: null,
        createdBranch: false,
        createdWorktree: false,
        setupScript: null,
        agentStarted: false,
        stages: WORKTREE_SETUP_STAGE_ORDER.map(emptyStage),
        error: null,
        sequence: 0,
      };
      track(snapshot);
      yield* gate.register(threadId, operationId);
      const { bootstrap: _bootstrap, ...queuedCommand } = input.command;
      const inserted = yield* store
        .insertSubmission({
          submissionId: input.submissionId,
          requestHash: input.requestHash,
          itemId,
          command: queuedCommand as ThreadTurnStartCommand,
          atHead: true,
          worktreeBlockToken: operationId,
        })
        .pipe(
          Effect.catch((error) =>
            gate
              .unregister(threadId, operationId)
              .pipe(
                Effect.andThen(Effect.sync(() => tracked.delete(threadId))),
                Effect.andThen(rollbackThread(error.message)),
              ),
          ),
        );
      if (inserted.kind === "replay") {
        return yield* failFor("That send was already admitted.");
      }
      yield* persistNow(threadId);
      pushNow(threadId);
      yield* fork(threadId, operationId);
      const result: TurnSubmissionResult = {
        disposition: "queued",
        submissionId: input.submissionId,
        itemId,
        snapshot: yield* dispatcher
          .getSnapshot(threadId)
          .pipe(Effect.mapError((error) => failFor(error.message))),
      };
      yield* store
        .settleSubmission({ submissionId: input.submissionId, result })
        .pipe(Effect.ignoreCause({ log: true }));
      return { kind: "queued" as const, result };
    });

  const get: WorktreeSetupShape["get"] = (threadId) =>
    load(threadId).pipe(Effect.map((entry) => entry?.snapshot ?? null));

  const discard = (entry: Tracked) =>
    Effect.gen(function* () {
      const snapshot = entry.snapshot;
      const threadId = snapshot.threadId;
      const queued = yield* queueItem(snapshot);
      if (
        snapshot.agentStarted ||
        (queued !== null && (yield* isTurnAccepted(queued.command.commandId)))
      ) {
        // The worktree belongs to a running or finished turn now.
        return yield* failFor("The agent already started in this worktree; stop the turn instead.");
      }
      const released = yield* releaseCreated(snapshot);
      const item = yield* queueItem(snapshot);
      if (item) {
        yield* store.softDelete({ itemId: item.itemId }).pipe(Effect.ignoreCause({ log: true }));
      }
      yield* store
        .setWorktreeBlockToken({ threadId, token: null })
        .pipe(Effect.ignoreCause({ log: true }));
      const settled = yield* commit(threadId, (current) =>
        settle(
          released.kept === null ? current : { ...current, phase: "cancelled_kept" },
          released.kept === null ? "cancelled" : "cancelled_kept",
          released.kept,
        ),
      );
      // A thread whose first turn never started holds nothing but this setup.
      const thread = (yield* engine.getReadModel()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      const remaining = yield* store.listByThread(threadId).pipe(
        Effect.map((data) => data.items.length),
        Effect.orElseSucceed(() => 1),
      );
      if (
        released.kept === null &&
        thread &&
        thread.deletedAt === null &&
        thread.messages.length === 0 &&
        remaining === 0
      ) {
        yield* engine
          .dispatch({
            type: "thread.delete",
            commandId: serverCommandId("discard-delete"),
            threadId,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* dispatcher.notify(threadId);
      return settled;
    });

  const cancel: WorktreeSetupShape["cancel"] = (threadId) =>
    Effect.gen(function* () {
      const entry = yield* load(threadId);
      if (!entry) return null;
      const snapshot = entry.snapshot;
      if (snapshot.phase !== "running") {
        return yield* discard(entry);
      }
      const commandId = (yield* queueItem(snapshot))?.command.commandId;
      if (snapshot.agentStarted || (commandId && (yield* isTurnAccepted(commandId)))) {
        // The agent owns the worktree now: stop the turn, remove nothing.
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: serverCommandId("interrupt"),
            threadId,
            createdAt: nowIso(),
          })
          .pipe(Effect.mapError((error) => failFor(error.message)));
        return snapshot;
      }
      // Hold the turn first so a dispatcher waiting on the path lock sees the pause.
      yield* store
        .setPaused({
          threadId,
          paused: true,
          reasonCode: "worktree_setup_cancelled",
          detail: "Setup cancelled.",
        })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* gate.unregister(threadId, snapshot.operationId);
      yield* stopRunning(entry);
      if (commandId && (yield* isTurnAccepted(commandId))) {
        // The handoff won the race; behave as if the agent had started.
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: serverCommandId("interrupt"),
            threadId,
            createdAt: nowIso(),
          })
          .pipe(Effect.ignoreCause({ log: true }));
        return yield* commit(threadId, (current) => ({
          ...settle(current, "done", null),
          agentStarted: true,
        }));
      }
      const released = yield* releaseCreated(entry.snapshot);
      if (released.kept === null && entry.snapshot.createdWorktree) {
        yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("meta-clear"),
            threadId,
            branch: null,
            worktreePath: null,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      const settled = yield* commit(threadId, (current) => ({
        ...settle(
          released.kept === null ? current : current,
          released.kept === null ? "cancelled" : "cancelled_kept",
          released.kept,
        ),
        ...(released.kept === null
          ? { worktreePath: null, createdWorktree: false, createdBranch: false }
          : {}),
      }));
      yield* pauseQueue(
        threadId,
        released.kept === null ? "worktree_setup_cancelled" : "worktree_setup_cancelled_kept",
        released.kept ?? "Setup cancelled.",
      );
      return settled;
    });

  const retry: WorktreeSetupShape["retry"] = (threadId) =>
    Effect.gen(function* () {
      const entry = yield* load(threadId);
      if (!entry) return yield* failFor("No worktree setup to retry.");
      const snapshot = entry.snapshot;
      if (snapshot.phase === "running") return snapshot;
      if (snapshot.agentStarted || snapshot.phase === "done") {
        return yield* failFor("The agent already started in this worktree.");
      }
      if ((yield* queueItem(snapshot)) === null) {
        return yield* failFor("The queued first turn is gone; send the message again.");
      }
      const operationId = crypto.randomUUID();
      const startedAt = nowIso();
      entry.snapshot = {
        ...snapshot,
        operationId,
        phase: "running",
        startedAt,
        endedAt: null,
        error: null,
        setupScript: null,
        stages: WORKTREE_SETUP_STAGE_ORDER.map(emptyStage),
        sequence: snapshot.sequence + 1,
      };
      yield* gate.register(threadId, operationId);
      yield* store
        .setWorktreeBlockToken({ threadId, token: operationId })
        .pipe(Effect.mapError((error) => failFor(error.message)));
      yield* store
        .setPaused({ threadId, paused: false })
        .pipe(Effect.mapError((error) => failFor(error.message)));
      yield* persistNow(threadId);
      pushNow(threadId);
      yield* fork(threadId, operationId);
      return entry.snapshot;
    });

  const workLocally: WorktreeSetupShape["workLocally"] = (threadId) =>
    Effect.gen(function* () {
      const entry = yield* load(threadId);
      if (!entry) return yield* failFor("No worktree setup for this thread.");
      if (entry.snapshot.agentStarted) {
        return yield* failFor("The agent already started in the worktree.");
      }
      const queued = yield* queueItem(entry.snapshot);
      if (queued === null) {
        return yield* failFor("The queued first turn is gone; send the message again.");
      }
      yield* store
        .setPaused({
          threadId,
          paused: true,
          reasonCode: "worktree_setup_cancelled",
          detail: "Switching to the project checkout.",
        })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* gate.unregister(threadId, entry.snapshot.operationId);
      yield* stopRunning(entry);
      if (yield* isTurnAccepted(queued.command.commandId)) {
        // The handoff won the race: the agent is running in the worktree, so
        // keep it and leave the queue running.
        yield* store.setPaused({ threadId, paused: false }).pipe(Effect.ignoreCause({ log: true }));
        yield* commit(threadId, (current) => ({
          ...settle(current, "done", null),
          agentStarted: true,
        }));
        return yield* failFor("The agent already started in the worktree.");
      }
      const released = yield* releaseCreated(entry.snapshot);
      const local = yield* git.statusDetails(entry.snapshot.request.projectCwd).pipe(
        Effect.map((status) => status.branch),
        Effect.orElseSucceed(() => null),
      );
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("work-locally"),
          threadId,
          branch: local,
          worktreePath: null,
        })
        .pipe(Effect.mapError((error) => failFor(error.message)));
      const settled = yield* commit(threadId, (current) => ({
        ...settle(
          current,
          released.kept === null ? "cancelled" : "cancelled_kept",
          released.kept === null
            ? "Running in the project checkout instead."
            : `${released.kept} Running in the project checkout instead.`,
        ),
        ...(released.kept === null
          ? { worktreePath: null, createdWorktree: false, createdBranch: false }
          : {}),
      }));
      yield* store
        .setWorktreeBlockToken({ threadId, token: null })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* store
        .setPaused({ threadId, paused: false })
        .pipe(Effect.mapError((error) => failFor(error.message)));
      yield* dispatcher.notify(threadId);
      return settled;
    });

  const startup: WorktreeSetupShape["startup"] = Effect.gen(function* () {
    // Owned setup scripts run in their own process group; stop them with the server.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...tracked.values()],
        (entry) => (entry.script ? entry.script.kill : Effect.void),
        { discard: true, concurrency: "unbounded" },
      ),
    );
    const rows = yield* sql<{ readonly threadId: ThreadId; readonly payload: string }>`
      SELECT thread_id AS "threadId", payload_json AS payload
      FROM projection_thread_activities
      WHERE kind = ${WORKTREE_SETUP_ACTIVITY_KIND}
    `.pipe(Effect.orElseSucceed(() => []));
    for (const row of rows) {
      const decoded = Option.getOrNull(decodeSnapshotJson(row.payload));
      if (decoded === null || decoded.phase !== "running" || tracked.has(row.threadId)) continue;
      track(decoded);
      if (decoded.agentStarted) {
        yield* commit(row.threadId, (snapshot) =>
          settle(
            stageStatus(snapshot, "setup-script", "warning", "stopped by a server restart"),
            "done",
            null,
          ),
        );
        continue;
      }
      yield* commit(row.threadId, (snapshot) =>
        settle(snapshot, "failed", SETUP_INTERRUPTED_BY_RESTART),
      );
      yield* pauseQueue(row.threadId, "worktree_setup_failed", SETUP_INTERRUPTED_BY_RESTART);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree setup startup reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  return {
    start,
    get,
    cancel,
    retry,
    workLocally,
    changes: Stream.fromPubSub(changes),
    startup,
  } satisfies WorktreeSetupShape;
});

export const WorktreeSetupLive = Layer.effect(WorktreeSetup, makeWorktreeSetup);
