import { WorkspaceTransitions } from "../../persistence/Services/WorkspaceTransitions.ts";
import { WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import { dispatchVerifiedWorkspace } from "../workspaceTransitionContext.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildGeneratedWorktreeBranchName } from "../../git/worktreeBranchNames.ts";
import { isTemporaryWorktreeBranch, canonicalWorktreePath } from "../../git/worktreePaths.ts";
import {
  WorktreePreparations,
  type PreparationError,
} from "../../persistence/Services/WorktreePreparations.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { readProjectSettings } from "../projectSettings.ts";
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
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { isDefinitelyUncommittedDispatchError } from "../../wsServer/bootstrapTurnStart.ts";
import { startOwnedSetupScript, type OwnedSetupScript } from "../ownedSetupScript.ts";
import { removeWorktreeSafely } from "../worktreeClaims.ts";
import {
  WorktreeSetup,
  WorktreeSetupError,
  type WorktreeSetupShape,
} from "../Services/WorktreeSetup.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import {
  withRepositoryLifecycleLock,
  withWorktreeLifecycleLock,
  type RepositoryLifecycleError,
} from "./WorktreeLifecycleCoordinator.ts";

/** Live pushes coalesce to this interval; the durable activity to the persist interval. */
const PUSH_INTERVAL_MS = 100;
const PERSIST_INTERVAL_MS = 500;
const TURN_ACCEPT_POLL_MS = 250;

const SETUP_INTERRUPTED_BY_RESTART =
  "Worktree setup was interrupted by a server restart. Nothing was removed.";

interface Tracked {
  snapshot: WorktreeSetupSnapshot;
  fiber: Fiber.Fiber<void, never> | null;
  script: OwnedSetupScript | null;
  naming: Fiber.Fiber<string | null, never> | null;
  scriptExit: Fiber.Fiber<void, PreparationError | RepositoryLifecycleError> | null;
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
    | TextGeneration
    | WorktreePreparations
    | WorktreePreparation
    | SqlClient.SqlClient
  >();
  const textGeneration = yield* TextGeneration;
  const preparations = yield* WorktreePreparations;
  const preparation = yield* WorktreePreparation;
  const engine = yield* OrchestrationEngineService;
  const store = yield* NextTurnQueueStore;
  const dispatcher = yield* NextTurnQueueDispatcher;
  const git = yield* GitCore;
  const transitions = yield* Effect.serviceOption(WorkspaceTransition);
  const transitionStore = yield* Effect.serviceOption(WorkspaceTransitions);
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
  const persistNow = (threadId: ThreadId, required = false): Effect.Effect<void> =>
    persistLock(threadId).withPermits(1)(
      Effect.gen(function* () {
        const entry = tracked.get(threadId);
        if (!entry) return;
        const snapshot = entry.snapshot;
        yield* sql`INSERT INTO worktree_setup_ordering (thread_id, generation, sequence)
          VALUES (${threadId}, ${snapshot.generation}, ${snapshot.sequence})
          ON CONFLICT(thread_id) DO UPDATE SET generation = excluded.generation, sequence = excluded.sequence
          WHERE excluded.generation > generation OR (excluded.generation = generation AND excluded.sequence > sequence)`;
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
          required
            ? Effect.failCause(cause).pipe(Effect.orDie)
            : Cause.hasInterruptsOnly(cause)
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
    PubSub.publishUnsafe(changes, {
      threadId,
      snapshot: entry.snapshot,
      generation: entry.snapshot.generation,
      sequence: entry.snapshot.sequence,
    });
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
    required = false,
  ) =>
    Effect.gen(function* () {
      const entry = tracked.get(threadId);
      if (!entry) return null;
      entry.snapshot = { ...mutate(entry.snapshot), sequence: entry.snapshot.sequence + 1 };
      yield* persistNow(threadId, required);
      schedule(threadId, true);
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
      naming: null,
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

  const nextGeneration = (threadId: ThreadId) =>
    sql<{ generation: number; sequence: number }>`
    INSERT INTO worktree_setup_ordering (thread_id, generation, sequence) VALUES (${threadId}, 1, 0)
    ON CONFLICT(thread_id) DO UPDATE SET generation = generation + 1 RETURNING generation, sequence
  `.pipe(
      Effect.map((rows) => rows[0]!),
      Effect.mapError(
        (cause) =>
          new WorktreeSetupError({ message: `Cannot persist setup generation: ${String(cause)}` }),
      ),
    );
  const ordering: WorktreeSetupShape["ordering"] = (threadId) =>
    sql<{ generation: number; sequence: number }>`
    SELECT generation, sequence FROM worktree_setup_ordering WHERE thread_id = ${threadId}
  `.pipe(
      Effect.map((rows) => rows[0] ?? { generation: 0, sequence: 0 }),
      Effect.mapError(
        (cause) =>
          new WorktreeSetupError({ message: `Cannot read setup ordering: ${String(cause)}` }),
      ),
    );

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
   * Only checkout takes lifecycle locks. Fetch, submodules and setup scripts run
   * outside them; the persisted setup path and queue token protect ownership.
   */
  const runSetup = (threadId: ThreadId, token: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      let initial = tracked.get(threadId)!.snapshot;
      let request = initial.request;
      const started = Date.now();
      const project = yield* projectFor(request.projectCwd);
      const queued = yield* queueItem(initial);
      const namingSettings = project
        ? (yield* readProjectSettings(yield* settings.getSettings, project)).settings
        : null;
      const naming =
        !initial.createdWorktree &&
        isTemporaryWorktreeBranch(request.branch) &&
        queued &&
        (queued.command.message.text.trim() || queued.command.message.attachments.length > 0)
          ? yield* textGeneration
              .generateBranchName({
                cwd: request.projectCwd,
                message: queued.command.message.text,
                attachments: queued.command.message.attachments,
                ...(namingSettings
                  ? {
                      modelSelection: namingSettings.textGenerationModelSelection,
                      writingPreferences: namingSettings.sourceControlWriting,
                    }
                  : {}),
              })
              .pipe(
                Effect.map((result) =>
                  buildGeneratedWorktreeBranchName(
                    result.branch,
                    namingSettings?.sourceControlWriting.branchNamePrefix ?? "f5",
                  ),
                ),
                Effect.orElseSucceed(() => null),
                Effect.forkIn(scope),
              )
          : null;
      const namingEntry = tracked.get(threadId);
      if (namingEntry) namingEntry.naming = naming;
      let worktreePath = initial.worktreePath;
      if (worktreePath && existsSync(worktreePath)) {
        const receipt = yield* git.readWorktreePreparation(worktreePath);
        if (receipt && receipt.owner === `thread:${threadId}`) {
          const inspected = yield* git.inspectCheckout(worktreePath);
          if (
            !receipt.baseOid ||
            !inspected.registration ||
            inspected.commonDir !== receipt.repositoryIdentity ||
            inspected.branch !== receipt.branch ||
            inspected.canonicalRoot !== receipt.path ||
            (receipt.phase === "allocated" &&
              (initial.generation < 2 ||
                inspected.headSha !== receipt.baseOid ||
                inspected.hasTrackedChanges ||
                inspected.hasUntrackedChanges ||
                inspected.ignoredTruncated ||
                inspected.ignoredEntries.length > 0))
          )
            return yield* new WorktreeSetupError({
              message: "Interrupted creation requires inspection. The checkout was retained.",
            });
          if (receipt.phase === "allocated")
            yield* preparations.update(receipt, { phase: "checkout_created" });
          request = { ...request, branch: receipt.branch };
          initial = {
            ...initial,
            request,
            createdWorktree: receipt.createdCheckout,
            checkoutSha: receipt.baseOid,
            baseSha: receipt.baseOid,
            creationCommonDir: receipt.repositoryIdentity,
            createdBranch: receipt.namingIntent !== "existing" && receipt.createdCheckout,
          };
          yield* commit(threadId, (snapshot) => ({ ...snapshot, ...initial }), true);
        }
      }
      yield* Effect.gen(function* () {
        const alreadyPrepared =
          worktreePath !== null &&
          existsSync(worktreePath) &&
          (yield* git.inspectCheckout(worktreePath).pipe(
            Effect.map(
              (status) =>
                status.branch === request.branch &&
                status.registration !== null &&
                status.commonDir === initial.creationCommonDir,
            ),
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
                // The raw git error is internal and unreadable in the card; log it
                // and show the user what actually happened instead.
                Effect.catch((error) =>
                  Effect.logWarning("worktree setup could not fetch the remote base branch", {
                    threadId,
                    baseBranch: request.baseBranch,
                    error: error.message,
                  }).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        update(threadId, (snapshot) =>
                          stageStatus(
                            snapshot,
                            "fetch",
                            "warning",
                            `Couldn't reach the remote; using local ${request.baseBranch}`,
                          ),
                        );
                        return null;
                      }),
                    ),
                  ),
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
            update(threadId, (snapshot) => stageStatus(snapshot, "fetch", "skipped", "no remote"));
          }

          const baseSha = yield* git.resolveCommit(request.projectCwd, baseRef);
          if (baseSha === null) {
            return yield* new WorktreeSetupError({
              message: `Base branch ${request.baseBranch} has no commit to start from.`,
            });
          }
          const creationCommonDir = yield* git.resolveCommonDir(request.projectCwd);
          yield* commit(
            threadId,
            (snapshot) => ({ ...snapshot, baseRef, baseSha, creationCommonDir }),
            true,
          );
          const submodules = yield* resolveSubmodules(
            project?.id ?? null,
            request.projectCwd,
            baseSha,
          );
          let checkoutBranch = request.branch;
          let creationIntent = request.namingIntent ?? "temporary";
          let generatedName: string | null = null;
          if (naming) {
            const generated = yield* Fiber.join(naming).pipe(
              Effect.timeoutOption(Math.max(1, 3000 - (Date.now() - started))),
            );
            if (Option.isSome(generated)) generatedName = generated.value;
          }
          // Reserve the name durably before taking any checkout path lock. This also
          // makes independent fan-out preparations choose different generated names.
          yield* withRepositoryLifecycleLock(
            config.baseDir,
            creationCommonDir,
            Effect.gen(function* () {
              if (generatedName) {
                checkoutBranch = yield* git.resolveAvailableBranchName(
                  request.projectCwd,
                  generatedName,
                );
                creationIntent = "generated";
              }
              worktreePath ??= yield* git.allocateWorktreePath({
                cwd: request.projectCwd,
                branch: checkoutBranch,
              });
              const old = yield* git.readWorktreePreparation(worktreePath);
              yield* preparations.allocate({
                operationId:
                  old && old.owner === `thread:${threadId}` && old.phase === "allocated"
                    ? old.operationId
                    : initial.operationId,
                repositoryIdentity: yield* Effect.promise(() =>
                  canonicalWorktreePath(creationCommonDir),
                ),
                projectIdentity: yield* Effect.promise(() =>
                  canonicalWorktreePath(request.projectCwd),
                ),
                owner: `thread:${threadId}`,
                requestedBase: request.baseBranch,
                baseOid: baseSha,
                path: yield* Effect.promise(() => canonicalWorktreePath(worktreePath!)),
                branch: checkoutBranch,
                namingIntent: creationIntent,
                runSetupScript: request.runSetupScript,
                setupIdentity: project
                  ? (setupProjectScript(project.scripts)?.command ?? null)
                  : null,
              });
            }),
          );
          if (worktreePath === null)
            return yield* new WorktreeSetupError({
              message: "The worktree path was not allocated.",
            });
          // This path must survive a crash immediately before or during worktree add.
          yield* commit(threadId, (snapshot) => ({ ...snapshot, worktreePath }), true);
          const branchExists = yield* git.branchExists(request.projectCwd, checkoutBranch);

          update(threadId, (snapshot) => stageStatus(snapshot, "checkout", "running"));
          let checkoutTotal: number | null = null;
          const existingReceipt = yield* git.readWorktreePreparation(worktreePath);
          if (branchExists && !initial.createdWorktree)
            return yield* new WorktreeSetupError({
              message: `Branch \`${checkoutBranch}\` already exists. Inspect the retained preparation before retrying.`,
            });
          yield* git.createWorktree({
            cwd: request.projectCwd,
            branch: branchExists ? checkoutBranch : request.baseBranch,
            ...(branchExists ? {} : { baseRefName: baseSha, newBranch: checkoutBranch }),
            preparation: {
              owner: `thread:${threadId}`,
              operationId: existingReceipt?.operationId ?? initial.operationId,
              namingIntent: creationIntent,
              runSetupScript: request.runSetupScript,
              setupIdentity: project
                ? (setupProjectScript(project.scripts)?.command ?? null)
                : null,
            },
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
                update(threadId, (snapshot) => stageStatus(snapshot, "submodules", status, detail)),
            },
          });
          request = { ...request, branch: checkoutBranch, namingIntent: creationIntent };
          yield* commit(threadId, (snapshot) => ({ ...snapshot, request }), true);
          const checkoutSha = yield* git.resolveCommit(worktreePath, "HEAD");
          if (checkoutSha)
            yield* commit(threadId, (snapshot) => ({ ...snapshot, checkoutSha }), true);
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
                  checkoutTotal === null ? null : `${checkoutTotal.toLocaleString("en-US")} files`,
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
        yield* dispatchVerifiedWorkspace(engine, git, {
          type: "thread.meta.update",
          commandId: serverCommandId("meta"),
          threadId,
          branch: request.branch,
          worktreePath,
        });
      });

      if (worktreePath === null)
        return yield* new WorktreeSetupError({
          message: "The setup checkout path is unavailable.",
        });
      const receiptPath = yield* Effect.promise(() => canonicalWorktreePath(worktreePath!));
      let receipt = yield* preparations.latest(receiptPath);
      if (!receipt) {
        // Legacy retries are explicit confirmation, but never confer deletion ownership.
        const inspected = yield* git.inspectCheckout(worktreePath);
        const expectedBase = initial.checkoutSha ?? initial.baseSha;
        if (
          !inspected.registration ||
          inspected.canonicalRoot !== receiptPath ||
          inspected.commonDir !== initial.creationCommonDir ||
          inspected.branch !== request.branch ||
          !expectedBase ||
          inspected.headSha !== expectedBase ||
          inspected.hasTrackedChanges ||
          inspected.hasUntrackedChanges ||
          inspected.ignoredTruncated ||
          inspected.ignoredEntries.length > 0
        )
          return yield* new WorktreeSetupError({
            message:
              "The legacy checkout cannot be verified for setup reuse. Inspect the retained files before retrying.",
          });
        const adopted = yield* preparations.allocate({
          operationId: initial.operationId,
          repositoryIdentity: inspected.commonDir,
          projectIdentity: yield* Effect.promise(() => canonicalWorktreePath(request.projectCwd)),
          owner: `thread:${threadId}`,
          requestedBase: request.baseBranch,
          baseOid: expectedBase,
          path: receiptPath,
          branch: request.branch,
          namingIntent: "existing",
          setupIdentity: project ? (setupProjectScript(project.scripts)?.command ?? null) : null,
          runSetupScript: request.runSetupScript,
        });
        receipt = yield* preparations.update(adopted, { phase: "checkout_created" });
      }
      if (receipt && receipt.phase === "setup_indeterminate") {
        // Retrying the setup action explicitly acknowledges possible external script effects.
        receipt = yield* preparations.update(receipt, { phase: "checkout_created" });
      }
      const alreadyCompleted = receipt?.phase === "completed" || receipt?.phase === "skipped";
      const requestedScript =
        request.runSetupScript && project ? setupProjectScript(project.scripts) : null;
      if (
        receipt &&
        !alreadyCompleted &&
        requestedScript &&
        receipt.setupIdentity !== null &&
        receipt?.setupIdentity !== requestedScript.command &&
        initial.generation < 2
      )
        return yield* new WorktreeSetupError({
          message:
            "The setup script changed. Inspect the retained preparation before retrying with a different script.",
        });
      if (receipt && !alreadyCompleted)
        receipt = yield* preparations.update(receipt, {
          phase: "setup_running",
          error: null,
          result: null,
          setupIdentity: requestedScript?.command ?? null,
        });
      const finishReceipt = (code: number | null) =>
        withWorktreeLifecycleLock(
          worktreePath!,
          Effect.gen(function* () {
            if (!receipt || alreadyCompleted) return;
            const latest = yield* preparations.latest(receipt.path);
            if (
              !latest ||
              latest.operationId !== receipt.operationId ||
              latest.phase !== "setup_running"
            )
              return;
            receipt = yield* preparations.update(latest, {
              phase: code === 0 ? "completed" : "setup_failed",
              result:
                code === 0 ? JSON.stringify({ path: worktreePath, branch: request.branch }) : null,
              error: code === 0 ? null : `Setup script exited with ${code ?? "no status"}.`,
            });
          }),
        );
      // Setup script, as an owned process.
      const script =
        !alreadyCompleted && request.runSetupScript && project
          ? setupProjectScript(project.scripts)
          : null;
      if (script === null) {
        yield* finishReceipt(0);
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
          Effect.tap(finishReceipt),
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
          if (receipt) receipt = yield* preparations.update(receipt, { result: '{"async":true}' });
          const exit = yield* completion.pipe(Effect.forkIn(scope));
          if (entry) entry.scriptExit = exit;
        } else {
          yield* completion;
        }
      }

      if (naming) {
        const late = yield* Fiber.join(naming).pipe(Effect.timeoutOption(1));
        if (Option.isSome(late) && late.value && isTemporaryWorktreeBranch(request.branch)) {
          yield* withWorktreeLifecycleLock(
            worktreePath,
            withRepositoryLifecycleLock(
              config.baseDir,
              yield* git.resolveCommonDir(request.projectCwd),
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const renamed = yield* git
                    .renameBranch({
                      cwd: worktreePath!,
                      oldBranch: request.branch,
                      newBranch: late.value!,
                    })
                    .pipe(
                      Effect.catch((error) =>
                        Effect.logWarning(
                          "Late worktree rename failed; keeping the temporary branch",
                          { message: error.message },
                        ).pipe(Effect.as(null)),
                      ),
                    );
                  if (!renamed) return;
                  request = { ...request, branch: renamed.branch, namingIntent: "generated" };
                  if (receipt) {
                    const latest = yield* preparations.latest(receipt.path);
                    if (latest?.operationId === receipt.operationId)
                      receipt = yield* preparations.update(latest, { branch: renamed.branch });
                  }
                  yield* commit(threadId, (snapshot) => ({ ...snapshot, request }), true);
                  yield* dispatchVerifiedWorkspace(engine, git, {
                    type: "thread.meta.update",
                    commandId: serverCommandId("late-rename"),
                    threadId,
                    branch: renamed.branch,
                  });
                }),
              ),
            ),
          );
        }
        yield* Fiber.interrupt(naming);
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
      Effect.ensuring(
        Effect.gen(function* () {
          const entry = tracked.get(threadId);
          if (entry?.naming) yield* Fiber.interrupt(entry.naming);
          if (entry) entry.naming = null;
        }),
      ),
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
      if (snapshot.worktreePath === null) {
        return { kept: null as string | null };
      }
      const worktreePath = snapshot.worktreePath;
      return yield* withWorktreeLifecycleLock(
        worktreePath,
        Effect.gen(function* () {
          const proof = yield* git.readWorktreePreparation(worktreePath);
          if (
            !proof?.createdCheckout ||
            !proof.baseOid ||
            proof.owner !== `thread:${snapshot.threadId}`
          ) {
            if (
              !existsSync(worktreePath) &&
              (!proof || !(yield* git.branchExists(request.projectCwd, proof.branch)))
            ) {
              if (proof)
                yield* preparations.update(proof, {
                  phase: "skipped",
                  error: "Cancelled before checkout.",
                });
              return { kept: null as string | null };
            }
            return {
              kept: "Setup cancelled; worktree kept because its creation ownership could not be proved.",
            };
          }
          const result = yield* removeWorktreeSafely({
            projectCwd: request.projectCwd,
            path: worktreePath,
            policy: {
              kind: "ownedRollback",
              ownThreadId: snapshot.threadId,
              ownedCreation: {
                path: proof.path,
                commonDir: proof.repositoryIdentity,
                baseSha: proof.baseOid,
                created: proof.createdCheckout,
              },
            },
          }).pipe(Effect.provideServices(services));
          if (result.blockedReasons.length)
            return { kept: `Setup cancelled; worktree kept: ${result.blockedReasons.join("; ")}` };
          const preparationReceipt = yield* git.readWorktreePreparation(worktreePath);
          if (preparationReceipt)
            yield* preparations.update(preparationReceipt, {
              phase: "skipped",
              error: "Owned checkout removed after setup cancellation.",
            });
          if (proof.namingIntent !== "existing") {
            const deleted = yield* git
              .deleteBranchIfAt({
                cwd: request.projectCwd,
                branch: proof.branch,
                expectedSha: proof.baseOid,
              })
              .pipe(Effect.orElseSucceed(() => false));
            if (!deleted) {
              return {
                kept: `Setup cancelled; branch ${proof.branch} kept because it has new commits.`,
              };
            }
          }
          return { kept: null as string | null };
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({ kept: `Setup cancelled; worktree kept: ${error.message}` }),
        ),
      );
    });

  /** Interrupts the setup fiber and kills its owned script, waiting for both. */
  const stopRunning = (entry: Tracked) =>
    Effect.gen(function* () {
      if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
      entry.fiber = null;
      if (entry.naming) yield* Fiber.interrupt(entry.naming);
      entry.naming = null;
      if (entry.scriptExit) yield* Fiber.interrupt(entry.scriptExit);
      entry.scriptExit = null;
      if (entry.script) yield* entry.script.kill;
      entry.script = null;
      if (entry.snapshot.worktreePath) {
        const receipt = yield* git
          .readWorktreePreparation(entry.snapshot.worktreePath)
          .pipe(Effect.orElseSucceed(() => null));
        if (receipt?.phase === "setup_running")
          yield* preparations
            .update(receipt, { phase: "setup_failed", error: "Setup cancelled before completion." })
            .pipe(Effect.ignoreCause({ log: true }));
      }
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
      const explicit =
        prepareWorktree.namingIntent === "explicit" ||
        (prepareWorktree.branch !== undefined && !isTemporaryWorktreeBranch(branch));
      if (
        explicit &&
        (!(yield* git.isValidBranchName(branch)) || /^t3code\/[0-9a-f]{8}$/i.test(branch))
      )
        return yield* new WorktreeSetupError({
          message: "Invalid branch name",
          code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
        });
      if (
        explicit &&
        ((yield* git.branchExists(projectCwd, branch)) ||
          (yield* preparations.branchReserved(yield* git.resolveCommonDir(projectCwd), branch)))
      )
        return yield* new WorktreeSetupError({
          message: `Branch \`${branch}\` already exists`,
          code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
        });
      const createdAt = createThread.createdAt;
      const operationId = crypto.randomUUID();
      const project = yield* projectFor(projectCwd);
      const runSetupScript =
        prepareWorktree.runSetupScript ??
        bootstrap.runSetupScript ??
        setupProjectScript(project?.scripts ?? []) !== null;

      let nameReservation:
        | import("../../persistence/Services/WorktreePreparations.ts").WorktreePreparationReceipt
        | null = null;
      if (explicit) {
        const common = yield* git.resolveCommonDir(projectCwd);
        nameReservation = yield* withRepositoryLifecycleLock(
          config.baseDir,
          common,
          Effect.gen(function* () {
            if (yield* git.branchExists(projectCwd, branch))
              return yield* new WorktreeSetupError({
                message: `Branch \`${branch}\` already exists`,
                code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
              });
            const destination = yield* git.allocateWorktreePath({ cwd: projectCwd, branch });
            return yield* preparations.allocate({
              operationId,
              repositoryIdentity: yield* Effect.promise(() => canonicalWorktreePath(common)),
              projectIdentity: yield* Effect.promise(() => canonicalWorktreePath(projectCwd)),
              owner: `thread:${threadId}`,
              requestedBase: prepareWorktree.baseBranch,
              baseOid: localBase,
              path: yield* Effect.promise(() => canonicalWorktreePath(destination)),
              branch,
              namingIntent: "explicit",
              setupIdentity: setupProjectScript(project?.scripts ?? [])?.command ?? null,
              runSetupScript,
            });
          }),
        ).pipe(
          Effect.mapError((error) =>
            Schema.is(WorktreeSetupError)(error)
              ? error
              : new WorktreeSetupError({
                  message: `Branch \`${branch}\` already has a preparation reservation: ${error.message}`,
                  code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
                }),
          ),
        );
      }
      const created = yield* engine
        .dispatch({
          type: "thread.create",
          commandId: serverCommandId("thread-create"),
          threadId,
          scheduledOrigin: createThread.scheduledOrigin,
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
          Effect.tapError((error) =>
            nameReservation && isDefinitelyUncommittedDispatchError(error)
              ? preparations
                  .update(nameReservation, { phase: "skipped", error: error.message })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void,
          ),
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
          if (nameReservation)
            yield* preparations
              .update(nameReservation, { phase: "skipped", error: message })
              .pipe(Effect.ignoreCause({ log: true }));
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
          runSetupScript,
          namingIntent: explicit ? "explicit" : "temporary",
          requireWorktree: prepareWorktree.requireWorktree === true,
        },
        baseRef: null,
        baseSha: null,
        worktreePath: nameReservation?.path ?? null,
        createdBranch: false,
        createdWorktree: false,
        setupScript: null,
        agentStarted: false,
        stages: WORKTREE_SETUP_STAGE_ORDER.map(emptyStage),
        error: null,
        ...(yield* nextGeneration(threadId)),
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
      yield* persistNow(threadId, true);
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
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(WorktreeSetupError)(error)
          ? error
          : new WorktreeSetupError({ message: error.message }),
      ),
    );

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

  const cancel = (threadId: ThreadId) =>
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
        yield* dispatchVerifiedWorkspace(engine, git, {
          type: "thread.meta.update",
          commandId: serverCommandId("meta-clear"),
          threadId,
          branch: (yield* git
            .inspectCheckoutIdentity(entry.snapshot.request.projectCwd)
            .pipe(Effect.mapError((error) => failFor(error.message)))).branch,
          worktreePath: null,
        }).pipe(Effect.ignoreCause({ log: true }));
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

  const retry = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (Option.isSome(transitions)) {
        const active = yield* transitions.value
          .getTransition({ threadId })
          .pipe(Effect.mapError((error) => failFor(error.message)));
        if (
          active &&
          ["reserved", "stopping", "applying", "applied", "needs_recovery"].includes(active.phase)
        )
          return yield* failFor("Resolve the workspace transition before retrying setup.");
      }
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
      let nextPath = snapshot.worktreePath;
      if (nextPath && !snapshot.createdWorktree && !existsSync(nextPath)) {
        const receipt = yield* git
          .readWorktreePreparation(nextPath)
          .pipe(Effect.mapError((error) => failFor(error.message)));
        if (
          receipt &&
          ["allocated", "skipped"].includes(receipt.phase) &&
          !(yield* git
            .branchExists(snapshot.request.projectCwd, receipt.branch)
            .pipe(Effect.mapError((error) => failFor(error.message)))) &&
          !(yield* git
            .listWorktrees(snapshot.request.projectCwd)
            .pipe(Effect.mapError((error) => failFor(error.message)))).some(
            (entry) => entry.canonicalPath === receipt.path,
          )
        ) {
          yield* preparations
            .update(receipt, { phase: "skipped", error: "Explicit retry before checkout." })
            .pipe(Effect.mapError((error) => failFor(error.message)));
          nextPath = null;
        }
      }
      const operationId = crypto.randomUUID();
      const startedAt = nowIso();
      entry.snapshot = {
        ...snapshot,
        worktreePath: nextPath,
        operationId,
        phase: "running",
        startedAt,
        endedAt: null,
        error: null,
        setupScript: null,
        stages: WORKTREE_SETUP_STAGE_ORDER.map(emptyStage),
        ...(yield* nextGeneration(threadId)),
        sequence: snapshot.sequence + 1,
      };
      yield* gate.register(threadId, operationId);
      yield* store
        .setWorktreeBlockToken({ threadId, token: operationId })
        .pipe(Effect.mapError((error) => failFor(error.message)));
      yield* store
        .setPaused({ threadId, paused: false })
        .pipe(Effect.mapError((error) => failFor(error.message)));
      yield* persistNow(threadId, true);
      pushNow(threadId);
      yield* fork(threadId, operationId);
      return entry.snapshot;
    });

  const finishLocalHandoff = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const existing = tracked.get(threadId);
      const snapshot = existing?.snapshot ?? (yield* readPersisted(threadId));
      if (!snapshot || Option.isNone(transitionStore)) return null;
      const transition = yield* transitionStore.value.get(`work-locally:${snapshot.operationId}`);
      if (
        transition?.phase !== "completed" ||
        transition.intent !== "use_project_checkout" ||
        transition.setupOwnerOperationId !== snapshot.operationId ||
        transition.result?.worktreePath !== null
      )
        return null;
      const entry = existing ?? track(snapshot);
      if (["cancelled", "cancelled_kept"].includes(entry.snapshot.phase)) return entry.snapshot;
      const currentThread = (yield* engine.getReadModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      const released =
        currentThread?.worktreePath === null &&
        currentThread.deletedAt === null &&
        currentThread.archivedAt === null
          ? yield* releaseCreated(entry.snapshot)
          : {
              kept: "The conversation changed workspace after the handoff; the old checkout was retained.",
            };
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
        .setWorktreeBlockToken({ threadId, token: null, expectedToken: entry.snapshot.operationId })
        .pipe(Effect.ignoreCause({ log: true }));
      const currentPause = (yield* store.listByThread(threadId)).state;
      if (
        (currentPause.worktreeBlockToken === null ||
          currentPause.worktreeBlockToken === entry.snapshot.operationId) &&
        currentPause.pauseReasonCode?.startsWith("worktree_setup")
      )
        yield* store
          .setPaused({ threadId, paused: false, expectedRevision: currentPause.revision })
          .pipe(Effect.mapError((error) => failFor(error.message)));
      yield* dispatcher.notify(threadId);
      return settled;
    }).pipe(Effect.mapError((error) => failFor(error.message)));

  const workLocally = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const completed = yield* finishLocalHandoff(threadId);
      if (completed) return completed;
      const entry = yield* load(threadId);
      if (!entry) return yield* failFor("No worktree setup for this thread.");
      if (entry.snapshot.agentStarted) {
        return yield* failFor("The agent already started in the worktree.");
      }
      const queued = yield* queueItem(entry.snapshot);
      if (queued === null) {
        return yield* failFor("The queued first turn is gone; send the message again.");
      }
      const previousPause = (yield* store.listByThread(threadId)).state;
      const keepPause =
        previousPause.paused && !previousPause.pauseReasonCode?.startsWith("worktree_setup");
      if (!keepPause)
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
        if (!keepPause)
          yield* store
            .setPaused({ threadId, paused: false })
            .pipe(Effect.ignoreCause({ log: true }));
        yield* commit(threadId, (current) => ({
          ...settle(current, "done", null),
          agentStarted: true,
        }));
        return yield* failFor("The agent already started in the worktree.");
      }
      if (Option.isNone(transitions))
        return yield* failFor("Workspace transitions are unavailable.");
      const thread = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null,
      );
      if (!thread) return yield* failFor("The conversation is unavailable.");
      const switched = yield* transitions.value
        .switchWorkspace(
          {
            operationId: `work-locally:${entry.snapshot.operationId}`,
            threadId,
            intent: "use_project_checkout",
            expected: {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              sessionUpdatedAt: thread.session?.updatedAt ?? null,
            },
          },
          entry.snapshot.operationId,
        )
        .pipe(Effect.mapError((error) => failFor(error.message)));
      if (switched.phase !== "completed")
        return yield* failFor(switched.error ?? "Inspect the interrupted workspace transition.");
      return yield* finishLocalHandoff(threadId);
    }).pipe(Effect.mapError((error) => failFor(error.message)));

  const startup: WorktreeSetupShape["startup"] = Effect.gen(function* () {
    // Owned setup scripts run in their own process group; stop them with the server.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...tracked.values()],
        (entry) => (entry.script ? entry.script.kill : Effect.void),
        { discard: true, concurrency: "unbounded" },
      ),
    );
    yield* preparation.startup;
    const rows = yield* sql<{ readonly threadId: ThreadId; readonly payload: string }>`
      SELECT thread_id AS "threadId", payload_json AS payload
      FROM projection_thread_activities
      WHERE kind = ${WORKTREE_SETUP_ACTIVITY_KIND}
    `.pipe(Effect.orElseSucceed(() => []));
    for (const row of rows) {
      const decoded = Option.getOrNull(decodeSnapshotJson(row.payload));
      if (decoded && (yield* finishLocalHandoff(row.threadId))) continue;
      if (decoded === null || decoded.phase !== "running" || tracked.has(row.threadId)) continue;
      const order = yield* nextGeneration(row.threadId);
      track({
        ...decoded,
        generation: order.generation,
        sequence: Math.max(order.sequence, decoded.sequence),
      });
      yield* persistNow(row.threadId, true);
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

  const actionLocks = new Map<ThreadId, { lock: Semaphore.Semaphore; users: number }>();
  const serialized =
    (action: typeof cancel): WorktreeSetupShape["cancel"] =>
    (threadId, expectedOperationId) =>
      Effect.suspend(() => {
        let entry = actionLocks.get(threadId);
        if (!entry) {
          entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
          actionLocks.set(threadId, entry);
        }
        entry.users++;
        const owned = entry;
        return entry.lock
          .withPermits(1)(
            Effect.gen(function* () {
              const current = yield* load(threadId);
              if (!current || current.snapshot.operationId !== expectedOperationId)
                return yield* failFor("This setup action is obsolete. Refresh and try again.");
              return yield* action(threadId);
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (--owned.users === 0) actionLocks.delete(threadId);
              }),
            ),
          );
      });
  yield* Effect.forkIn(
    Stream.runForEach(engine.streamDomainEvents, (event) => {
      if (event.type !== "thread.meta-updated" || event.payload.worktreePath !== null)
        return Effect.void;
      return Effect.gen(function* () {
        const entry = yield* load(event.payload.threadId);
        if (entry)
          yield* serialized(finishLocalHandoff)(event.payload.threadId, entry.snapshot.operationId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Setup workspace handoff will be reconciled on retry", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }),
    scope,
    { startImmediately: true },
  );
  return {
    start,
    get,
    cancel: serialized(cancel),
    retry: serialized(retry),
    workLocally: serialized(workLocally),
    ordering,
    changes: Stream.fromPubSub(changes),
    startup,
  } satisfies WorktreeSetupShape;
});

export const WorktreeSetupLive = Layer.effect(WorktreeSetup, makeWorktreeSetup);
