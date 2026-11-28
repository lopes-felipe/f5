import { timeOrderedUuid } from "@t3tools/shared/ids";
import {
  transitionIsActive,
  WorkspaceTransitions,
} from "../../persistence/Services/WorkspaceTransitions.ts";
import { WorkspaceTransition } from "../Services/WorkspaceTransition.ts";
import { dispatchVerifiedWorkspace } from "../workspaceTransitionContext.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import {
  placeholderBranchFor,
  resolvePlaceholderBranchAcross,
} from "../../git/placeholderBranch.ts";
import { readBranchNamePrefix } from "../branchNamePrefix.ts";
import { isPlaceholderBranch, canonicalWorktreePath } from "../../git/worktreePaths.ts";
import {
  INTERRUPTED_SCRIPT_RERUN,
  SETUP_SCRIPT_INTERRUPTED,
  SUBMODULES_INITIALIZING,
  SUBMODULES_UNFINISHED,
  submodulesUnfinished,
  WorktreePreparations,
  type PreparationError,
} from "../../persistence/Services/WorktreePreparations.ts";
import { WorktreePreparation } from "../Services/WorktreePreparation.ts";
import { readProjectSettings } from "../projectSettings.ts";
import { discoverConfiguredProjectRepositories } from "../discoverProjectRepositories.ts";
import {
  selectNestedWorktreeRepositories,
  nestedWorktreeOwner,
} from "../worktreeRepositoryPaths.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
import {
  buildFinalBranchName,
  PLACEHOLDER_BRANCH_RESERVED_MESSAGE,
} from "@t3tools/shared/branchNaming";
import {
  Cause,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";
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
import { isPossiblyStaleWorktreeBase, resolveWorktreeBase } from "../worktreeBase.ts";
import {
  WorktreeSetup,
  WorktreeSetupError,
  type WorktreeSetupShape,
} from "../Services/WorktreeSetup.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import {
  RepositoryBusyError,
  withRepositoryLifecycleLock,
  withWorktreeLifecycleLock,
  type RepositoryLifecycleError,
} from "./WorktreeLifecycleCoordinator.ts";

/** Live pushes coalesce to this interval; the durable activity to the persist interval. */
const PUSH_INTERVAL_MS = 100;
const PERSIST_INTERVAL_MS = 500;
const TURN_ACCEPT_POLL_MS = 250;
const SCRIPT_RERUN_POLL_MS = 500;

const SETUP_INTERRUPTED_BY_RESTART =
  "Worktree setup was interrupted by a server restart. Nothing was removed.";
/** The stage detail for a setup script that a restart cut off. */
const SCRIPT_INTERRUPTED_DETAIL = "interrupted by a restart";
/** First delay of the busy-repository retries. */
const REPOSITORY_BUSY_RETRY_MS = 1_000;

/**
 * Another F5 window or a background job holds the repository for a moment.
 * The lock already waits half a second; a first send is worth three more
 * tries, further apart, before it fails and asks for a retry by hand.
 */
const retryWhileRepositoryBusy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential(`${REPOSITORY_BUSY_RETRY_MS} millis`),
      while: (error) =>
        error instanceof RepositoryBusyError ||
        (error as { cause?: unknown } | null)?.cause instanceof RepositoryBusyError,
    }),
  );

interface Tracked {
  snapshot: WorktreeSetupSnapshot;
  /**
   * This run picks up a setup that a restart cut off. Nobody asked for it, so
   * it does not acknowledge what an interrupted script may have done.
   */
  resumed: boolean;
  /**
   * The setup script was running when the restart cut this setup off. A
   * worktree group without a checkout of its own has no receipt to say so.
   */
  scriptCutOff: boolean;
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
  CommandId.makeUnsafe(`server:worktree-setup:${tag}:${timeOrderedUuid()}`);

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

/**
 * Every worktree-setup activity, read once at startup. The kind is a SQL
 * literal, not a parameter: SQLite uses the partial index
 * `idx_projection_thread_activities_worktree_setup` only when the query text
 * matches the index predicate, and without it this scans every activity.
 */
export const WORKTREE_SETUP_STARTUP_ROWS_SQL = `
      SELECT thread_id AS "threadId", payload_json AS payload
      FROM projection_thread_activities
      WHERE kind = '${WORKTREE_SETUP_ACTIVITY_KIND.replaceAll("'", "''")}'`;

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
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
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
  /**
   * The server is stopping and is about to stop the setup scripts itself. A
   * script that ends this way did not fail: its setup stays as it was, and the
   * next start reports the script as interrupted.
   */
  let shuttingDown = false;
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
      resumed: false,
      scriptCutOff: false,
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
      const resumed = tracked.get(threadId)!.resumed;
      let request = initial.request;
      const started = Date.now();
      const project = yield* projectFor(request.projectCwd);
      const layoutCreate = project?.scripts.find(
        (script) => script.worktreeLayout === "create",
      )?.command;
      const nestedRepositories =
        project && Option.isSome(fileSystem)
          ? yield* discoverConfiguredProjectRepositories(project, git).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem.value),
            )
          : [];
      const plainGroup =
        project && nestedRepositories.length > 0 && !existsSync(join(request.projectCwd, ".git"));
      const selectedRepositories = yield* selectNestedWorktreeRepositories(
        nestedRepositories,
        request.repositoryPaths,
        !plainGroup,
      );
      const queued = yield* queueItem(initial);
      const namingSettings = project
        ? (yield* readProjectSettings(yield* settings.getSettings, project)).settings
        : null;
      const naming =
        !plainGroup &&
        !layoutCreate &&
        !initial.createdWorktree &&
        // Only a branch F5 created as a placeholder is renamed.
        (request.namingIntent ?? "temporary") === "temporary" &&
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
                  buildFinalBranchName({
                    prefix: namingSettings?.sourceControlWriting.branchNamePrefix,
                    type: result.type,
                    slug: result.branch,
                  }),
                ),
                Effect.orElseSucceed(() => null),
                Effect.forkIn(scope),
              )
          : null;
      const namingEntry = tracked.get(threadId);
      if (namingEntry) namingEntry.naming = naming;
      let worktreePath = initial.worktreePath;
      // The checkout is there but its submodules were never finished: a restart
      // or a failure came between the two. They are initialized below.
      let submodulesPending = false;
      if (!plainGroup && worktreePath && existsSync(worktreePath)) {
        const receipt = yield* git.readWorktreePreparation(worktreePath);
        if (receipt && receipt.owner === `thread:${threadId}`) {
          submodulesPending = submodulesUnfinished(receipt);
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
        if (plainGroup) {
          const first = selectedRepositories[0];
          if (!first || !git.prepareWorktreeGroup)
            return yield* failFor("Select at least one repository to create a worktree.");
          if (worktreePath === null) {
            // Every selected repository gets the same branch, so a placeholder must
            // be free in all of them. The name is recorded with the path for retries.
            if ((request.namingIntent ?? "temporary") === "temporary")
              request = {
                ...request,
                branch: yield* resolvePlaceholderBranchAcross(
                  git,
                  selectedRepositories.map((repository) => repository.path),
                  request.branch,
                ),
              };
            worktreePath = yield* git.allocateWorktreePath({
              cwd: first.path,
              branch: request.branch,
            });
          }
          const destination = worktreePath;
          const chosen = request;
          yield* commit(
            threadId,
            (snapshot) => ({ ...snapshot, worktreePath: destination, request: chosen }),
            true,
          );
          update(threadId, (snapshot) => stageStatus(snapshot, "checkout", "running"));
          yield* git
            .prepareWorktreeGroup({
              // Only a retry the user asked for vouches for a layout script
              // that may already have run.
              ...(layoutCreate
                ? { layoutCreate, retryLayout: initial.generation > 1 && !resumed }
                : {}),
              projectId: project.id,
              threadId,
              projectRoot: request.projectCwd,
              path: destination,
              branch: request.branch,
              baseBranch: request.baseBranch,
              repositories: nestedRepositories.map((repository) => repository.path),
              selected: selectedRepositories.map((repository) => repository.path),
            })
            .pipe(retryWhileRepositoryBusy);
          yield* commit(
            threadId,
            (snapshot) => stageStatus({ ...snapshot, createdWorktree: true }, "checkout", "done"),
            true,
          );
          yield* dispatchVerifiedWorkspace(engine, git, {
            type: "thread.meta.update",
            commandId: serverCommandId("meta"),
            threadId,
            branch: request.branch,
            worktreePath: destination,
          });
          return;
        }
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
            ["fetch", "checkout", ...(submodulesPending ? [] : ["submodules"])].reduce(
              (next, id) =>
                stageStatus(next, id as WorktreeSetupStageId, "skipped", "already prepared"),
              snapshot,
            ),
          );
          if (submodulesPending && worktreePath !== null) {
            const checkout = worktreePath;
            const revision = initial.checkoutSha ?? initial.baseSha;
            // With no setting to read, initialize them: the stage only skips
            // submodules a setting turned off.
            const policy =
              (revision
                ? yield* resolveSubmodules(project?.id ?? null, request.projectCwd, revision)
                : undefined) ?? "recursive";
            // Marked as the first attempt was, so another restart is read the same way.
            const pending = yield* preparations.latest(
              yield* Effect.promise(() => canonicalWorktreePath(checkout)),
            );
            const marked = pending
              ? yield* preparations.update(pending, {
                  phase: "setup_running",
                  result: SUBMODULES_INITIALIZING,
                  error: null,
                })
              : null;
            update(threadId, (snapshot) => stageStatus(snapshot, "submodules", "running"));
            // Initializing again is safe: Git skips the submodules that are in place.
            const initialized = yield* git
              .initializeWorktreeSubmodules(checkout, policy)
              .pipe(Effect.exit);
            if (marked) {
              const latest = yield* preparations.latest(marked.path);
              if (latest?.operationId === marked.operationId && latest.phase === "setup_running")
                yield* preparations.update(
                  latest,
                  initialized._tag === "Success"
                    ? { phase: "checkout_created", result: null, error: null }
                    : { phase: "setup_failed", result: null, error: SUBMODULES_UNFINISHED },
                );
            }
            if (initialized._tag === "Failure") {
              const failure = Cause.squash(initialized.cause);
              return yield* new WorktreeSetupError({
                message: `Submodules could not be initialized. ${failure instanceof Error ? failure.message : String(failure)}`,
              });
            }
            update(threadId, (snapshot) => stageStatus(snapshot, "submodules", "done"));
          }
        } else {
          update(threadId, (snapshot) => stageStatus(snapshot, "fetch", "running"));
          const base = yield* resolveWorktreeBase(git, {
            projectCwd: request.projectCwd,
            baseBranch: request.baseBranch,
            logAnnotations: { threadId },
          });
          // Warn only when the base may lack upstream work. A local-only or ahead
          // branch is the user's selection working as intended.
          update(threadId, (snapshot) =>
            stageStatus(
              snapshot,
              "fetch",
              isPossiblyStaleWorktreeBase(base.outcome)
                ? "warning"
                : base.outcome === "no-remote"
                  ? "skipped"
                  : "done",
              base.detail,
            ),
          );
          const { baseRef, baseSha } = base;
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
              // A placeholder must be free in the project and every selected member
              // repository. A retry whose worktree already exists keeps the name it
              // created, which was recorded with the path below.
              if (!generatedName && creationIntent === "temporary" && !initial.createdWorktree)
                checkoutBranch = yield* resolvePlaceholderBranchAcross(
                  git,
                  [
                    request.projectCwd,
                    ...selectedRepositories.map((repository) => repository.path),
                  ],
                  checkoutBranch,
                );
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
            // A busy repository is refused before anything above runs.
          ).pipe(retryWhileRepositoryBusy);
          if (worktreePath === null)
            return yield* new WorktreeSetupError({
              message: "The worktree path was not allocated.",
            });
          // This path, and the branch chosen for it, must survive a crash immediately
          // before or during worktree add: a retry then reuses both.
          request = { ...request, branch: checkoutBranch, namingIntent: creationIntent };
          const chosen = request;
          yield* commit(
            threadId,
            (snapshot) => ({ ...snapshot, worktreePath, request: chosen }),
            true,
          );
          const branchExists = yield* git.branchExists(request.projectCwd, checkoutBranch);

          update(threadId, (snapshot) => stageStatus(snapshot, "checkout", "running"));
          let checkoutTotal: number | null = null;
          const existingReceipt = yield* git.readWorktreePreparation(worktreePath);
          if (branchExists && !initial.createdWorktree)
            return yield* new WorktreeSetupError({
              message: `Branch \`${checkoutBranch}\` already exists. Inspect the retained preparation before retrying.`,
            });
          yield* git
            .createWorktree({
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
                  update(threadId, (snapshot) =>
                    stageStatus(snapshot, "submodules", status, detail),
                  ),
              },
            })
            .pipe(retryWhileRepositoryBusy);
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
        if (worktreePath && (selectedRepositories.length > 0 || layoutCreate)) {
          if (!project || !git.prepareWorktreeGroup)
            return yield* new WorktreeSetupError({
              message: "Worktree group setup is unavailable.",
            });
          yield* withWorktreeLifecycleLock(
            worktreePath,
            git.prepareWorktreeGroup({
              ...(layoutCreate
                ? { layoutCreate, retryLayout: initial.generation > 1 && !resumed }
                : {}),
              rooted: true,
              projectId: project.id,
              threadId,
              projectRoot: request.projectCwd,
              path: worktreePath,
              branch: request.branch,
              baseBranch: request.baseBranch,
              repositories: nestedRepositories.map(({ path }) => path),
              selected: selectedRepositories.map(({ path }) => path),
            }),
          );
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
      if (!receipt && !plainGroup) {
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
      const requestedScript =
        request.runSetupScript && project ? setupProjectScript(project.scripts) : null;
      // A restart cut the script off. A retry the user asked for acknowledges
      // what the script may already have done and runs it again. A run that
      // resumed on its own does not: a background script is left alone (the
      // agent starts, the stage carries a warning and the card offers to rerun
      // it), and a script the agent waits for is run again, once.
      const unattended =
        receipt?.phase === "setup_indeterminate" &&
        receipt.result !== SUBMODULES_INITIALIZING &&
        resumed;
      const agentWaits = requestedScript?.async === false;
      if (unattended && agentWaits && receipt?.result === INTERRUPTED_SCRIPT_RERUN)
        return yield* new WorktreeSetupError({
          message: "The setup script was interrupted twice. Retry to run it again.",
        });
      // An earlier resume already left the script alone and the server stopped
      // again before the agent started: it is still left alone.
      const leftAlone =
        resumed && receipt?.phase === "setup_failed" && receipt.error === SETUP_SCRIPT_INTERRUPTED;
      // A group without a checkout of its own has no receipt, so nothing counts
      // its reruns: a script a restart cut off is never run again unasked.
      const groupScriptCutOff =
        plainGroup === true && resumed && tracked.get(threadId)?.scriptCutOff === true;
      if (groupScriptCutOff && agentWaits)
        return yield* new WorktreeSetupError({
          message: "The setup script was interrupted by a restart. Retry to run it again.",
        });
      const leaveInterrupted = (unattended && !agentWaits) || leftAlone || groupScriptCutOff;
      if (receipt && receipt.phase === "setup_indeterminate")
        receipt = yield* preparations.update(
          receipt,
          leaveInterrupted
            ? { phase: "setup_failed", error: SETUP_SCRIPT_INTERRUPTED }
            : { phase: "checkout_created" },
        );
      const alreadyCompleted = receipt?.phase === "completed" || receipt?.phase === "skipped";
      if (
        receipt &&
        !alreadyCompleted &&
        requestedScript &&
        receipt.setupIdentity !== null &&
        receipt?.setupIdentity !== requestedScript.command &&
        // Only a retry the user asked for accepts a different command. A setup
        // that resumed on its own is a retry by generation, but nobody saw the
        // new command. A script that is left alone runs nothing either way.
        (initial.generation < 2 || resumed) &&
        !leaveInterrupted
      )
        return yield* new WorktreeSetupError({
          message:
            "The setup script changed. Inspect the retained preparation before retrying with a different script.",
        });
      if (receipt && !alreadyCompleted && !leaveInterrupted)
        receipt = yield* preparations.update(receipt, {
          phase: "setup_running",
          error: null,
          result: unattended ? INTERRUPTED_SCRIPT_RERUN : null,
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
        !alreadyCompleted && !leaveInterrupted && request.runSetupScript && project
          ? setupProjectScript(project.scripts)
          : null;
      if (leaveInterrupted) {
        update(threadId, (snapshot) =>
          stageStatus(
            requestedScript
              ? {
                  ...snapshot,
                  setupScript: {
                    name: requestedScript.name,
                    command: requestedScript.command,
                    async: true,
                  },
                }
              : snapshot,
            "setup-script",
            "warning",
            SCRIPT_INTERRUPTED_DETAIL,
          ),
        );
      } else if (script === null) {
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
        // Written before the script starts: after a restart this is what says
        // a script may have run, where no receipt does.
        yield* commit(
          threadId,
          (snapshot) =>
            stageStatus(
              {
                ...snapshot,
                setupScript: { name: script.name, command: script.command, async },
              },
              "setup-script",
              "running",
            ),
          true,
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
          // Stopped by the shutdown: record nothing and wait to be interrupted.
          Effect.flatMap((code) => (shuttingDown ? Effect.never : Effect.succeed(code))),
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
        if (
          selectedRepositories.length === 0 &&
          !layoutCreate &&
          Option.isSome(late) &&
          late.value &&
          (request.namingIntent ?? "temporary") === "temporary"
        ) {
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
          const group = git.readWorktreeGroup ? yield* git.readWorktreeGroup(worktreePath) : null;
          if (group && !group.root && group.threadId === snapshot.threadId) {
            const result = yield* removeWorktreeSafely({
              projectCwd: request.projectCwd,
              path: worktreePath,
              policy: { kind: "ownedRollback", ownThreadId: snapshot.threadId },
            }).pipe(Effect.provideServices(services));
            if (result.blockedReasons.length) return { kept: result.blockedReasons.join("; ") };
            for (const member of group.members) {
              const receipt = yield* git.readWorktreePreparation(member.path);
              if (
                receipt?.createdCheckout &&
                receipt.namingIntent !== "existing" &&
                receipt.owner === nestedWorktreeOwner(group.path) &&
                receipt.baseOid
              ) {
                yield* git
                  .deleteBranchIfAt({
                    cwd: member.source,
                    branch: group.branch,
                    expectedSha: receipt.baseOid,
                  })
                  .pipe(Effect.ignore);
              }
            }
            return { kept: null };
          }
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
      const registeredProject = yield* projectFor(projectCwd);
      const plainGroup =
        registeredProject &&
        git.prepareWorktreeGroup &&
        !existsSync(join(projectCwd, ".git")) &&
        Option.isSome(fileSystem) &&
        (yield* discoverConfiguredProjectRepositories(registeredProject, git).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem.value),
        )).length > 0;
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
      if (!plainGroup && (!isRepo || (localBase === null && !hasRemote))) {
        return {
          kind: "unavailable" as const,
          detail: !isRepo
            ? "A separate worktree requires a Git repository."
            : `A separate worktree requires a base branch with a commit; ${prepareWorktree.baseBranch} has none.`,
        };
      }
      const threadId = input.command.threadId;
      const branchPrefix = yield* readBranchNamePrefix(settings.getSettings, registeredProject);
      const explicit =
        prepareWorktree.namingIntent === "explicit" ||
        (prepareWorktree.branch !== undefined &&
          !isPlaceholderBranch(prepareWorktree.branch, branchPrefix));
      const branch = explicit
        ? (prepareWorktree.branch ?? "")
        : placeholderBranchFor({
            requested: prepareWorktree.branch,
            prefix: branchPrefix,
            sourceText: input.command.message.text,
          }).branch;
      if (explicit && isPlaceholderBranch(branch, branchPrefix))
        return yield* new WorktreeSetupError({
          message: PLACEHOLDER_BRANCH_RESERVED_MESSAGE,
          code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
        });
      if (explicit && !(yield* git.isValidBranchName(branch)))
        return yield* new WorktreeSetupError({
          message: "Invalid branch name",
          code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
        });
      if (
        explicit &&
        !plainGroup &&
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
      if (explicit && !plainGroup) {
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
                  // A busy repository says nothing about the branch name.
                  message:
                    error instanceof RepositoryBusyError
                      ? error.message
                      : `Branch \`${branch}\` already has a preparation reservation: ${error.message}`,
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

      const itemId = CommandId.makeUnsafe(timeOrderedUuid());
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
          ...(prepareWorktree.repositoryPaths
            ? { repositoryPaths: prepareWorktree.repositoryPaths }
            : {}),
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
      // The setup is finished and only its script is still running, in the
      // background or because it was asked for again: stop the script. The
      // agent keeps the worktree, and the script's own completion reports it.
      if (
        snapshot.phase === "done" &&
        snapshot.stages.some((stage) => stage.id === "setup-script" && stage.status === "running")
      ) {
        if (entry.script) yield* entry.script.kill;
        if (snapshot.worktreePath) yield* preparation.stopScript(snapshot.worktreePath);
        return entry.snapshot;
      }
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

  /**
   * Runs the setup again from where its receipts say it stopped. `resumed` is
   * the server picking up a setup a restart cut off; without it the user asked.
   */
  const retry = (threadId: ThreadId, resumed = false) =>
    Effect.gen(function* () {
      if (Option.isSome(transitions)) {
        const active = yield* transitions.value
          .getTransition({ threadId })
          .pipe(Effect.mapError((error) => failFor(error.message)));
        if (active && transitionIsActive(active))
          return yield* failFor("Wait for the workspace switch to finish before retrying setup.");
      }
      const entry = yield* load(threadId);
      if (!entry) return yield* failFor("No worktree setup to retry.");
      // Asking for the retry acknowledges whatever an interrupted script did.
      if (!resumed) entry.scriptCutOff = false;
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
      entry.resumed = resumed;
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

  const settleLocalHandoff = (threadId: ThreadId, entry: Tracked) =>
    Effect.gen(function* () {
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
      return yield* settleLocalHandoff(threadId, existing ?? track(snapshot));
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
      const thread = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null,
      );
      if (!thread) return yield* failFor("The conversation is unavailable.");
      const group =
        entry.snapshot.worktreePath && git.readWorktreeGroup
          ? yield* git.readWorktreeGroup(entry.snapshot.worktreePath)
          : null;
      if (group && !group.root && group.threadId === threadId) {
        if (
          thread.session ||
          (thread.worktreePath !== null && thread.worktreePath !== entry.snapshot.worktreePath)
        )
          return yield* failFor(
            "The conversation changed workspace. Refresh before switching locally.",
          );
        if (thread.worktreePath !== null)
          yield* dispatchVerifiedWorkspace(
            engine,
            git,
            {
              type: "thread.meta.update",
              commandId: serverCommandId("plain-local-handoff"),
              threadId,
              worktreePath: null,
              branch: null,
              expectedWorktreePath: thread.worktreePath,
              expectedBranch: thread.branch,
            },
            { allowMissing: true },
          );
        return yield* settleLocalHandoff(threadId, entry);
      }
      if (Option.isNone(transitions))
        return yield* failFor("Workspace transitions are unavailable.");
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
        return yield* failFor(
          switched.error ?? "Moving to the project folder did not finish. Try again.",
        );
      return yield* finishLocalHandoff(threadId);
    }).pipe(Effect.mapError((error) => failFor(error.message)));

  /** A script that a restart cut off becomes a reported failure, which holds no send. */
  const releaseInterruptedScript = (worktreePath: string) =>
    Effect.gen(function* () {
      const receipt = yield* preparations.latest(
        yield* Effect.promise(() => canonicalWorktreePath(worktreePath)),
      );
      if (receipt?.phase === "setup_indeterminate")
        yield* preparations.update(receipt, {
          phase: "setup_failed",
          error: SETUP_SCRIPT_INTERRUPTED,
        });
    }).pipe(Effect.ignoreCause({ log: true }));

  /**
   * Runs the setup script again in a worktree whose setup already finished,
   * after the script failed or a restart cut it off. Asking for it is the
   * acknowledgement that the earlier run may have had effects of its own.
   */
  const rerunScript = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const entry = yield* load(threadId);
      if (!entry) return yield* failFor("No worktree setup to run again.");
      const snapshot = entry.snapshot;
      const worktreePath = snapshot.worktreePath;
      const stage = snapshot.stages.find((candidate) => candidate.id === "setup-script");
      if (
        snapshot.phase !== "done" ||
        worktreePath === null ||
        (stage?.status !== "warning" && stage?.status !== "failed")
      )
        return yield* failFor("There is no interrupted or failed setup script to run again.");
      const thread = (yield* engine.getReadModel()).threads.find(
        (candidate) => candidate.id === threadId && candidate.deletedAt === null,
      );
      const receiptPath = yield* Effect.promise(() => canonicalWorktreePath(worktreePath));
      if (
        !thread ||
        thread.worktreePath === null ||
        thread.branch === null ||
        (yield* Effect.promise(() => canonicalWorktreePath(thread.worktreePath!))) !== receiptPath
      )
        return yield* failFor("This thread is no longer in the worktree that was set up.");
      // Say so when there is nothing to run, instead of reporting a run that never happened.
      const project = (yield* engine.getReadModel()).projects.find(
        (candidate) => candidate.id === thread.projectId && candidate.deletedAt === null,
      );
      if (!project || !setupProjectScript(project.scripts))
        return yield* failFor("This project has no setup script to run.");
      const recorded = yield* preparations
        .latest(receiptPath)
        .pipe(Effect.mapError((error) => failFor(error.message)));
      // A worktree group without a checkout of its own keeps no receipt.
      if (!recorded)
        return yield* failFor(
          "This worktree keeps no record of its setup, so the script cannot be run again from here. Run it in a terminal.",
        );
      if (!recorded.runSetupScript)
        return yield* failFor("The setup script was skipped for this worktree.");
      if (recorded.phase === "completed" || recorded.phase === "skipped")
        return yield* failFor("The setup script already finished in this worktree.");
      if (recorded.phase === "setup_running")
        return yield* failFor("The setup script is already running in this worktree.");
      const input = {
        threadId,
        projectId: thread.projectId,
        worktreePath,
        branch: thread.branch,
        retry: true,
      };
      const running = yield* commit(threadId, (current) =>
        withStage(stageStatus(current, "setup-script", "running", null), "setup-script", (row) => ({
          ...row,
          startedAt: nowIso(),
          tail: [],
        })),
      );
      yield* Effect.gen(function* () {
        const outcome = yield* preparation.prepare(input).pipe(Effect.exit);
        // A background script is handed off, so its receipt says when it ends.
        // The wait lasts only while the script is really running: a receipt
        // that was never updated must not keep this polling.
        let receipt = yield* preparations.latest(receiptPath);
        while (
          receipt?.phase === "setup_running" &&
          (yield* preparation.scriptRunning(receiptPath))
        ) {
          yield* Effect.sleep(`${SCRIPT_RERUN_POLL_MS} millis`);
          receipt = yield* preparations.latest(receiptPath);
        }
        // The script is unlisted after its outcome is written: read that.
        receipt = yield* preparations.latest(receiptPath);
        // The server is stopping. The stage stays as it is, and the next start
        // reports the script as interrupted by a restart.
        if (shuttingDown) return;
        if (receipt?.phase === "setup_indeterminate") {
          yield* releaseInterruptedScript(worktreePath);
          yield* commit(threadId, (current) =>
            stageStatus(current, "setup-script", "warning", SCRIPT_INTERRUPTED_DETAIL),
          );
          return;
        }
        // The script ended and its outcome could not be written. Record one,
        // so the receipt does not refuse every later run.
        if (receipt?.phase === "setup_running")
          receipt = yield* preparations.update(receipt, {
            phase: "setup_failed",
            error: "The setup script ended without reporting how it finished.",
          });
        const failure =
          outcome._tag === "Failure"
            ? Cause.squash(outcome.cause)
            : receipt?.phase === "completed" || receipt?.phase === "skipped"
              ? null
              : (receipt?.error ?? "The setup script failed.");
        const reason =
          failure === null ? null : failure instanceof Error ? failure.message : String(failure);
        const tail = Option.getOrElse(
          Schema.decodeUnknownOption(
            Schema.fromJsonString(Schema.Struct({ outputTail: Schema.Array(Schema.String) })),
          )(receipt?.result),
          () => ({ outputTail: [] as ReadonlyArray<string> }),
        ).outputTail;
        yield* commit(threadId, (current) =>
          withStage(
            stageStatus(
              current,
              "setup-script",
              reason === null ? "done" : "failed",
              reason === null ? null : (reason.split("\n")[0] ?? reason),
            ),
            "setup-script",
            (row) => ({ ...row, tail: tail.slice(-WORKTREE_SETUP_TAIL_LINES) }),
          ),
        );
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));
      return running;
    });

  const startup: WorktreeSetupShape["startup"] = Effect.gen(function* () {
    // Owned setup scripts run in their own process group; stop them with the server.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        shuttingDown = true;
        return Effect.forEach(
          [...tracked.values()],
          (entry) => (entry.script ? entry.script.kill : Effect.void),
          { discard: true, concurrency: "unbounded" },
        );
      }),
    );
    yield* preparation.startup;
    const rows = yield* sql
      .unsafe<{
        readonly threadId: ThreadId;
        readonly payload: string;
      }>(WORKTREE_SETUP_STARTUP_ROWS_SQL)
      .pipe(Effect.orElseSucceed(() => []));
    for (const row of rows) {
      const decoded = Option.getOrNull(decodeSnapshotJson(row.payload));
      if (decoded && (yield* finishLocalHandoff(row.threadId))) continue;
      if (decoded === null || tracked.has(row.threadId)) continue;
      const scriptWasRunning = decoded.stages.some(
        (stage) => stage.id === "setup-script" && stage.status === "running",
      );
      // A finished setup whose script was being run again when the server stopped.
      const rerunCutOff = decoded.phase === "done" && scriptWasRunning;
      if (decoded.phase !== "running" && !rerunCutOff) continue;
      const order = yield* nextGeneration(row.threadId);
      track({
        ...decoded,
        generation: order.generation,
        sequence: Math.max(order.sequence, decoded.sequence),
      });
      yield* persistNow(row.threadId, true);
      if (decoded.agentStarted || rerunCutOff) {
        // The agent is already working; only a background script can have
        // been cut off. Say so, and stop its receipt from holding later sends.
        if (scriptWasRunning && decoded.worktreePath)
          yield* releaseInterruptedScript(decoded.worktreePath);
        yield* commit(row.threadId, (snapshot) => {
          const marked = scriptWasRunning
            ? stageStatus(snapshot, "setup-script", "warning", SCRIPT_INTERRUPTED_DETAIL)
            : snapshot;
          return rerunCutOff ? marked : settle(marked, "done", null);
        });
        continue;
      }
      // The agent has not started, so nothing is lost by carrying on: the
      // receipts say which steps are done, and those are not repeated.
      const entry = tracked.get(row.threadId);
      if (entry) {
        entry.snapshot = settle(entry.snapshot, "failed", SETUP_INTERRUPTED_BY_RESTART);
        entry.scriptCutOff = scriptWasRunning;
      }
      const resumed = yield* retry(row.threadId, true).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("worktree setup could not resume after a restart", {
            threadId: row.threadId,
            message: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
      if (resumed) continue;
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
    retry: serialized((threadId) => retry(threadId)),
    workLocally: serialized(workLocally),
    rerunScript: serialized(rerunScript),
    ordering,
    changes: Stream.fromPubSub(changes),
    startup,
  } satisfies WorktreeSetupShape;
});

export const WorktreeSetupLive = Layer.effect(WorktreeSetup, makeWorktreeSetup);
