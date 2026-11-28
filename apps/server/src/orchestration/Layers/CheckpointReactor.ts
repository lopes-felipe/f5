import { timeOrderedUuid } from "@t3tools/shared/ids";
import { AcceptedShutdownWork, registerShutdown } from "../../shutdown.ts";
import {
  nestedCheckpointPaths,
  pruneRepositoryCheckpointRefs,
  restoreCheckpointRepositories,
  scopedCheckpointRef,
  checkpointWorkspaceRepositories,
} from "../../checkpointing/checkpointRepositories.ts";
import { syncObservedBranch } from "../../project/observedBranch.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeConversationRewind } from "../rewind.ts";
import { GitService } from "../../git/Services/GitService.ts";
import type { CaptureCheckpointInput } from "../../checkpointing/Services/CheckpointStore.ts";
import {
  CommandId,
  EventId,
  MessageId,
  type ProjectId,
  type ProjectRepository,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Cause, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { clearWorkspaceIndexCache } from "../../workspaceEntries.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { resolveTurnAssistantMessage } from "../turnAssistantMessage.ts";
import { listWorkspaceRepositories } from "../../project/discoverProjectRepositories.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.makeUnsafe(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

interface CheckpointFingerprint {
  readonly turnCount: number;
  readonly commitOid: string;
  readonly fingerprint: string;
}

const CHECKPOINT_FINGERPRINT_CACHE_SIZE = 4_096;
/** Full captures before a repository whose fingerprint was not worthwhile is measured again. */
const CHECKPOINT_FINGERPRINT_REPROBE_AFTER = 20;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${timeOrderedUuid()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const git = yield* GitService;
  const workspaceGit = yield* Effect.serviceOption(GitCore);
  const receiptBus = yield* RuntimeReceiptBus;
  const turns = yield* ProjectionTurnRepository;
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const conversationRewind = Option.isSome(sqlOption)
    ? yield* makeConversationRewind.pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOption.value),
      )
    : { run: () => Effect.void, recover: Effect.void };

  const markTurnProcessingQuiesced = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly createdAt: string;
    readonly checkpointTurnCount?: number | undefined;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.turn.processing.quiesce",
        commandId: CommandId.makeUnsafe(
          `server:turn-processing-quiesced:${input.threadId}:${input.turnId}`,
        ),
        threadId: input.threadId,
        turnId: input.turnId,
        processingQuiescedAt: input.createdAt,
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.andThen(
          receiptBus.publish({
            type: "turn.processing.quiesced",
            threadId: input.threadId,
            turnId: input.turnId,
            ...(input.checkpointTurnCount !== undefined
              ? { checkpointTurnCount: input.checkpointTurnCount }
              : {}),
            createdAt: input.createdAt,
          }),
        ),
      );

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(timeOrderedUuid()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
    readonly checkpointSaved?: boolean;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(timeOrderedUuid()),
        tone: input.checkpointSaved ? "info" : "error",
        kind: "checkpoint.capture.failed",
        summary: input.checkpointSaved
          ? "Checkpoint saved; diff summary unavailable"
          : "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const resolveSessionRuntimeForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);

    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
      if (!session?.cwd) {
        return Option.none();
      }
      return Option.some({ threadId: session.threadId, cwd: session.cwd });
    };

    if (thread) {
      const projectedSession = sessions.find((session) => session.threadId === thread.id);
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) {
        return fromProjected;
      }
    }

    return Option.none();
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // A plain workspace may still contain repositories.
  const resolveCheckpointCwd = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    return cwd;
  });

  const turnRepositories = new Map<
    ThreadId,
    { cwd: string; turnCount: number; repositories: ReadonlyArray<ProjectRepository> }
  >();
  const resolveCheckpointRepositories = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly cwd: string;
    readonly terminal?: boolean;
    readonly project:
      | {
          readonly id: ProjectId;
          readonly workspaceRoot: string;
          readonly kind?: string | undefined;
        }
      | undefined;
  }) {
    const cached = turnRepositories.get(input.threadId);
    if (cached?.cwd === input.cwd && cached.turnCount === input.turnCount) {
      if (
        input.terminal &&
        cached.repositories.length === 0 &&
        (yield* checkpointStore.isGitRepository(input.cwd))
      ) {
        return [{ path: input.cwd, relativePath: "." }];
      }
      return cached.repositories;
    }
    const discovered =
      input.project && !isScratchProject(input.project) && Option.isSome(fileSystem)
        ? yield* listWorkspaceRepositories(
            input.project,
            input.cwd,
            Option.getOrUndefined(workspaceGit),
          ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem.value))
        : [];
    const repositories =
      discovered.length === 0 && (yield* checkpointStore.isGitRepository(input.cwd))
        ? [{ path: input.cwd, relativePath: "." }]
        : checkpointWorkspaceRepositories(discovered);
    turnRepositories.delete(input.threadId);
    turnRepositories.set(input.threadId, {
      cwd: input.cwd,
      turnCount: input.turnCount,
      repositories,
    });
    if (turnRepositories.size > 256) turnRepositories.delete(turnRepositories.keys().next().value!);
    return repositories;
  });

  /**
   * The workspace fingerprint each thread's latest checkpoint was captured from, per
   * repository. A later capture whose fingerprint is unchanged points its ref at that
   * commit instead of re-scanning the worktree, which in a large repository takes
   * seconds. Entries are only an optimization: an empty map (after a restart) or a
   * missing entry means a full capture.
   */
  const checkpointFingerprints = new Map<string, CheckpointFingerprint>();
  const rememberCheckpointFingerprint = (key: string, entry: CheckpointFingerprint | undefined) => {
    checkpointFingerprints.delete(key);
    if (entry === undefined) return;
    checkpointFingerprints.set(key, entry);
    if (checkpointFingerprints.size > CHECKPOINT_FINGERPRINT_CACHE_SIZE)
      checkpointFingerprints.delete(checkpointFingerprints.keys().next().value!);
  };
  const fingerprintCheckpointWorkspace = (
    input: Pick<CaptureCheckpointInput, "cwd" | "excludePaths"> & { readonly commitOid?: string },
  ) =>
    checkpointStore
      .fingerprintWorkspace({
        cwd: input.cwd,
        ...(input.excludePaths ? { excludePaths: input.excludePaths } : {}),
        ...(input.commitOid ? { commitOid: input.commitOid } : {}),
      })
      .pipe(Effect.orElseSucceed(() => null));
  /** Last measured fingerprint and capture times per repository path. */
  const checkpointCosts = new Map<
    string,
    { fingerprintMs: number; captureMs: number; skipped: number }
  >();
  const rememberCheckpointCost = (
    repositoryPath: string,
    measured: { readonly captureMs: number; readonly fingerprintMs?: number },
  ) => {
    const previous = checkpointCosts.get(repositoryPath);
    checkpointCosts.delete(repositoryPath);
    checkpointCosts.set(repositoryPath, {
      captureMs: measured.captureMs,
      fingerprintMs: measured.fingerprintMs ?? previous?.fingerprintMs ?? 0,
      skipped: measured.fingerprintMs === undefined ? (previous?.skipped ?? 0) : 0,
    });
    if (checkpointCosts.size > CHECKPOINT_FINGERPRINT_CACHE_SIZE)
      checkpointCosts.delete(checkpointCosts.keys().next().value!);
  };
  /** Fingerprint confirmations waiting until each thread's turn has quiesced. */
  const pendingFingerprintSettles = new Map<ThreadId, Array<Effect.Effect<void>>>();
  const runPendingFingerprintSettles = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const settles = pendingFingerprintSettles.get(threadId) ?? [];
      pendingFingerprintSettles.delete(threadId);
      return Effect.forEach(settles, (settle) => settle, { concurrency: 4, discard: true });
    });

  /**
   * Captures one repository's checkpoint for `turnCount`. When the workspace fingerprint
   * matches the one recorded for this thread's previous checkpoint, the new ref reuses
   * that commit. Like a non-Git workspace, one its repository ignores gets no checkpoint
   * ("unsupported") instead of a capture failure on every turn.
   */
  const captureRepositoryCheckpoint = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly repository: ProjectRepository;
    readonly repositories: ReadonlyArray<ProjectRepository>;
    readonly turnCount: number;
  }) {
    const key = `${input.threadId}\0${input.repository.path}`;
    const capture = {
      cwd: input.repository.path,
      checkpointRef: scopedCheckpointRef(
        checkpointRefForThreadTurn(input.threadId, input.turnCount),
        input.repository,
      ),
      excludePaths: nestedCheckpointPaths(input.repository, input.repositories, "capture"),
    };
    // Where listing the workspace costs about as much as capturing it (no fsmonitor or
    // untracked cache in a large repository), fingerprinting only adds time. Such a
    // repository is captured in full and measured again every so often.
    const cost = checkpointCosts.get(input.repository.path);
    const fingerprintWorthwhile =
      cost === undefined ||
      cost.fingerprintMs * 2 <= cost.captureMs ||
      cost.skipped >= CHECKPOINT_FINGERPRINT_REPROBE_AFTER;
    if (!fingerprintWorthwhile) cost.skipped += 1;
    const fingerprintStartedAt = Date.now();
    const fingerprint = fingerprintWorthwhile
      ? yield* fingerprintCheckpointWorkspace(capture)
      : null;
    const fingerprintMs = Date.now() - fingerprintStartedAt;
    const known = checkpointFingerprints.get(key);
    if (
      fingerprint !== null &&
      known !== undefined &&
      known.turnCount === input.turnCount - 1 &&
      known.fingerprint === fingerprint
    ) {
      const reused = yield* checkpointStore
        .reuseCheckpoint({
          cwd: capture.cwd,
          sourceRef: scopedCheckpointRef(
            checkpointRefForThreadTurn(input.threadId, known.turnCount),
            input.repository,
          ),
          sourceOid: known.commitOid,
          targetRef: capture.checkpointRef,
        })
        .pipe(Effect.orElseSucceed(() => false));
      // The reused commit's message still names the earlier turn's ref; nothing reads it.
      if (reused) {
        rememberCheckpointFingerprint(key, { ...known, turnCount: input.turnCount });
        return { outcome: "reused" as const, settle: Effect.void };
      }
    }
    const captureStartedAt = Date.now();
    const result = yield* checkpointStore.captureCheckpoint(capture).pipe(
      Effect.map(Option.some),
      Effect.catchTag("CheckpointUnsupportedError", () => Effect.succeed(Option.none())),
      Effect.tapError(() => Effect.sync(() => rememberCheckpointFingerprint(key, undefined))),
    );
    rememberCheckpointFingerprint(key, undefined);
    if (Option.isNone(result)) return { outcome: "unsupported" as const, settle: Effect.void };
    rememberCheckpointCost(input.repository.path, {
      captureMs: Date.now() - captureStartedAt,
      ...(fingerprintWorthwhile ? { fingerprintMs } : {}),
    });
    if (fingerprint === null || !result.value.reusable)
      return { outcome: "captured" as const, settle: Effect.void };
    const { commitOid } = result.value;
    // Only decides whether the next capture may reuse this commit, so callers run it off
    // the turn's critical path. The fingerprint is kept only when the workspace still
    // lists the same state and the commit changes exactly the listed paths, so an edit
    // made and undone during the capture cannot attach the wrong commit to it.
    const settle = fingerprintCheckpointWorkspace({ ...capture, commitOid }).pipe(
      Effect.map((settled) => {
        if (settled === fingerprint)
          rememberCheckpointFingerprint(key, {
            turnCount: input.turnCount,
            commitOid,
            fingerprint,
          });
      }),
    );
    return { outcome: "captured" as const, settle };
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly worktreePath: string | null;
      readonly branch: string | null;
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
        readonly text: string;
        readonly streaming: boolean;
      }>;
    };
    readonly cwd: string;
    readonly repositories: ReadonlyArray<ProjectRepository>;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const startedAt = Date.now();
    const outcomes = yield* Effect.forEach(
      input.repositories,
      (repository) =>
        captureRepositoryCheckpoint({
          threadId: input.threadId,
          repository,
          repositories: input.repositories,
          turnCount: input.turnCount,
        }).pipe(Effect.map((result) => ({ repository, ...result }))),
      { concurrency: 4 },
    );
    // Confirmed once the turn has quiesced, so the queue does not wait on them.
    pendingFingerprintSettles.set(
      input.threadId,
      outcomes.map((entry) => entry.settle),
    );
    const captured = outcomes
      .filter((entry) => entry.outcome !== "unsupported")
      .map((entry) => entry.repository);
    // A reused checkpoint is the previous turn's commit, verified in the same ref
    // transaction: its baseline exists and its diff is empty by construction.
    const reused = new Set(
      outcomes.filter((entry) => entry.outcome === "reused").map((entry) => entry.repository.path),
    );
    yield* Effect.logDebug("checkpoint repositories captured", {
      threadId: input.threadId,
      turnCount: input.turnCount,
      reused: reused.size,
      captured: captured.length - reused.size,
      elapsedMs: Date.now() - startedAt,
    });
    if (captured.length === 0) return false;

    const withBaseline = yield* Effect.filter(
      captured,
      (repository) =>
        reused.has(repository.path)
          ? Effect.succeed(true)
          : checkpointStore
              .hasCheckpointRef({
                cwd: repository.path,
                checkpointRef: scopedCheckpointRef(fromCheckpointRef, repository),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("checkpoint baseline lookup failed", {
                    threadId: input.threadId,
                    checkpointRef: fromCheckpointRef,
                    repository: repository.relativePath,
                    category: error._tag,
                    detail: error.message,
                  }).pipe(Effect.as(false)),
                ),
              ),
      { concurrency: 4 },
    );
    if (captured.length !== withBaseline.length) {
      yield* appendCaptureFailureActivity({
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: input.createdAt,
        checkpointSaved: true,
        detail:
          "The checkpoint was saved, but its diff summary is unavailable because the pre-turn baseline is missing or could not be read. This does not mean no files changed.",
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to publish checkpoint summary warning", {
            detail: error.message,
          }),
        ),
      );
    }

    // The turn may have switched branches; the thread follows its folder.
    if (Option.isSome(workspaceGit))
      yield* syncObservedBranch(
        { engine: orchestrationEngine, git: workspaceGit.value },
        input.threadId,
      );

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
    clearWorkspaceIndexCache(input.cwd);

    const files = yield* Effect.forEach(
      withBaseline.filter((repository) => !reused.has(repository.path)),
      (repository) =>
        checkpointStore
          .diffCheckpoints({
            cwd: repository.path,
            fromCheckpointRef: scopedCheckpointRef(fromCheckpointRef, repository),
            toCheckpointRef: scopedCheckpointRef(targetCheckpointRef, repository),
            fallbackFromToHead: false,
            // Only the per-file totals are kept, so the patch needs no minimization.
            options: {
              excludeGitImports: true,
              minimal: false,
              ...(repository.relativePath === "."
                ? {}
                : { repositoryPath: repository.relativePath }),
            },
          })
          .pipe(
            Effect.map((diff) =>
              parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
                path: file.path,
                kind: "modified" as const,
                additions: file.additions,
                deletions: file.deletions,
                ...(input.repositories.length > 1
                  ? { repositoryPath: repository.relativePath }
                  : {}),
              })),
            ),
          ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((files) => files.flat()),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          checkpointSaved: true,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const assistantMessageId =
      resolveTurnAssistantMessage(input.thread.messages, input.turnId)?.id ??
      input.assistantMessageId ??
      MessageId.makeUnsafe(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(timeOrderedUuid()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
    return true;
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointForTerminalTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly createdAt: string;
    readonly status: "ready" | "missing" | "error";
  }) {
    const turnId = input.turnId;

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread) {
      return;
    }

    // When a primary turn is active, only that turn may produce completion checkpoints.
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      return;
    }

    // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
    // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
    // before this reactor runs; those must not prevent real git capture.
    const captured = thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
    );
    if (captured) {
      // The runtime event may capture before ingestion publishes the terminal
      // session. Its durable fallback must still report the checkpoint count.
      return captured.checkpointTurnCount;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    // If a placeholder checkpoint exists for this turn, reuse its turn count
    // instead of incrementing past it.
    const existingPlaceholder = thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
    );
    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const nextTurnCount = existingPlaceholder
      ? existingPlaceholder.checkpointTurnCount
      : currentTurnCount + 1;
    const repositories = yield* resolveCheckpointRepositories({
      cwd: checkpointCwd,
      threadId: thread.id,
      turnCount: nextTurnCount - 1,
      terminal: true,
      project: readModel.projects.find((project) => project.id === thread.projectId),
    });

    const supported = yield* captureAndDispatchCheckpoint({
      threadId: thread.id,
      turnId,
      thread,
      cwd: checkpointCwd,
      repositories,
      turnCount: nextTurnCount,
      status: input.status,
      assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
      createdAt: input.createdAt,
    });
    turnRepositories.delete(input.threadId);
    return supported ? nextTurnCount : undefined;
  });

  interface SettleTerminalTurnInput {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly createdAt: string;
    readonly status: "ready" | "missing" | "error";
    readonly checkpointProcessed?: boolean | undefined;
    readonly checkpointTurnCount?: number | undefined;
  }
  // Fingerprint confirmations run after quiescence, which is what the queue waits on.
  const settleTerminalTurnProcessing = (input: SettleTerminalTurnInput) =>
    quiesceTerminalTurn(input).pipe(Effect.ensuring(runPendingFingerprintSettles(input.threadId)));

  const quiesceTerminalTurn = Effect.fnUntraced(function* (input: SettleTerminalTurnInput) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const row = readModel.threads.find((thread) => thread.id === input.threadId)?.latestTurn;
    if (
      !row ||
      row.turnId !== input.turnId ||
      row.state === "running" ||
      (row.processingQuiescedAt !== null && row.processingQuiescedAt !== undefined)
    ) {
      return;
    }
    const checkpointTurnCount = input.checkpointProcessed
      ? input.checkpointTurnCount
      : yield* captureCheckpointForTerminalTurn(input).pipe(
          Effect.catch((error) =>
            appendCaptureFailureActivity({
              threadId: input.threadId,
              turnId: input.turnId,
              detail: error.message,
              createdAt: input.createdAt,
            }).pipe(
              Effect.catch(() => Effect.void),
              Effect.as(undefined),
            ),
          ),
        );
    yield* markTurnProcessingQuiesced({
      threadId: input.threadId,
      turnId: input.turnId,
      createdAt: input.createdAt,
      ...(checkpointTurnCount !== undefined ? { checkpointTurnCount } : {}),
    });
  });

  const ensurePreTurnBaseline = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) return;
    const cwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: false,
    });
    if (!cwd) return;
    const turnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const repositories = yield* resolveCheckpointRepositories({
      cwd,
      threadId,
      turnCount,
      project: readModel.projects.find((project) => project.id === thread.projectId),
    });
    const checkpointRef = checkpointRefForThreadTurn(threadId, turnCount);
    const captured = yield* Effect.forEach(
      repositories,
      Effect.fnUntraced(function* (repository) {
        const input = {
          cwd: repository.path,
          checkpointRef: scopedCheckpointRef(checkpointRef, repository),
        };
        if (yield* checkpointStore.hasCheckpointRef(input)) return false;
        // Also records the fingerprint, so a new thread's first turn can reuse it.
        const { outcome, settle } = yield* captureRepositoryCheckpoint({
          threadId,
          repository,
          repositories,
          turnCount,
        });
        yield* settle;
        return outcome !== "unsupported";
      }),
      { concurrency: 4 },
    );
    if (!captured.some(Boolean)) return;
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: turnCount,
      checkpointRef,
      createdAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    yield* ensurePreTurnBaseline(event.threadId, event.createdAt);
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fnUntraced(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (event.metadata.source === "agent-history-import") return;
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    yield* ensurePreTurnBaseline(event.payload.threadId, event.occurredAt);
  });

  const handleRevertRequested = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = new Date().toISOString();

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    const repositories = yield* resolveCheckpointRepositories({
      threadId: thread.id,
      turnCount: -1,
      cwd: sessionRuntime.value.cwd,
      project: readModel.projects.find((project) => project.id === thread.projectId),
    });
    turnRepositories.delete(thread.id);
    const nativeFiles =
      thread.session?.providerName === "claudeAgent" &&
      Option.isSome(sqlOption) &&
      (!thread.worktreePath || repositories.length === 0) &&
      !(yield* checkpointStore.isGitRepository(sessionRuntime.value.cwd));
    if (nativeFiles || repositories.length === 0) {
      if (nativeFiles) {
        yield* Effect.gen(function* () {
          const history = (yield* turns.listByThreadId({ threadId: thread.id }))
            .filter((turn) => turn.turnId !== null)
            .toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt));
          if (event.payload.turnCount === history.length) {
            yield* orchestrationEngine.dispatch({
              type: "thread.revert.complete",
              commandId: serverCommandId("native-checkpoint-noop"),
              threadId: thread.id,
              turnCount: event.payload.turnCount,
              retainedTurnIds: history.map((turn) => turn.turnId!),
              createdAt: now,
            });
            return;
          }
          const target = history[event.payload.turnCount];
          const targetMessage =
            target?.pendingMessageId ??
            thread.messages.find(
              (message) => message.role === "user" && message.turnId === target?.turnId,
            )?.id;
          if (!targetMessage) {
            yield* appendRevertFailureActivity({
              threadId: thread.id,
              turnCount: event.payload.turnCount,
              detail: "No native user-message checkpoint maps to this turn.",
              createdAt: now,
            }).pipe(Effect.catch(() => Effect.void));
            return;
          }
          yield* conversationRewind.run(
            {
              type: "thread.conversation.revert",
              commandId: serverCommandId("native-checkpoint"),
              operationId: CommandId.makeUnsafe(`native-checkpoint:${event.eventId}`),
              threadId: thread.id,
              targetMessageId: targetMessage,
              restoreFiles: true,
              createdAt: event.payload.createdAt,
            },
            { userInitiated: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            appendRevertFailureActivity({
              threadId: thread.id,
              turnCount: event.payload.turnCount,
              detail: Cause.pretty(cause).slice(0, 400),
              createdAt: now,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
        return;
      }
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const restore = yield* restoreCheckpointRepositories(
      checkpointStore,
      repositories,
      targetCheckpointRef,
      event.payload.turnCount === 0,
      !thread.worktreePath,
    );
    if (restore.skipped.length > 0) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("checkpoint-revert-skipped"),
          threadId: thread.id,
          activity: {
            id: EventId.makeUnsafe(timeOrderedUuid()),
            tone: "info",
            kind: "checkpoint.revert.skipped-repositories",
            summary: thread.worktreePath
              ? "Some repositories had no checkpoint and kept their files."
              : "Repository files outside the primary checkout were kept.",
            payload: { repositories: restore.skipped.map((repository) => repository.relativePath) },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    if (!restore.restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects the reverted filesystem state.
    clearWorkspaceIndexCache(sessionRuntime.value.cwd);

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0)
      yield* pruneRepositoryCheckpointRefs(checkpointStore, repositories, staleCheckpointRefs);

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.conversation-revert-requested") {
      // Each revert-requested event is an explicit user action (rewind, Retry, Recheck).
      yield* conversationRewind.run(event.payload, { userInitiated: true });
      return;
    }
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      return;
    }

    if (
      event.type === "thread.session-set" &&
      event.payload.session.activeTurnId === null &&
      (event.payload.session.status === "ready" ||
        event.payload.session.status === "error" ||
        event.payload.session.status === "stopped")
    ) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const latest = readModel.threads.find(
        (thread) => thread.id === event.payload.threadId,
      )?.latestTurn;
      if (!latest || latest.state === "running") return;
      yield* settleTerminalTurnProcessing({
        threadId: event.payload.threadId,
        turnId: latest.turnId,
        createdAt: latest.completedAt ?? event.occurredAt,
        status: latest.state === "error" ? "error" : "ready",
      });
    }
  });

  const processRuntimeEvent = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      if (!turnId) return;
      const checkpointTurnCount = yield* captureCheckpointForTerminalTurn({
        threadId: event.threadId,
        turnId,
        createdAt: event.createdAt,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
      }).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId,
            detail: error.message,
            createdAt: event.createdAt,
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.as(undefined),
          ),
        ),
      );
      yield* settleTerminalTurnProcessing({
        threadId: event.threadId,
        turnId,
        createdAt: event.createdAt,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        checkpointProcessed: true,
        ...(checkpointTurnCount !== undefined ? { checkpointTurnCount } : {}),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist turn processing quiescence", {
            threadId: event.threadId,
            turnId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      return;
    }
  });

  const processInput = (input: ReactorInput) =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeBackgroundWorker(
    (input: Parameters<typeof processInputSafely>[0]) =>
      processInputSafely(input).pipe(Effect.provideService(AcceptedShutdownWork, true)),
    { name: "CheckpointReactor" },
  );
  yield* registerShutdown("checkpoints", "drain", () => worker.drain, ["provider-ingestion"]);

  const reconcileStartupQuiescence = Effect.gen(function* () {
    const unquiesced = yield* turns.listTerminalUnquiesced.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to list terminal turns for startup quiescence", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([])),
      ),
    );
    yield* Effect.forEach(
      unquiesced,
      (turn) =>
        settleTerminalTurnProcessing({
          threadId: turn.threadId,
          turnId: turn.turnId,
          createdAt: turn.completedAt ?? new Date().toISOString(),
          status: turn.state === "error" ? "error" : "ready",
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("startup quiescence sweep failed", {
              threadId: turn.threadId,
              turnId: turn.turnId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  const start: CheckpointReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.conversation-revert-requested" &&
          event.type !== "thread.turn-diff-completed" &&
          event.type !== "thread.session-set"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
      { startImmediately: true },
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
      { startImmediately: true },
    );

    // Historical recovery can involve filesystem and Git work for many turns.
    // Keep it supervised by the reactor scope, but do not hold server readiness
    // or queue availability until the entire sweep finishes.
    const recoverRewinds: Effect.Effect<void, unknown> = conversationRewind.recover;
    yield* Effect.forkScoped(
      recoverRewinds.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("rewind startup recovery failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );

    yield* Effect.forkScoped(reconcileStartupQuiescence);
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
