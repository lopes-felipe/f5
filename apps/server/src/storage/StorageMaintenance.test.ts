import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitCore, type GitCoreShape } from "../git/Services/GitCore.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { withHomeSandbox } from "../testing/homeSandbox.ts";
import { StorageMaintenance } from "./StorageMaintenance.ts";
import { StorageMaintenanceLive } from "./StorageMaintenance.ts";
import { sizeIfExists } from "./diskUsage.ts";

function makeProviderServiceStub(input?: {
  readonly stopSession?: ProviderServiceShape["stopSession"];
}): ProviderServiceShape {
  const notImplemented = () => Effect.die("not implemented");
  return {
    startSession: notImplemented,
    sendTurn: notImplemented,
    interruptTurn: notImplemented,
    respondToRequest: notImplemented,
    respondToUserInput: notImplemented,
    stopSession: input?.stopSession ?? (() => Effect.void),
    listSessions: () => Effect.succeed([]),
    getCapabilities: notImplemented,
    readThread: notImplemented,
    rollbackConversation: notImplemented,
    runOneOffPrompt: notImplemented,
    compactConversation: notImplemented,
    reloadMcpConfigForProject: () => Effect.void,
    streamEvents: Stream.empty,
  } as unknown as ProviderServiceShape;
}

function makeCheckpointStoreStub(): CheckpointStoreShape {
  const notImplemented = () => Effect.die("not implemented");
  return {
    isGitRepository: notImplemented,
    captureCheckpoint: notImplemented,
    hasCheckpointRef: notImplemented,
    restoreCheckpoint: notImplemented,
    diffCheckpoints: notImplemented,
    deleteCheckpointRefs: () => Effect.void,
  } as unknown as CheckpointStoreShape;
}

function makeGitCoreStub(input?: {
  readonly removeWorktree?: GitCoreShape["removeWorktree"];
  readonly status?: GitCoreShape["status"];
}): GitCoreShape {
  return {
    status:
      input?.status ??
      ((request) =>
        Effect.succeed({
          branch: "main",
          hasWorkingTreeChanges: request.cwd.includes("feature-dirty"),
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: false,
          aheadCount: request.cwd.includes("feature-ahead") ? 1 : 0,
          behindCount: 0,
          pr: null,
        })),
    removeWorktree:
      input?.removeWorktree ??
      ((request) =>
        Effect.promise(() => NodeFS.rm(request.path, { recursive: true, force: true }))),
  } as unknown as GitCoreShape;
}

function makeOrchestrationEngineStub(input?: {
  readonly dispatch?: OrchestrationEngineShape["dispatch"];
}): OrchestrationEngineShape {
  return {
    getReadModel: () => Effect.succeed({} as never),
    readEvents: () => Stream.empty,
    dispatch:
      input?.dispatch ??
      ((command) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const now = new Date().toISOString();
          switch (command.type) {
            case "thread.meta.update":
              yield* sql`
                UPDATE projection_threads
                SET
                  worktree_path = CASE
                    WHEN ${command.worktreePath === undefined ? 1 : 0} = 1 THEN worktree_path
                    ELSE ${command.worktreePath ?? null}
                  END,
                  updated_at = ${now}
                WHERE thread_id = ${command.threadId}
                  AND (${command.expectedArchivedAt ?? null} IS NULL OR archived_at = ${command.expectedArchivedAt ?? null})
                  AND (${command.expectedWorktreePath ?? null} IS NULL OR worktree_path = ${command.expectedWorktreePath ?? null})
              `;
              return { sequence: 1 };
            case "thread.delete":
              yield* sql`
                UPDATE projection_threads
                SET deleted_at = ${now}, updated_at = ${now}
                WHERE thread_id = ${command.threadId}
                  AND (${command.expectedArchivedAt ?? null} IS NULL OR archived_at = ${command.expectedArchivedAt ?? null})
                  AND (${command.expectedWorktreePath ?? null} IS NULL OR worktree_path = ${command.expectedWorktreePath ?? null})
              `;
              return { sequence: 1 };
            default:
              return yield* Effect.die("not implemented");
          }
        })),
    acquireMaintenanceLock: () => Scope.make("sequential"),
    streamDomainEvents: Stream.empty,
  } as unknown as OrchestrationEngineShape;
}

function makeStorageTestLayer(input?: {
  readonly providerService?: ProviderServiceShape;
  readonly checkpointStore?: CheckpointStoreShape;
  readonly gitCore?: GitCoreShape;
  readonly orchestrationEngine?: OrchestrationEngineShape;
}) {
  return StorageMaintenanceLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-storage-maintenance-test-",
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderService, input?.providerService ?? makeProviderServiceStub()),
    ),
    Layer.provideMerge(
      Layer.succeed(CheckpointStore, input?.checkpointStore ?? makeCheckpointStoreStub()),
    ),
    Layer.provideMerge(Layer.succeed(GitCore, input?.gitCore ?? makeGitCoreStub())),
    Layer.provideMerge(
      Layer.succeed(
        OrchestrationEngineService,
        input?.orchestrationEngine ?? makeOrchestrationEngineStub(),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFS.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(path: string, contents: string) {
  await NodeFS.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFS.writeFile(path, contents);
}

async function writeGitWorktreeMetadata(input: {
  readonly worktreePath: string;
  readonly mainWorktreePath: string;
}) {
  const gitDir = NodePath.join(input.mainWorktreePath, ".git");
  const worktreeGitDir = NodePath.join(gitDir, "worktrees", NodePath.basename(input.worktreePath));
  await NodeFS.mkdir(input.worktreePath, { recursive: true });
  await NodeFS.mkdir(worktreeGitDir, { recursive: true });
  await NodeFS.writeFile(NodePath.join(input.worktreePath, ".git"), `gitdir: ${worktreeGitDir}\n`);
  await NodeFS.writeFile(NodePath.join(worktreeGitDir, "commondir"), "../..\n");
}

const layer = it.layer(makeStorageTestLayer());

layer("StorageMaintenance", (it) => {
  it.effect("inspect enumerates provider log files without following symlinks", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const outsidePath = NodePath.join(config.baseDir, "outside.bin");
        const logPath = NodePath.join(config.providerLogsDir, "orphan.log");
        const symlinkPath = NodePath.join(config.providerLogsDir, "orphan-link.log");
        yield* Effect.promise(async () => {
          await writeFile(outsidePath, "x".repeat(4096));
          await writeFile(logPath, "diagnostic");
          await NodeFS.symlink(outsidePath, symlinkPath);
        });

        const report = yield* storage.inspect({ force: true });
        const providerLogs = report.categories.find(
          (category) => category.id === "providerLogsForTerminalThreads",
        );

        assert.equal(providerLogs?.targetCount, 1);
        assert.equal(providerLogs?.targets[0]?.path, logPath);
        assert.ok(report.logsBytes < 4096);
      }),
    ),
  );

  it.effect("prunes only provider logs for non-live non-busy segments", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const activeThreadId = ThreadId.makeUnsafe("thread-active");
        const busyThreadId = ThreadId.makeUnsafe("thread-busy");
        const activeSegment = toSafeThreadAttachmentSegment(activeThreadId)!;
        const busySegment = toSafeThreadAttachmentSegment(busyThreadId)!;

        yield* seedThread({ sql, threadId: activeThreadId, deletedAt: null });
        yield* seedThread({ sql, threadId: busyThreadId, deletedAt: new Date().toISOString() });
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            active_turn_id,
            last_error,
            updated_at
          )
          VALUES (
            ${busyThreadId},
            ${"running"},
            ${"codex"},
            ${"provider-session-busy"},
            ${"provider-thread-busy"},
            ${null},
            ${null},
            ${new Date().toISOString()}
          )
        `;

        const stalePath = NodePath.join(config.providerLogsDir, "orphan.log");
        const activePath = NodePath.join(config.providerLogsDir, `${activeSegment}.log`);
        const busyPath = NodePath.join(config.providerLogsDir, `${busySegment}.log`);
        const globalPath = NodePath.join(config.providerLogsDir, "_global.log");
        yield* Effect.promise(async () => {
          await writeFile(stalePath, "stale");
          await writeFile(activePath, "active");
          await writeFile(busyPath, "busy");
          await writeFile(globalPath, "global");
        });

        const report = yield* storage.inspect({ force: true });
        const result = yield* storage.cleanup({
          operationId: "operation-provider-logs",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["providerLogsForTerminalThreads"],
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Cleaned");
        assert.equal(yield* Effect.promise(() => pathExists(stalePath)), false);
        assert.equal(yield* Effect.promise(() => pathExists(activePath)), true);
        assert.equal(yield* Effect.promise(() => pathExists(busyPath)), true);
        assert.equal(yield* Effect.promise(() => pathExists(globalPath)), true);
      }),
    ),
  );

  it.effect("enforces storage cleanup nonce single use", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const rotationPath = NodePath.join(config.providerLogsDir, "events.log.1");
        yield* Effect.promise(async () => {
          await writeFile(rotationPath, "old rotation");
          const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
          await NodeFS.utimes(rotationPath, oldTime, oldTime);
        });

        const report = yield* storage.inspect({ force: true });
        const request = {
          operationId: "operation-nonce",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["providerLogRotations" as const],
          options: { vacuumAfterDeletes: false },
        };

        const first = yield* storage.cleanup(request);
        assert.equal(first.results[0]?.status, "Cleaned");

        const secondExit = yield* Effect.exit(storage.cleanup(request));
        assert.equal(Exit.isFailure(secondExit), true);
      }),
    ),
  );

  it.effect("requires typed DELETE confirmation for high-impact legacy cleanup", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const home = NodeOS.homedir();
        const defaultDbPath = NodePath.join(home, ".f5", "userdata", "state.sqlite");
        const legacyCachePath = NodePath.join(home, ".t3", "caches", "cache.bin");
        yield* Effect.promise(async () => {
          await writeFile(defaultDbPath, "ready");
          await writeFile(legacyCachePath, "cache");
        });

        const report = yield* storage.inspect({ force: true });
        const rejected = yield* Effect.exit(
          storage.cleanup({
            operationId: "operation-legacy-no-delete",
            scanId: report.scanId,
            confirmationNonce: report.confirmationNonce,
            categoryIds: ["legacyT3Caches"],
            options: { vacuumAfterDeletes: false },
          }),
        );
        assert.equal(Exit.isFailure(rejected), true);

        const nextReport = yield* storage.inspect({ force: true });
        const result = yield* storage.cleanup({
          operationId: "operation-legacy-delete",
          scanId: nextReport.scanId,
          confirmationNonce: nextReport.confirmationNonce,
          categoryIds: ["legacyT3Caches"],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });
        assert.equal(result.results[0]?.status, "Cleaned");
        assert.equal(
          yield* Effect.promise(() => pathExists(NodePath.dirname(legacyCachePath))),
          false,
        );
      }),
    ),
  );

  it.effect("includes legacy storage in total used without double-counting legacy targets", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const home = NodeOS.homedir();
        const legacyRoot = NodePath.join(home, ".t3");
        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(config.stateDir, "current.bin"), "current-state");
          await writeFile(
            NodePath.join(config.worktreesDir, "project", "branch", "file.txt"),
            "wt",
          );
          await writeFile(NodePath.join(home, ".f5", "userdata", "state.sqlite"), "ready");
          await writeFile(NodePath.join(legacyRoot, "caches", "cache.bin"), "cache");
          await writeGitWorktreeMetadata({
            worktreePath: NodePath.join(legacyRoot, "worktrees", "old-worktree"),
            mainWorktreePath: NodePath.join(legacyRoot, "main-repo"),
          });
          await writeFile(
            NodePath.join(legacyRoot, "worktrees", "old-worktree", "file.txt"),
            "worktree",
          );
        });

        const report = yield* storage.inspect({ force: true });
        const stateUsage = yield* Effect.promise(() => sizeIfExists(config.stateDir));
        const worktreesUsage = yield* Effect.promise(() => sizeIfExists(config.worktreesDir));
        const legacyUsage = yield* Effect.promise(() => sizeIfExists(legacyRoot));

        assert.equal(report.legacyBytes, legacyUsage.bytes);
        assert.equal(report.worktreesBytes, worktreesUsage.bytes);
        assert.equal(
          report.totalUsedBytes,
          stateUsage.bytes + worktreesUsage.bytes + legacyUsage.bytes,
        );
      }),
    ),
  );

  it.effect("requires explicit target selection for legacy worktree cleanup", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const home = NodeOS.homedir();
        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(home, ".f5", "userdata", "state.sqlite"), "ready");
          await writeGitWorktreeMetadata({
            worktreePath: NodePath.join(home, ".t3", "worktrees", "old-worktree"),
            mainWorktreePath: NodePath.join(home, ".t3", "main-repo"),
          });
          await writeFile(
            NodePath.join(home, ".t3", "worktrees", "old-worktree", "file.txt"),
            "old",
          );
        });

        const report = yield* storage.inspect({ force: true });
        const result = yield* Effect.exit(
          storage.cleanup({
            operationId: "operation-worktree-without-targets",
            scanId: report.scanId,
            confirmationNonce: report.confirmationNonce,
            categoryIds: ["legacyT3Worktrees"],
            confirmationText: "DELETE",
            options: { vacuumAfterDeletes: false },
          }),
        );

        assert.equal(Exit.isFailure(result), true);
      }),
    ),
  );

  it.effect("does not treat archived threads as live legacy worktree references", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const home = NodeOS.homedir();
        const legacyWorktreePath = NodePath.join(home, ".t3", "worktrees", "archived-worktree");
        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(home, ".f5", "userdata", "state.sqlite"), "ready");
          await writeGitWorktreeMetadata({
            worktreePath: legacyWorktreePath,
            mainWorktreePath: NodePath.join(home, ".t3", "archived-main"),
          });
          await writeFile(NodePath.join(legacyWorktreePath, "file.txt"), "legacy worktree");
        });
        yield* seedThread({
          sql,
          threadId: ThreadId.makeUnsafe("thread-archived-legacy-worktree"),
          archivedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
          worktreePath: legacyWorktreePath,
        });

        const report = yield* storage.inspect({ force: true });
        const worktrees = report.categories.find((category) => category.id === "legacyT3Worktrees");
        const target = worktrees?.targets.find((entry) => entry.path === legacyWorktreePath);

        assert.equal(target?.safeToDelete, true);
        assert.equal(target?.disabledReason, undefined);
      }),
    ),
  );

  it.effect("splits nested legacy worktree project buckets into child targets", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const home = NodeOS.homedir();
        const liveWorktreePath = NodePath.join(home, ".t3", "worktrees", "f3-code", "t3code-live");
        const staleWorktreePath = NodePath.join(
          home,
          ".t3",
          "worktrees",
          "f3-code",
          "t3code-stale",
        );
        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(home, ".f5", "userdata", "state.sqlite"), "ready");
          await writeGitWorktreeMetadata({
            worktreePath: liveWorktreePath,
            mainWorktreePath: NodePath.join(home, ".t3", "main-live"),
          });
          await writeGitWorktreeMetadata({
            worktreePath: staleWorktreePath,
            mainWorktreePath: NodePath.join(home, ".t3", "main-stale"),
          });
          await writeFile(NodePath.join(liveWorktreePath, "live.txt"), "live");
          await writeFile(NodePath.join(staleWorktreePath, "stale.txt"), "stale");
        });
        yield* seedThread({
          sql,
          threadId: ThreadId.makeUnsafe("thread-live-legacy-child"),
          deletedAt: null,
          worktreePath: liveWorktreePath,
        });

        const report = yield* storage.inspect({ force: true });
        const worktrees = report.categories.find((category) => category.id === "legacyT3Worktrees");
        const liveTarget = worktrees?.targets.find((entry) => entry.path === liveWorktreePath);
        const staleTarget = worktrees?.targets.find((entry) => entry.path === staleWorktreePath);

        assert.equal(liveTarget?.label, "f3-code/t3code-live");
        assert.equal(liveTarget?.safeToDelete, false);
        assert.equal(liveTarget?.disabledReason, "Referenced by a live thread.");
        assert.equal(staleTarget?.label, "f3-code/t3code-stale");
        assert.equal(staleTarget?.safeToDelete, true);

        const result = yield* storage.cleanup({
          operationId: "operation-legacy-child-worktree",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["legacyT3Worktrees"],
          targetSelections: [{ categoryId: "legacyT3Worktrees", targetIds: [staleTarget!.id] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Cleaned");
        assert.equal(yield* Effect.promise(() => pathExists(liveWorktreePath)), true);
        assert.equal(yield* Effect.promise(() => pathExists(staleWorktreePath)), false);
      }),
    ),
  );

  it.effect("disables and skips dirty legacy worktree targets", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const home = NodeOS.homedir();
        const cleanWorktreePath = NodePath.join(home, ".t3", "worktrees", "feature-clean");
        const dirtyWorktreePath = NodePath.join(home, ".t3", "worktrees", "feature-dirty");
        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(home, ".f5", "userdata", "state.sqlite"), "ready");
          await writeGitWorktreeMetadata({
            worktreePath: cleanWorktreePath,
            mainWorktreePath: NodePath.join(home, ".t3", "main-clean"),
          });
          await writeGitWorktreeMetadata({
            worktreePath: dirtyWorktreePath,
            mainWorktreePath: NodePath.join(home, ".t3", "main-dirty"),
          });
          await writeFile(NodePath.join(cleanWorktreePath, "clean.txt"), "clean");
          await writeFile(NodePath.join(dirtyWorktreePath, "dirty.txt"), "dirty");
        });

        const report = yield* storage.inspect({ force: true });
        const worktrees = report.categories.find((category) => category.id === "legacyT3Worktrees");
        const cleanTarget = worktrees?.targets.find((entry) => entry.path === cleanWorktreePath);
        const dirtyTarget = worktrees?.targets.find((entry) => entry.path === dirtyWorktreePath);

        assert.equal(cleanTarget?.safeToDelete, true);
        assert.equal(dirtyTarget?.safeToDelete, false);
        assert.equal(dirtyTarget?.disabledReason, "Worktree has uncommitted changes.");

        const result = yield* storage.cleanup({
          operationId: "operation-legacy-dirty-worktree",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["legacyT3Worktrees"],
          targetSelections: [{ categoryId: "legacyT3Worktrees", targetIds: [dirtyTarget!.id] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Failed");
        assert.equal(yield* Effect.promise(() => pathExists(dirtyWorktreePath)), true);
        assert.equal(
          result.results[0]?.warnings.some(
            (warning) =>
              warning.path === dirtyWorktreePath &&
              warning.reason === "Worktree has uncommitted changes.",
          ),
          true,
        );
      }),
    ),
  );

  it.effect("reclaims legacy worktree directories when parent Git metadata is missing", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const home = NodeOS.homedir();
        const worktreePath = NodePath.join(home, ".t3", "worktrees", "metadata-missing");
        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(home, ".f5", "userdata", "state.sqlite"), "ready");
          await writeFile(
            NodePath.join(worktreePath, ".git"),
            "gitdir: /tmp/nonexistent-t3-worktree-metadata\n",
          );
          await writeFile(NodePath.join(worktreePath, "file.txt"), "legacy worktree");
        });

        const report = yield* storage.inspect({ force: true });
        const worktrees = report.categories.find((category) => category.id === "legacyT3Worktrees");
        const target = worktrees?.targets.find((entry) => entry.path === worktreePath);

        assert.equal(target?.safeToDelete, true);
        assert.equal(target?.disabledReason, undefined);
        assert.equal(
          target?.detail,
          "Git metadata is missing; directory will be deleted directly.",
        );

        const result = yield* storage.cleanup({
          operationId: "operation-legacy-missing-metadata-worktree",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["legacyT3Worktrees"],
          targetSelections: [{ categoryId: "legacyT3Worktrees", targetIds: [target!.id] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Cleaned");
        assert.equal(yield* Effect.promise(() => pathExists(worktreePath)), false);
      }),
    ),
  );

  it.effect("prunes archived provider logs while retaining active and busy logs", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const activeThreadId = ThreadId.makeUnsafe("thread-active-log");
        const archivedThreadId = ThreadId.makeUnsafe("thread-archived-log");
        const busyThreadId = ThreadId.makeUnsafe("thread-busy-log");
        const activeSegment = toSafeThreadAttachmentSegment(activeThreadId)!;
        const archivedSegment = toSafeThreadAttachmentSegment(archivedThreadId)!;
        const busySegment = toSafeThreadAttachmentSegment(busyThreadId)!;

        yield* seedThread({ sql, threadId: activeThreadId, deletedAt: null });
        yield* seedThread({
          sql,
          threadId: archivedThreadId,
          archivedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
        });
        yield* seedThread({ sql, threadId: busyThreadId, deletedAt: null });
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            active_turn_id,
            last_error,
            updated_at
          )
          VALUES (
            ${busyThreadId},
            ${"running"},
            ${"codex"},
            ${"provider-session-busy"},
            ${"provider-thread-busy"},
            ${null},
            ${null},
            ${new Date().toISOString()}
          )
        `;

        const activePath = NodePath.join(config.providerLogsDir, `${activeSegment}.log`);
        const archivedPath = NodePath.join(config.providerLogsDir, `${archivedSegment}.log`);
        const busyPath = NodePath.join(config.providerLogsDir, `${busySegment}.log`);
        yield* Effect.promise(async () => {
          await writeFile(activePath, "active");
          await writeFile(archivedPath, "archived");
          await writeFile(busyPath, "busy");
        });

        const report = yield* storage.inspect({ force: true });
        const result = yield* storage.cleanup({
          operationId: "operation-archived-provider-logs",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["providerLogsForTerminalThreads"],
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Cleaned");
        assert.equal(yield* Effect.promise(() => pathExists(activePath)), true);
        assert.equal(yield* Effect.promise(() => pathExists(archivedPath)), false);
        assert.equal(yield* Effect.promise(() => pathExists(busyPath)), true);
      }),
    ),
  );

  it.effect("removes clean archived F5 worktrees after clearing thread references", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("thread-archived-f5-worktree");
        const mainWorktreePath = NodePath.join(config.baseDir, "main-repo");
        const worktreePath = NodePath.join(config.worktreesDir, "main-repo", "feature-a");
        yield* Effect.promise(async () => {
          await writeGitWorktreeMetadata({ worktreePath, mainWorktreePath });
          await writeFile(NodePath.join(worktreePath, "file.txt"), "worktree data");
        });
        yield* seedThread({
          sql,
          threadId,
          archivedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
          worktreePath,
        });

        const report = yield* storage.inspect({ force: true });
        const category = report.categories.find((entry) => entry.id === "inactiveF5Worktrees");
        const target = category?.targets.find((entry) => entry.path === worktreePath);
        assert.equal(target?.safeToDelete, true);

        const result = yield* storage.cleanup({
          operationId: "operation-f5-worktree-clean",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["inactiveF5Worktrees"],
          targetSelections: [{ categoryId: "inactiveF5Worktrees", targetIds: [target!.id] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });
        const rows = yield* sql<{ readonly worktreePath: string | null }>`
          SELECT worktree_path AS "worktreePath"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;

        assert.equal(result.results[0]?.status, "Cleaned");
        assert.equal(rows[0]?.worktreePath, null);
        assert.equal(yield* Effect.promise(() => pathExists(worktreePath)), false);
      }),
    ),
  );

  it.effect("disables dirty F5 worktree targets", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const mainWorktreePath = NodePath.join(config.baseDir, "main-repo-dirty");
        const worktreePath = NodePath.join(config.worktreesDir, "main-repo-dirty", "feature-dirty");
        yield* Effect.promise(async () => {
          await writeGitWorktreeMetadata({ worktreePath, mainWorktreePath });
          await writeFile(NodePath.join(worktreePath, "dirty.txt"), "dirty");
        });

        const report = yield* storage.inspect({ force: true });
        const category = report.categories.find((entry) => entry.id === "inactiveF5Worktrees");
        const target = category?.targets.find((entry) => entry.path === worktreePath);

        assert.equal(target?.safeToDelete, false);
        assert.equal(target?.disabledReason, "Worktree has uncommitted changes.");
      }),
    ),
  );

  it.effect("disables ahead F5 worktree targets", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const mainWorktreePath = NodePath.join(config.baseDir, "main-repo-ahead");
        const worktreePath = NodePath.join(config.worktreesDir, "main-repo-ahead", "feature-ahead");
        yield* Effect.promise(async () => {
          await writeGitWorktreeMetadata({ worktreePath, mainWorktreePath });
          await writeFile(NodePath.join(worktreePath, "ahead.txt"), "ahead");
        });

        const report = yield* storage.inspect({ force: true });
        const category = report.categories.find((entry) => entry.id === "inactiveF5Worktrees");
        const target = category?.targets.find((entry) => entry.path === worktreePath);

        assert.equal(target?.safeToDelete, false);
        assert.equal(target?.disabledReason, "Worktree has unpushed commits.");
      }),
    ),
  );

  it.effect("refuses to clean the configured F5 worktrees root", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const mainWorktreePath = NodePath.join(config.baseDir, "main-root");
        yield* Effect.promise(async () => {
          await writeGitWorktreeMetadata({
            worktreePath: config.worktreesDir,
            mainWorktreePath,
          });
          await writeFile(NodePath.join(config.worktreesDir, "root.txt"), "root");
        });

        const report = yield* storage.inspect({ force: true });
        const category = report.categories.find((entry) => entry.id === "inactiveF5Worktrees");
        const target = category?.targets.find((entry) => entry.path === config.worktreesDir);

        assert.equal(target?.safeToDelete, false);
        assert.equal(target?.disabledReason, "Refused to delete the configured F5 worktrees root.");

        const result = yield* storage.cleanup({
          operationId: "operation-f5-worktree-root",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["inactiveF5Worktrees"],
          targetSelections: [{ categoryId: "inactiveF5Worktrees", targetIds: [target!.id] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Failed");
        assert.equal(yield* Effect.promise(() => pathExists(config.worktreesDir)), true);
        assert.equal(
          result.results[0]?.warnings.some(
            (warning) =>
              warning.path === config.worktreesDir &&
              warning.reason === "Refused to delete the configured F5 worktrees root.",
          ),
          true,
        );
      }),
    ),
  );

  it.effect("does not scan through symlinked legacy roots", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const home = NodeOS.homedir();
        const outside = NodePath.join(home, "outside-legacy");
        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(home, ".f5", "userdata", "state.sqlite"), "ready");
          await writeFile(NodePath.join(outside, "caches", "cache.bin"), "outside");
          await NodeFS.symlink(outside, NodePath.join(home, ".t3"));
        });

        const report = yield* storage.inspect({ force: true });
        assert.ok(
          report.warnings.some((warning) =>
            warning.reason.includes("symbolic-link legacy storage root"),
          ),
        );
        assert.equal(
          report.categories.some((category) => category.id === "legacyT3Caches"),
          true,
        );
        const caches = report.categories.find((category) => category.id === "legacyT3Caches");
        assert.equal(caches?.targetCount, 0);
      }),
    ),
  );

  it.effect(
    "purges soft-deleted thread rows and preserves colliding attachment and provider log files",
    () =>
      withHomeSandbox(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance;
          const config = yield* ServerConfig;
          const sql = yield* SqlClient.SqlClient;
          const deletedThreadId = ThreadId.makeUnsafe("Thread Collision");
          const activeThreadId = ThreadId.makeUnsafe("thread-collision");
          const sharedSegment = toSafeThreadAttachmentSegment(deletedThreadId)!;

          yield* seedThread({
            sql,
            threadId: deletedThreadId,
            deletedAt: new Date().toISOString(),
          });
          yield* seedThread({ sql, threadId: activeThreadId, deletedAt: null });
          yield* seedDeletedThreadDetail({ sql, threadId: deletedThreadId });
          yield* sql`
            INSERT INTO projection_turn_usage_facts (
              turn_id, thread_id, project_id, provider_name, total_tokens,
              token_provenance, cost_provenance, completed_at, recorded_at, source_event_id
            ) VALUES
              (
                'turn-usage-deleted', ${deletedThreadId}, 'project-1', 'codex', 10,
                'provider-reported', 'unreported',
                '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z', 'usage-event-deleted'
              ),
              (
                'turn-usage-active', ${activeThreadId}, 'project-1', 'codex', 20,
                'provider-reported', 'unreported',
                '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z', 'usage-event-active'
              )
          `;
          const usageMetadataBefore = yield* sql<{
            readonly coverageStartedAt: string;
            readonly factCutoverAt: string;
          }>`
            SELECT
              coverage_started_at AS "coverageStartedAt",
              fact_cutover_at AS "factCutoverAt"
            FROM projection_usage_metadata
            WHERE singleton_id = 1
          `;

          const providerLogPath = NodePath.join(config.providerLogsDir, `${sharedSegment}.log`);
          const attachmentPath = NodePath.join(
            config.attachmentsDir,
            `${sharedSegment}-attachment.txt`,
          );
          yield* Effect.promise(async () => {
            await writeFile(providerLogPath, "shared provider log");
            await writeFile(attachmentPath, "deleted attachment");
          });

          const report = yield* storage.inspect({ force: true });
          const result = yield* storage.cleanup({
            operationId: "operation-purge-deleted",
            scanId: report.scanId,
            confirmationNonce: report.confirmationNonce,
            categoryIds: ["purgeDeletedThreads"],
            options: { vacuumAfterDeletes: false },
          });

          assert.equal(result.results[0]?.status, "Cleaned");
          assert.equal(yield* countRows(sql, "projection_threads", deletedThreadId), 0);
          assert.equal(yield* countRows(sql, "projection_threads", activeThreadId), 1);
          assert.equal(yield* countRows(sql, "projection_thread_messages", deletedThreadId), 0);
          assert.equal(yield* countRows(sql, "projection_thread_activities", deletedThreadId), 0);
          assert.equal(
            yield* countRows(sql, "projection_thread_command_executions", deletedThreadId),
            0,
          );
          assert.equal(yield* countRows(sql, "projection_thread_file_changes", deletedThreadId), 0);
          assert.equal(
            yield* countRows(sql, "projection_thread_proposed_plans", deletedThreadId),
            0,
          );
          assert.equal(yield* countRows(sql, "projection_pending_approvals", deletedThreadId), 0);
          assert.equal(yield* countRows(sql, "projection_turns", deletedThreadId), 0);
          assert.equal(yield* countRows(sql, "projection_turn_usage_facts", deletedThreadId), 0);
          assert.equal(yield* countRows(sql, "projection_turn_usage_facts", activeThreadId), 1);
          assert.equal(yield* countRows(sql, "provider_session_runtime", deletedThreadId), 0);
          assert.equal(yield* countRows(sql, "checkpoint_diff_blobs", deletedThreadId), 0);
          const receipts = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_command_receipts
          WHERE command_id = ${CommandId.makeUnsafe("cmd-deleted-thread")}
        `;
          assert.equal(receipts[0]?.count, 0);
          const eventStore = yield* OrchestrationEventStore;
          const replayedEvents = yield* eventStore.readFromSequence(0, 100).pipe(Stream.runCollect);
          assert.equal(
            replayedEvents.some((event) => event.aggregateId === deletedThreadId),
            false,
          );
          assert.equal(yield* Effect.promise(() => pathExists(attachmentPath)), true);
          assert.equal(yield* Effect.promise(() => pathExists(providerLogPath)), true);
          const usageMetadataAfter = yield* sql<{
            readonly coverageStartedAt: string;
            readonly factCutoverAt: string;
          }>`
            SELECT
              coverage_started_at AS "coverageStartedAt",
              fact_cutover_at AS "factCutoverAt"
            FROM projection_usage_metadata
            WHERE singleton_id = 1
          `;
          assert.equal(
            usageMetadataAfter[0]!.coverageStartedAt >= usageMetadataBefore[0]!.coverageStartedAt,
            true,
          );
          assert.equal(usageMetadataAfter[0]!.factCutoverAt, usageMetadataBefore[0]!.factCutoverAt);
        }),
      ),
  );

  it.effect("purges archived threads older than 30 days through guarded delete", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const archivedThreadId = ThreadId.makeUnsafe("thread-archived-purge");
        const archivedSegment = toSafeThreadAttachmentSegment(archivedThreadId)!;

        yield* seedThread({
          sql,
          threadId: archivedThreadId,
          archivedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
        });
        yield* seedDeletedThreadDetail({ sql, threadId: archivedThreadId });
        const providerLogPath = NodePath.join(config.providerLogsDir, `${archivedSegment}.log`);
        const attachmentPath = NodePath.join(
          config.attachmentsDir,
          `${archivedSegment}-attachment.txt`,
        );
        yield* Effect.promise(async () => {
          await writeFile(providerLogPath, "archived provider log");
          await writeFile(attachmentPath, "archived attachment");
        });

        const report = yield* storage.inspect({ force: true });
        const archivedCategory = report.categories.find(
          (category) => category.id === "purgeArchivedThreads",
        );
        assert.equal(archivedCategory?.availability, "ready");

        const result = yield* storage.cleanup({
          operationId: "operation-purge-archived",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["purgeArchivedThreads"],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Cleaned");
        assert.equal(yield* countRows(sql, "projection_threads", archivedThreadId), 0);
        assert.equal(yield* countRows(sql, "projection_thread_messages", archivedThreadId), 0);
        assert.equal(yield* countRows(sql, "provider_session_runtime", archivedThreadId), 0);
        assert.equal(yield* countRows(sql, "checkpoint_diff_blobs", archivedThreadId), 0);
        const receipts = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_command_receipts
          WHERE command_id = ${CommandId.makeUnsafe("cmd-deleted-thread")}
        `;
        assert.equal(receipts[0]?.count, 0);
        const eventStore = yield* OrchestrationEventStore;
        const replayedEvents = yield* eventStore.readFromSequence(0, 100).pipe(Stream.runCollect);
        assert.equal(
          replayedEvents.some((event) => event.aggregateId === archivedThreadId),
          false,
        );
        assert.equal(yield* Effect.promise(() => pathExists(attachmentPath)), false);
        assert.equal(yield* Effect.promise(() => pathExists(providerLogPath)), false);
      }),
    ),
  );

  it.effect("keeps archived threads newer than 30 days out of purge candidates", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const archivedThreadId = ThreadId.makeUnsafe("thread-archived-recent");
        const recentArchivedAt = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();

        yield* seedThread({
          sql,
          threadId: archivedThreadId,
          archivedAt: recentArchivedAt,
          deletedAt: null,
        });

        const report = yield* storage.inspect({ force: true });
        const archivedCategory = report.categories.find(
          (category) => category.id === "purgeArchivedThreads",
        );

        assert.equal(archivedCategory?.availability, "disabled");
        assert.equal(archivedCategory?.targetCount, 0);
      }),
    ),
  );

  it.effect("skips archived purge when a scanned thread is unarchived before cleanup", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const archivedThreadId = ThreadId.makeUnsafe("thread-archived-race");

        yield* seedThread({
          sql,
          threadId: archivedThreadId,
          archivedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
        });

        const report = yield* storage.inspect({ force: true });
        yield* sql`
          UPDATE projection_threads
          SET archived_at = NULL
          WHERE thread_id = ${archivedThreadId}
        `;
        const result = yield* storage.cleanup({
          operationId: "operation-purge-archived-race",
          scanId: report.scanId,
          confirmationNonce: report.confirmationNonce,
          categoryIds: ["purgeArchivedThreads"],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.equal(result.results[0]?.status, "Skipped");
        assert.equal(yield* countRows(sql, "projection_threads", archivedThreadId), 1);
      }),
    ),
  );
});

function seedThread(input: {
  readonly sql: SqlClient.SqlClient;
  readonly threadId: ThreadId;
  readonly title?: string;
  readonly archivedAt?: string | null;
  readonly deletedAt: string | null;
  readonly worktreePath?: string | null;
}) {
  return Effect.gen(function* () {
    const now = new Date().toISOString();
    yield* input.sql`
      INSERT OR IGNORE INTO projection_projects (
        project_id,
        title,
        workspace_root,
        default_model,
        scripts_json,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${ProjectId.makeUnsafe("project-storage-maintenance")},
        ${"Storage Maintenance"},
        ${"/tmp/storage-maintenance"},
        ${null},
        ${"[]"},
        ${now},
        ${now},
        ${null}
      )
    `;
    yield* input.sql`
      INSERT INTO projection_threads (
        thread_id,
        project_id,
        title,
        model,
        branch,
        worktree_path,
        latest_turn_id,
        archived_at,
        created_at,
        last_interaction_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${input.threadId},
        ${ProjectId.makeUnsafe("project-storage-maintenance")},
        ${input.title ?? input.threadId},
        ${"gpt-5.5"},
        ${null},
        ${input.worktreePath ?? null},
        ${null},
        ${input.archivedAt ?? null},
        ${now},
        ${now},
        ${now},
        ${input.deletedAt}
      )
    `;
  });
}

function seedDeletedThreadDetail(input: {
  readonly sql: SqlClient.SqlClient;
  readonly threadId: ThreadId;
}) {
  return Effect.gen(function* () {
    const now = new Date().toISOString();
    yield* input.sql`
      INSERT INTO projection_thread_messages (
        message_id,
        thread_id,
        turn_id,
        role,
        text,
        reasoning_text,
        is_streaming,
        created_at,
        updated_at
      )
      VALUES (
        ${"message-deleted-thread"},
        ${input.threadId},
        ${"turn-deleted-thread"},
        ${"user"},
        ${"hello"},
        ${null},
        ${0},
        ${now},
        ${now}
      )
    `;
    yield* input.sql`
      INSERT INTO projection_thread_activities (
        activity_id,
        thread_id,
        turn_id,
        tone,
        kind,
        summary,
        payload_json,
        created_at
      )
      VALUES (
        ${"activity-deleted-thread"},
        ${input.threadId},
        ${"turn-deleted-thread"},
        ${"info"},
        ${"status"},
        ${"activity"},
        ${"{}"},
        ${now}
      )
    `;
    yield* input.sql`
      INSERT INTO projection_thread_command_executions (
        command_execution_id,
        thread_id,
        turn_id,
        command,
        status,
        output,
        output_truncated,
        started_sequence,
        last_updated_sequence,
        started_at,
        updated_at
      )
      VALUES (
        ${"command-execution-deleted-thread"},
        ${input.threadId},
        ${"turn-deleted-thread"},
        ${"echo hello"},
        ${"completed"},
        ${""},
        ${0},
        ${1},
        ${1},
        ${now},
        ${now}
      )
    `;
    yield* input.sql`
      INSERT INTO projection_thread_file_changes (
        file_change_id,
        thread_id,
        turn_id,
        title,
        status,
        changed_files,
        patch,
        started_sequence,
        last_updated_sequence,
        started_at,
        updated_at
      )
      VALUES (
        ${"file-change-deleted-thread"},
        ${input.threadId},
        ${"turn-deleted-thread"},
        ${"change"},
        ${"completed"},
        ${"[]"},
        ${""},
        ${1},
        ${1},
        ${now},
        ${now}
      )
    `;
    yield* input.sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id,
        thread_id,
        turn_id,
        plan_markdown,
        created_at,
        updated_at
      )
      VALUES (
        ${"plan-deleted-thread"},
        ${input.threadId},
        ${"turn-deleted-thread"},
        ${"plan"},
        ${now},
        ${now}
      )
    `;
    yield* input.sql`
      INSERT INTO projection_pending_approvals (
        request_id,
        thread_id,
        turn_id,
        status,
        decision,
        created_at,
        resolved_at
      )
      VALUES (
        ${"approval-deleted-thread"},
        ${input.threadId},
        ${"turn-deleted-thread"},
        ${"pending"},
        ${null},
        ${now},
        ${null}
      )
    `;
    yield* input.sql`
      INSERT INTO projection_turns (
        thread_id,
        turn_id,
        pending_message_id,
        assistant_message_id,
        state,
        requested_at,
        started_at,
        completed_at,
        checkpoint_turn_count,
        checkpoint_ref,
        checkpoint_status,
        checkpoint_files_json
      )
      VALUES (
        ${input.threadId},
        ${"turn-deleted-thread"},
        ${null},
        ${null},
        ${"completed"},
        ${now},
        ${now},
        ${now},
        ${1},
        ${null},
        ${null},
        ${"[]"}
      )
    `;
    yield* input.sql`
      INSERT INTO provider_session_runtime (
        thread_id,
        provider_name,
        adapter_key,
        runtime_mode,
        status,
        last_seen_at,
        resume_cursor_json,
        runtime_payload_json
      )
      VALUES (
        ${input.threadId},
        ${"codex"},
        ${"codex"},
        ${"full-access"},
        ${"stopped"},
        ${now},
        ${null},
        ${"{}"}
      )
    `;
    yield* input.sql`
      INSERT INTO checkpoint_diff_blobs (
        thread_id,
        from_turn_count,
        to_turn_count,
        diff,
        created_at
      )
      VALUES (
        ${input.threadId},
        ${0},
        ${1},
        ${"diff"},
        ${now}
      )
    `;
    yield* input.sql`
      INSERT INTO orchestration_events (
        event_id,
        aggregate_kind,
        stream_id,
        stream_version,
        event_type,
        occurred_at,
        command_id,
        causation_event_id,
        correlation_id,
        actor_kind,
        payload_json,
        metadata_json
      )
      VALUES (
        ${EventId.makeUnsafe("evt-deleted-thread")},
        ${"thread"},
        ${input.threadId},
        ${0},
        ${"thread.created"},
        ${now},
        ${CommandId.makeUnsafe("cmd-deleted-thread")},
        ${null},
        ${CommandId.makeUnsafe("cmd-deleted-thread")},
        ${"user"},
        ${"{}"},
        ${"{}"}
      )
    `;
    yield* input.sql`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        accepted_at,
        result_sequence,
        status,
        error
      )
      VALUES (
        ${CommandId.makeUnsafe("cmd-deleted-thread")},
        ${"thread"},
        ${input.threadId},
        ${now},
        ${1},
        ${"success"},
        ${null}
      )
    `;
  });
}

type CountedThreadTable =
  | "projection_threads"
  | "projection_thread_messages"
  | "projection_thread_activities"
  | "projection_thread_command_executions"
  | "projection_thread_file_changes"
  | "projection_thread_proposed_plans"
  | "projection_pending_approvals"
  | "projection_turns"
  | "projection_turn_usage_facts"
  | "provider_session_runtime"
  | "checkpoint_diff_blobs";

function countRows(sql: SqlClient.SqlClient, tableName: CountedThreadTable, threadId: ThreadId) {
  const mapCount = Effect.map(
    (rows: ReadonlyArray<{ readonly count: number }>) => rows[0]?.count ?? 0,
  );
  switch (tableName) {
    case "projection_threads":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_thread_messages":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_thread_activities":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_activities WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_thread_command_executions":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_command_executions WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_thread_file_changes":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_file_changes WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_thread_proposed_plans":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_pending_approvals":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pending_approvals WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_turns":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_turns WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "projection_turn_usage_facts":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_turn_usage_facts WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "provider_session_runtime":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM provider_session_runtime WHERE thread_id = ${threadId}
      `.pipe(mapCount);
    case "checkpoint_diff_blobs":
      return sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}
      `.pipe(mapCount);
  }
}
