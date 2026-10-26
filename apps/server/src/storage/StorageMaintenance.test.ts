import { vi } from "vitest";
import { removeFileIfSafe } from "./storagePathSafety.ts";
vi.mock("./storagePathSafety.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storagePathSafety.ts")>();
  return { ...actual, removeFileIfSafe: vi.fn(actual.removeFileIfSafe) };
});
import { withAttachmentRetentionLease } from "./attachmentRetention.ts";
import { withWorktreeLifecycleLock } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { withProviderThreadAccess } from "../provider/providerThreadAccess.ts";
import { makeFakeGitCore } from "../git/testDoubles.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { NextTurnQueueStoreLive } from "../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { TerminalManager, type TerminalManagerShape } from "../terminal/Services/Manager.ts";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef, CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitCore, type GitCoreShape } from "../git/Services/GitCore.ts";
import { GitServiceLive } from "../git/Layers/GitService.ts";
import { GitCoreTestLive } from "../git/testLayers.ts";
import { git as runGit, makeClonedRepo } from "./storageAutomation.testHarness.ts";
import { ProfileRegistryStore } from "../profiles/ProfileRegistryStore.ts";
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
import { workflowArchiveFixture } from "../orchestration/workflowArchive.testUtils.ts";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StorageMaintenance } from "./StorageMaintenance.ts";
import { StorageMaintenanceLive } from "./StorageMaintenance.ts";
import { sizeIfExists } from "./diskUsage.ts";
import { openRuntimeSqliteDatabase } from "../persistence/runtimeSqlite.ts";

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
    reloadMcpConfigForProject: () => Effect.succeed({ sessions: [] }),
    streamEvents: Stream.empty,
  } as unknown as ProviderServiceShape;
}

function makeCheckpointStoreStub(): CheckpointStoreShape {
  const notImplemented = () => Effect.die("not implemented");
  return {
    isGitRepository: notImplemented,
    captureCheckpoint: notImplemented,
    hasCheckpointRef: notImplemented,
    readCheckpointRefs: () => Effect.succeed({}),
    restoreCheckpoint: notImplemented,
    diffCheckpoints: notImplemented,
    deleteCheckpointRefs: () => Effect.void,
  } as unknown as CheckpointStoreShape;
}

const metadataWorktrees = new Map<string, string[]>();

function makeGitCoreStub(input?: {
  readonly removeWorktree?: GitCoreShape["removeWorktree"];
  readonly status?: GitCoreShape["status"];
}): GitCoreShape {
  const status: GitCoreShape["status"] =
    input?.status ??
    ((request) =>
      Effect.succeed({
        branch: "feature",
        hasWorkingTreeChanges: request.cwd.includes("feature-dirty"),
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: request.cwd.includes("feature-ahead") ? 1 : 0,
        behindCount: 0,
        pr: null,
        changeRequest: null,
      }));
  return makeFakeGitCore({
    status,
    listWorktrees: (cwd) =>
      Effect.tryPromise(async () =>
        Promise.all(
          (metadataWorktrees.get(cwd) ?? []).map(async (path) => ({
            path,
            canonicalPath: await canonicalWorktreePath(path),
            headSha: "abc123",
            branch: "feature",
            bare: false,
            detached: false,
            locked: null,
            prunable: null,
            isMain: false,
          })),
        ),
      ).pipe(Effect.orDie),
    resolveCommonDir: (cwd) =>
      Effect.promise(() => canonicalWorktreePath(NodePath.join(cwd, ".git"))),
    inspectCheckout: (cwd) =>
      Effect.gen(function* () {
        const state = yield* status({ cwd });
        const root = [...metadataWorktrees].find(([, paths]) => paths.includes(cwd))?.[0] ?? cwd;
        return {
          canonicalRoot: yield* Effect.promise(() => canonicalWorktreePath(cwd)),
          commonDir: yield* Effect.promise(() =>
            canonicalWorktreePath(NodePath.join(root, ".git")),
          ),
          registration: null,
          headSha: "abc123",
          branch: "feature",
          operation: null,
          hasInitializedSubmodules: false,
          hasTrackedChanges: state.hasWorkingTreeChanges,
          hasUntrackedChanges: false,
          ignoredEntries: [],
          ignoredTruncated: false,
          upstreamRef: "origin/feature",
          upstreamSha: "abc123",
          aheadCount: state.aheadCount,
          behindCount: state.behindCount,
        };
      }),
    removeWorktree:
      input?.removeWorktree ??
      ((request) =>
        Effect.promise(() => NodeFS.rm(request.path, { recursive: true, force: true }))),
  }).service;
}

function makeOrchestrationEngineStub(input?: {
  readonly dispatch?: OrchestrationEngineShape["dispatch"];
  readonly getWorkflows?: () => Pick<
    OrchestrationReadModel,
    "planningWorkflows" | "codeReviewWorkflows" | "investigationWorkflows"
  >;
}): OrchestrationEngineShape {
  return {
    getReadModel: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects =
          yield* sql`SELECT project_id AS id, title, workspace_root AS "workspaceRoot", deleted_at AS "deletedAt" FROM projection_projects`;
        const threads =
          yield* sql`SELECT thread_id AS id, project_id AS "projectId", worktree_path AS "worktreePath", archived_at AS "archivedAt", deleted_at AS "deletedAt" FROM projection_threads`;
        return {
          ...input?.getWorkflows?.(),
          projects,
          threads: threads.map((thread) => ({ ...thread, session: null, activities: [] })),
        } as never;
      }),
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
  /** A stub, or `"real"` for the live GitCore against temporary repositories. */
  readonly gitCore?: GitCoreShape | "real";
  readonly orchestrationEngine?: OrchestrationEngineShape;
  /** Provide server settings; without them the Codex staging category is omitted. */
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
}) {
  const maintenance = input?.settings
    ? StorageMaintenanceLive.pipe(
        Layer.provideMerge(ServerSettingsService.layerTest(input.settings)),
      )
    : StorageMaintenanceLive;
  return maintenance.pipe(
    Layer.provideMerge(NextTurnQueueStoreLive),
    Layer.provideMerge(
      Layer.succeed(TerminalManager, {
        listSessions: Effect.succeed([]),
      } as unknown as TerminalManagerShape),
    ),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      input?.gitCore === "real"
        ? GitCoreTestLive.pipe(Layer.provideMerge(GitServiceLive))
        : Layer.succeed(GitCore, input?.gitCore ?? makeGitCoreStub()),
    ),
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
  metadataWorktrees.set(input.mainWorktreePath, [
    ...(metadataWorktrees.get(input.mainWorktreePath) ?? []),
    input.worktreePath,
  ]);
  const gitDir = NodePath.join(input.mainWorktreePath, ".git");
  const worktreeGitDir = NodePath.join(gitDir, "worktrees", NodePath.basename(input.worktreePath));
  await NodeFS.mkdir(input.worktreePath, { recursive: true });
  await NodeFS.mkdir(worktreeGitDir, { recursive: true });
  await NodeFS.writeFile(NodePath.join(input.worktreePath, ".git"), `gitdir: ${worktreeGitDir}\n`);
  await NodeFS.writeFile(NodePath.join(worktreeGitDir, "commondir"), "../..\n");
}

for (const categoryId of ["inactiveF5Worktrees", "legacyT3Worktrees"] as const) {
  it.effect(`continues ${categoryId} cleanup after a deleted session refuses to stop`, () => {
    const threadId = ThreadId.makeUnsafe(`stop-failed-${categoryId}`);
    let blockedPath = "";
    const providers: ProviderServiceShape = {
      ...makeProviderServiceStub({ stopSession: () => Effect.die("stop refused") }),
      listSessions: () =>
        Effect.succeed([{ threadId, cwd: blockedPath, status: "ready" }] as never),
    };
    return withHomeSandbox(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const storage = yield* StorageMaintenance;
        const root =
          categoryId === "inactiveF5Worktrees"
            ? config.worktreesDir
            : NodePath.join(NodeOS.homedir(), ".t3", "worktrees");
        blockedPath = NodePath.join(root, "blocked");
        const cleanPath = NodePath.join(root, "clean");
        yield* Effect.promise(async () => {
          await writeFile(
            NodePath.join(NodeOS.homedir(), ".f5", "userdata", "state.sqlite"),
            "ready",
          );
          for (const worktreePath of [blockedPath, cleanPath]) {
            await writeGitWorktreeMetadata({
              worktreePath,
              mainWorktreePath: NodePath.join(config.baseDir, "main"),
            });
            await writeFile(NodePath.join(worktreePath, "file.txt"), "contents");
          }
        });
        yield* seedThread({
          sql,
          threadId,
          deletedAt: new Date().toISOString(),
          worktreePath: blockedPath,
        });
        const report = yield* storage.inspect({ force: true });
        const targets = report.categories.find((category) => category.id === categoryId)!.targets;
        assert.equal(targets.filter((target) => target.safeToDelete).length, 2);
        const result = yield* storage.cleanup({
          operationId: `cleanup-${categoryId}`,
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: [categoryId],
          targetSelections: [{ categoryId, targetIds: targets.map((target) => target.id) }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });
        assert.equal(yield* Effect.promise(() => pathExists(blockedPath)), true);
        assert.equal(yield* Effect.promise(() => pathExists(cleanPath)), false);
        assert.ok(
          result.results[0]?.warnings.some(
            (warning) => warning.path === blockedPath && warning.reason.includes("stop refused"),
          ),
        );
      }).pipe(Effect.provide(makeStorageTestLayer({ providerService: providers }))),
    );
  });
}

const awaitOperation = (
  storage: import("./StorageMaintenance.ts").StorageMaintenanceShape,
  operationId: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const result = yield* storage.getOperation({ operationId });
      if (result.status.completedAt) return result;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
    }
    return yield* Effect.die("Cleanup did not complete.");
  });

const layer = it.layer(makeStorageTestLayer());

it.effect(
  "skipped purge and no-op log pruning keep the measured generation and concise audit reasons",
  () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance,
          sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("skipped-stop-no-mutation");
        yield* seedThread({ sql, threadId, deletedAt: daysAgo(90) });
        const report = yield* storage.inspect({ force: true });
        const before = yield* storage.getUsage();
        yield* storage.purgeThreads({
          operationId: "automatic-stop-skip",
          deletedBefore: daysAgo(30),
          archivedBefore: null,
          maxThreads: 1,
        });
        yield* storage.pruneTerminalThreadLogs({
          operationId: "logs-no-mutation",
          modifiedBefore: daysAgo(1),
          includeArchived: true,
        });
        assert.deepStrictEqual((yield* storage.getUsage()).confirmation, before.confirmation);
        const operation = yield* storage.acceptCleanup({
          operationId: "manual-stop-skip",
          backendEpoch: before.status.backendEpoch,
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: ["purgeDeletedThreads"],
          options: { vacuumAfterDeletes: false },
        });
        const result = yield* awaitOperation(storage, operation.operationId);
        assert.equal(result.status.result?.results[0]?.perTargetReclaimed[0]?.status, "Skipped");
        assert.equal(yield* countRows(sql, "projection_threads", threadId), 1);
        const usage = yield* storage.getUsage();
        assert.equal(usage.report?.scanId, report.scanId);
        assert.equal(usage.status.scan.state, "idle");
        const audit = yield* sql<{
          reason: string | null;
        }>`SELECT reason FROM storage_automation_audit`;
        assert.isAbove(audit.length, 0);
        for (const row of audit) {
          assert.isAtMost(row.reason?.length ?? 0, 300);
          assert.notInclude(row.reason ?? "", "\n    at ");
        }
      }).pipe(
        Effect.provide(
          makeStorageTestLayer({
            providerService: makeProviderServiceStub({
              stopSession: () => Effect.die(new Error(`Provider stop failed: ${"x".repeat(500)}`)),
            }),
          }),
        ),
      ),
    ),
);

for (const mode of ["fallback", "another-copy", "remaining"] as const) {
  it.effect(`checkpoint preflight uses bulk identity reads (${mode})`, () =>
    withHomeSandbox(
      Effect.gen(function* () {
        let removed = false;
        let deletedCwd: string | undefined;
        let reads = 0;
        const ref = CheckpointRef.makeUnsafe("refs/t3/checkpoints/purge-ref/1");
        const oid = "a".repeat(40);
        let worktree = "";
        const checkpoints: CheckpointStoreShape = {
          ...makeCheckpointStoreStub(),
          isGitRepository: () => Effect.succeed(true),
          readCheckpointRefs: ({ cwd }) =>
            Effect.sync(() => {
              reads++;
              return removed && cwd === deletedCwd ? {} : { [ref]: oid };
            }),
          deleteCheckpointRefs: (input) =>
            Effect.sync(() => {
              deletedCwd = input.cwd;
              assert.deepStrictEqual(input.expectedOids, { [ref]: oid });
              removed = mode !== "remaining";
            }),
        };
        return yield* Effect.gen(function* () {
          const storage = yield* StorageMaintenance,
            sql = yield* SqlClient.SqlClient,
            config = yield* ServerConfig;
          const threadId = ThreadId.makeUnsafe(`purge-ref-${mode}`);
          const workspace = NodePath.join(config.baseDir, "recorded-root");
          worktree = NodePath.join(config.baseDir, "recorded-worktree");
          yield* Effect.promise(async () => {
            await NodeFS.mkdir(NodePath.join(workspace, ".git"), { recursive: true });
            if (mode !== "fallback")
              await NodeFS.mkdir(NodePath.join(worktree, ".git"), { recursive: true });
          });
          yield* seedThread({ sql, threadId, worktreePath: worktree, deletedAt: daysAgo(90) });
          yield* sql`UPDATE projection_projects SET workspace_root = ${workspace}`;
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_turn_count, checkpoint_ref, checkpoint_files_json)
          VALUES (${threadId}, 'ref-turn', 'completed', ${daysAgo(90)}, 1, ${ref}, '[]')`;
          const report = yield* storage.inspect({ force: true });
          const operation = yield* storage.acceptCleanup({
            operationId: `ref-${mode}`,
            backendEpoch: (yield* storage.getStatus).backendEpoch,
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["purgeDeletedThreads"],
            options: { vacuumAfterDeletes: false },
          });
          const result = yield* awaitOperation(storage, operation.operationId);
          assert.equal(deletedCwd, mode === "fallback" ? workspace : worktree);
          assert.isAtMost(reads, 3);
          assert.equal(
            yield* countRows(sql, "projection_threads", threadId),
            mode === "remaining" ? 1 : 0,
          );
          if (mode === "another-copy")
            assert.isTrue(
              result.status.result?.warnings.some((warning) =>
                warning.reason.includes("another recorded repository"),
              ),
            );
          if (mode === "remaining")
            assert.equal(
              result.status.result?.results[0]?.perTargetReclaimed[0]?.status,
              "Deleted, cleanup incomplete",
            );
        }).pipe(Effect.provide(makeStorageTestLayer({ checkpointStore: checkpoints })));
      }),
    ),
  );
}

it.effect(
  "manual acceptance and automatic purge share lock order without holding attachment access during stop",
  () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let stopped = false;
      const providers = makeProviderServiceStub({
        stopSession: () =>
          Effect.gen(function* () {
            if (!stopped) {
              stopped = true;
              yield* Deferred.succeed(stopping, undefined);
              yield* Deferred.await(resume);
            }
          }),
      });
      return yield* withHomeSandbox(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* StorageMaintenance;
            const sql = yield* SqlClient.SqlClient;
            const config = yield* ServerConfig;
            const threadId = ThreadId.makeUnsafe("concurrent-manual-automatic");
            yield* seedThread({ sql, threadId, deletedAt: daysAgo(90) });
            const report = yield* storage.inspect({ force: true });
            const operation = yield* storage.acceptCleanup({
              operationId: "manual-overlap",
              backendEpoch: (yield* storage.getStatus).backendEpoch,
              scanId: report.scanId,
              nonce: report.confirmationNonce,
              categoryIds: ["purgeDeletedThreads"],
              options: { vacuumAfterDeletes: false },
            });
            yield* Deferred.await(stopping);
            // Quiescence must leave attachment ingress/backup access available.
            yield* withAttachmentRetentionLease(config.attachmentsDir, Effect.void).pipe(
              Effect.timeout("1 second"),
            );
            const automatic = yield* storage
              .purgeThreads({
                operationId: "automatic-overlap",
                deletedBefore: daysAgo(30),
                archivedBefore: null,
                maxThreads: 1,
              })
              .pipe(Effect.forkIn(yield* Scope.Scope));
            // Let the automatic pass enumerate its small fixture and wait for the same provider lock.
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
            yield* withAttachmentRetentionLease(config.attachmentsDir, Effect.void).pipe(
              Effect.timeout("1 second"),
            );
            yield* Deferred.succeed(resume, undefined);
            const manual = yield* awaitOperation(storage, operation.operationId);
            yield* Fiber.join(automatic).pipe(Effect.timeout("1 second"));
            assert.equal(manual.status.state, "succeeded");
            assert.equal(yield* countRows(sql, "projection_threads", threadId), 0);
            yield* withAttachmentRetentionLease(config.attachmentsDir, Effect.void).pipe(
              Effect.timeout("1 second"),
            );
          }),
        ).pipe(Effect.provide(makeStorageTestLayer({ providerService: providers }))),
      );
    }),
);

for (const categoryId of ["inactiveF5Worktrees", "legacyT3Worktrees"] as const) {
  it.effect(
    `cancelling ${categoryId} while its lifecycle lock is held leaves the checkout intact`,
    () =>
      withHomeSandbox(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* StorageMaintenance;
            const config = yield* ServerConfig;
            const path = NodePath.join(
              categoryId === "inactiveF5Worktrees"
                ? config.worktreesDir
                : NodePath.join(NodeOS.homedir(), ".t3", "worktrees"),
              "cancel-locked",
            );
            yield* Effect.promise(async () => {
              await writeFile(
                NodePath.join(NodeOS.homedir(), ".f5", "userdata", "state.sqlite"),
                "ready",
              );
              await writeGitWorktreeMetadata({
                worktreePath: path,
                mainWorktreePath: NodePath.join(config.baseDir, "cancel-main"),
              });
              await writeFile(NodePath.join(path, "keep.txt"), "keep these bytes");
            });
            const report = yield* storage.inspect({ force: true });
            assert.isTrue(
              report.categories
                .find((category) => category.id === categoryId)
                ?.targets.some((target) => target.path === path && target.safeToDelete),
              JSON.stringify(report.categories.find((category) => category.id === categoryId)),
            );
            const locked = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            yield* withWorktreeLifecycleLock(
              path,
              Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ).pipe(Effect.forkIn(yield* Scope.Scope));
            yield* Deferred.await(locked);
            const operation = yield* storage.acceptCleanup({
              operationId: `cancel-${categoryId}`,
              backendEpoch: (yield* storage.getStatus).backendEpoch,
              scanId: report.scanId,
              nonce: report.confirmationNonce,
              categoryIds: [categoryId],
              targetSelections: [
                {
                  categoryId,
                  targetIds: [
                    report.categories
                      .find((category) => category.id === categoryId)!
                      .targets.find((target) => target.path === path)!.id,
                  ],
                },
              ],
              confirmationText: "DELETE",
              options: { vacuumAfterDeletes: false },
            });
            while ((yield* storage.getStatus).cleanup?.progress?.phase !== "deleting")
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
            yield* storage.cancel(operation.operationId);
            yield* Deferred.succeed(release, undefined);
            const result = yield* awaitOperation(storage, operation.operationId);
            assert.equal(result.status.state, "cancelled");
            assert.deepStrictEqual(result.status.result?.results, []);
            assert.isTrue(yield* Effect.promise(() => pathExists(NodePath.join(path, "keep.txt"))));
          }),
        ).pipe(Effect.provide(makeStorageTestLayer())),
      ),
  );
}

for (const cancelled of [false, true]) {
  it.effect(
    `keeps completed purge outcomes when optional compaction ${cancelled ? "is cancelled" : "fails"}`,
    () =>
      Effect.gen(function* () {
        const compacting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let gates = 0;
        const engine = {
          ...makeOrchestrationEngineStub(),
          acquireMaintenanceLock: () =>
            Effect.gen(function* () {
              if (++gates === 2 && cancelled) {
                yield* Deferred.succeed(compacting, undefined);
                yield* Deferred.await(release);
              }
              return yield* Scope.make("sequential");
            }),
        };
        return yield* withHomeSandbox(
          Effect.scoped(
            Effect.gen(function* () {
              const storage = yield* StorageMaintenance;
              const sql = yield* SqlClient.SqlClient;
              const config = yield* ServerConfig;
              const threadId = ThreadId.makeUnsafe(`post-purge-compaction-${cancelled}`);
              const path = NodePath.join(
                config.attachmentsDir,
                `${threadId}-11111111-1111-4111-8111-111111111111.txt`,
              );
              yield* seedThread({ sql, threadId, deletedAt: daysAgo(90) });
              yield* Effect.promise(() => writeFile(path, "removed and accounted for"));
              // The helper will fail opening these bytes as a database; the SQL fixture is :memory:.
              yield* Effect.promise(() => writeFile(config.dbPath, "not a SQLite database"));
              const report = yield* storage.inspect({ force: true });
              const operation = yield* storage.acceptCleanup({
                operationId: `post-purge-${cancelled}`,
                backendEpoch: (yield* storage.getStatus).backendEpoch,
                scanId: report.scanId,
                nonce: report.confirmationNonce,
                categoryIds: ["purgeDeletedThreads"],
              });
              if (cancelled) {
                yield* Deferred.await(compacting);
                yield* storage.cancel(operation.operationId);
                yield* Deferred.succeed(release, undefined);
              }
              const result = yield* awaitOperation(storage, operation.operationId);
              assert.equal(result.status.state, cancelled ? "cancelled" : "partial");
              assert.isAbove(result.status.result?.reclaimedBytes ?? 0, 0);
              assert.equal(
                result.status.result?.results[0]?.perTargetReclaimed[0]?.status,
                "Removed",
              );
              assert.equal(result.status.result?.results[1]?.categoryId, "databaseVacuum");
              assert.equal(yield* countRows(sql, "projection_threads", threadId), 0);
              assert.isFalse(yield* Effect.promise(() => pathExists(path)));
            }),
          ).pipe(Effect.provide(makeStorageTestLayer({ orchestrationEngine: engine }))),
        );
      }),
  );
}

it.effect("an unreadable provider-home root keeps accessible cleanup categories actionable", () =>
  withHomeSandbox(
    Effect.gen(function* () {
      if (process.platform === "win32" || process.getuid?.() === 0) return;
      const storage = yield* StorageMaintenance;
      const config = yield* ServerConfig;
      const root = config.providerHomesDir ?? NodePath.join(config.stateDir, "provider-homes");
      const log = NodePath.join(config.providerLogsDir, "accessible-orphan.log");
      yield* Effect.promise(async () => {
        await NodeFS.mkdir(root, { recursive: true });
        await writeFile(log, "accessible sibling");
        await NodeFS.chmod(root, 0);
      });
      yield* Effect.gen(function* () {
        const report = yield* storage.inspect({ force: true });
        assert.isTrue(
          report.warnings.some(
            (warning) => warning.path === root && /EACCES|permission/i.test(warning.reason),
          ),
        );
        assert.equal(report.providerHomesMeasurement, "unavailable");
        assert.equal(
          report.categories.find((category) => category.id === "databaseVacuum")?.measurement,
          "complete",
        );
        const logs = report.categories.find(
          (category) => category.id === "providerLogsForTerminalThreads",
        );
        assert.equal(logs?.measurement, "complete");
        assert.equal(logs?.availability, "ready");
        assert.isTrue(logs?.targets.some((target) => target.path === log));
        assert.isNotNull((yield* storage.getUsage()).confirmation);
      }).pipe(Effect.ensuring(Effect.promise(() => NodeFS.chmod(root, 0o700))));
    }).pipe(Effect.provide(makeStorageTestLayer())),
  ),
);

it.effect("an empty eligible attachment manifest never adds newly eligible files", () =>
  withHomeSandbox(
    Effect.gen(function* () {
      const storage = yield* StorageMaintenance;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      const threadId = ThreadId.makeUnsafe("new-unconfirmed-attachment-thread");
      yield* seedThread({ sql, threadId, deletedAt: null });
      const outsidePath = NodePath.join(config.baseDir, "outside-attachments.png");
      yield* sql`INSERT INTO attachments(attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash, final_path, lifecycle, created_at, updated_at)
        VALUES ('outside-unconfirmed', ${threadId}, 'image', 'outside.png', 'image/png', 0, 'hash', ${outsidePath}, 'ready', '2026-01-01', '2026-01-01')`;
      const report = yield* storage.inspect({ force: true });
      assert.equal(
        report.categories
          .find((category) => category.id === "orphanAttachments")
          ?.targets.filter((target) => target.safeToDelete).length,
        0,
      );
      const path = NodePath.join(config.attachmentsDir, "new-unconfirmed.png");
      yield* Effect.promise(() => writeFile(path, "new attachment"));
      yield* sql`INSERT INTO attachments(attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash, final_path, lifecycle, created_at, updated_at)
        VALUES ('new-unconfirmed', ${threadId}, 'image', 'new.png', 'image/png', 14, 'hash', ${path}, 'ready', '2026-01-01', '2026-01-01')`;
      const result = yield* storage.cleanup({
        operationId: "empty-confirmed-manifest",
        scanId: report.scanId,
        nonce: report.confirmationNonce,
        categoryIds: ["orphanAttachments"],
        options: { vacuumAfterDeletes: false },
      });
      assert.equal(result.reclaimedBytes, 0);
      assert.isTrue(yield* Effect.promise(() => pathExists(path)));
      const rows = yield* sql<{
        lifecycle: string;
      }>`SELECT lifecycle FROM attachments WHERE attachment_id = 'new-unconfirmed'`;
      assert.equal(rows[0]?.lifecycle, "ready");
    }).pipe(Effect.provide(makeStorageTestLayer())),
  ),
);

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
        // Directory entries and the symlink itself also occupy bytes. Growing
        // the external target must not change the measured logs usage.
        yield* Effect.promise(() => NodeFS.appendFile(outsidePath, "x".repeat(4096)));
        const afterGrowth = yield* storage.inspect({ force: true });
        assert.equal(afterGrowth.logsBytes, report.logsBytes);
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
          nonce: report.confirmationNonce,
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
          nonce: report.confirmationNonce,
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
            nonce: report.confirmationNonce,
            categoryIds: ["legacyT3Caches"],
            options: { vacuumAfterDeletes: false },
          }),
        );
        assert.equal(Exit.isFailure(rejected), true);

        const nextReport = yield* storage.inspect({ force: true });
        const result = yield* storage.cleanup({
          operationId: "operation-legacy-delete",
          scanId: nextReport.scanId,
          nonce: nextReport.confirmationNonce,
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
            nonce: report.confirmationNonce,
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

        assert.equal(liveTarget?.label, NodePath.join("f3-code", "t3code-live"));
        assert.equal(liveTarget?.safeToDelete, false);
        assert.equal(liveTarget?.disabledReason, "Referenced by a live thread.");
        assert.equal(staleTarget?.label, NodePath.join("f3-code", "t3code-stale"));
        assert.equal(staleTarget?.safeToDelete, true);

        const result = yield* storage.cleanup({
          operationId: "operation-legacy-child-worktree",
          scanId: report.scanId,
          nonce: report.confirmationNonce,
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
        assert.equal(
          dirtyTarget?.disabledReason,
          "it has uncommitted changes (including untracked files)",
        );

        const result = yield* storage.cleanup({
          operationId: "operation-legacy-dirty-worktree",
          scanId: report.scanId,
          nonce: report.confirmationNonce,
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
              warning.reason === "it has uncommitted changes (including untracked files)",
          ),
          true,
        );
      }),
    ),
  );

  it.effect("retains legacy worktree directories when parent Git metadata is missing", () =>
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

        assert.equal(target?.safeToDelete, false);
        assert.equal(target?.disabledReason, "Git worktree metadata could not be resolved.");

        const result = yield* storage
          .cleanup({
            operationId: "operation-legacy-missing-metadata-worktree",
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["legacyT3Worktrees"],
            targetSelections: [{ categoryId: "legacyT3Worktrees", targetIds: [target!.id] }],
            confirmationText: "DELETE",
            options: { vacuumAfterDeletes: false },
          })
          .pipe(Effect.exit);

        assert.equal(result._tag, "Failure");
        assert.equal(yield* Effect.promise(() => pathExists(worktreePath)), true);
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
          nonce: report.confirmationNonce,
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

  it.effect("removes clean archived F5 worktrees while preserving thread references", () =>
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
          nonce: report.confirmationNonce,
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
        assert.equal(rows[0]?.worktreePath, worktreePath);
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
        assert.equal(
          target?.disabledReason,
          "it has uncommitted changes (including untracked files)",
        );
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
        assert.match(
          target?.disabledReason ?? "",
          /^it has commits that are not in .+ and not pushed$/,
        );
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
          nonce: report.confirmationNonce,
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
            nonce: report.confirmationNonce,
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
          `${archivedSegment}-11111111-1111-4111-8111-111111111111.txt`,
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
          nonce: report.confirmationNonce,
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
          nonce: report.confirmationNonce,
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

for (const kind of ["planning", "codeReview", "investigation"] as const) {
  it.effect("releases " + kind + " workflow retention after parent project deletion", () => {
    const fixture = workflowArchiveFixture(kind);
    const engine = makeOrchestrationEngineStub({
      getWorkflows: () => ({
        planningWorkflows: fixture.model.planningWorkflows.map((workflow) => ({
          ...workflow,
          projectId: ProjectId.makeUnsafe("project-storage-maintenance"),
        })),
        codeReviewWorkflows: fixture.model.codeReviewWorkflows.map((workflow) => ({
          ...workflow,
          projectId: ProjectId.makeUnsafe("project-storage-maintenance"),
        })),
        investigationWorkflows: fixture.model.investigationWorkflows.map((workflow) => ({
          ...workflow,
          projectId: ProjectId.makeUnsafe("project-storage-maintenance"),
        })),
      }),
    });
    return withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        yield* seedThread({ sql, threadId: fixture.a, archivedAt: daysAgo(90), deletedAt: null });
        {
          const report = yield* storage.inspect({ force: true });
          assert.isFalse(
            report.categories
              .find((category) => category.id === "purgeArchivedThreads")
              ?.targets.some((target) => target.id === fixture.a),
          );
        }
        yield* sql`UPDATE projection_projects SET deleted_at = ${daysAgo(40)}`;
        const report = yield* storage.inspect({ force: true });
        assert.isTrue(
          report.categories
            .find((category) => category.id === "purgeArchivedThreads")
            ?.targets.some((target) => target.id === fixture.a),
        );
        const result = yield* storage.purgeThreads({
          operationId: "deleted-parent-" + kind,
          archivedBefore: daysAgo(30),
          deletedBefore: daysAgo(0),
          maxThreads: 10,
        });
        assert.deepEqual(result.purgedThreadIds, [fixture.a]);
      }).pipe(Effect.provide(makeStorageTestLayer({ orchestrationEngine: engine }))),
    );
  });

  it.effect("retains " + kind + " workflow threads until their workflow is deleted", () => {
    const fixture = workflowArchiveFixture(kind);
    let retained = false;
    const engine = makeOrchestrationEngineStub({
      getWorkflows: () =>
        retained
          ? fixture.model
          : {
              planningWorkflows: [],
              codeReviewWorkflows: [],
              investigationWorkflows: [],
            },
    });
    return withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        yield* seedThread({
          sql,
          threadId: fixture.a,
          archivedAt: daysAgo(90),
          deletedAt: null,
        });
        const log = NodePath.join(
          config.providerLogsDir,
          toSafeThreadAttachmentSegment(fixture.a)! + ".log",
        );
        yield* Effect.promise(() => writeFile(log, "workflow history"));
        const report = yield* storage.inspect({ force: true });
        assert.isTrue(
          report.categories
            .find((category) => category.id === "purgeArchivedThreads")
            ?.targets.some((target) => target.id === fixture.a),
        );
        retained = true;
        const guarded = yield* storage.cleanup({
          operationId: "retained-stale-report-" + kind,
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: ["purgeArchivedThreads"],
          targetSelections: [{ categoryId: "purgeArchivedThreads", targetIds: [fixture.a] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });
        assert.isTrue(
          guarded.results
            .flatMap((result) => result.warnings)
            .some((warning) => warning.reason.includes("workflow")),
          JSON.stringify(guarded),
        );
        assert.isTrue(yield* Effect.promise(() => pathExists(log)));
        assert.equal(yield* countRows(sql, "projection_threads", fixture.a), 1);
        const next = yield* storage.inspect({ force: true });
        assert.isFalse(
          next.categories
            .find((category) => category.id === "purgeArchivedThreads")
            ?.targets.some((target) => target.id === fixture.a),
        );
        const scheduled = yield* storage.purgeThreads({
          operationId: "retained-scheduled-" + kind,
          archivedBefore: daysAgo(30),
          deletedBefore: daysAgo(0),
          maxThreads: 10,
        });
        assert.deepEqual(scheduled.purgedThreadIds, []);
        retained = false;
        const released = yield* storage.purgeThreads({
          operationId: "released-workflow-" + kind,
          archivedBefore: daysAgo(30),
          deletedBefore: daysAgo(0),
          maxThreads: 10,
        });
        assert.deepEqual(released.purgedThreadIds, [fixture.a]);
        assert.isFalse(yield* Effect.promise(() => pathExists(log)));
      }).pipe(Effect.provide(makeStorageTestLayer({ orchestrationEngine: engine }))),
    );
  });
}

it.effect("keeps filesystem cleanup outside the exclusive orchestration gate", () => {
  let gateHeld = false;
  let removals = 0;
  const base = makeOrchestrationEngineStub();
  const engine = {
    ...base,
    acquireMaintenanceLock: () =>
      Effect.gen(function* () {
        gateHeld = true;
        const scope = yield* Scope.make("sequential");
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            gateHeld = false;
          }),
        );
        return scope;
      }),
  };
  const original = vi.mocked(removeFileIfSafe).getMockImplementation()!;
  return withHomeSandbox(
    Effect.gen(function* () {
      const storage = yield* StorageMaintenance;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      const threadId = ThreadId.makeUnsafe("slow-purge-outside-gate");
      yield* seedThread({ sql, threadId, archivedAt: daysAgo(90), deletedAt: null });
      const file = NodePath.join(
        config.providerLogsDir,
        toSafeThreadAttachmentSegment(threadId)! + ".log",
      );
      yield* Effect.promise(() => writeFile(file, "cleanup bytes"));
      vi.mocked(removeFileIfSafe).mockImplementationOnce(async (input) => {
        assert.isFalse(gateHeld, "Filesystem removal must not freeze command writes");
        removals++;
        return original(input);
      });
      const result = yield* storage.purgeThreads({
        operationId: "purge-outside-engine-gate",
        archivedBefore: daysAgo(30),
        deletedBefore: daysAgo(0),
        maxThreads: 10,
      });
      assert.deepEqual(result.purgedThreadIds, [threadId]);
      assert.equal(removals, 1);
      assert.isFalse(gateHeld);
    }).pipe(
      Effect.provide(makeStorageTestLayer({ orchestrationEngine: engine })),
      Effect.ensuring(Effect.sync(() => vi.mocked(removeFileIfSafe).mockImplementation(original))),
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

const codexStagingHome = NodePath.join(
  NodeOS.tmpdir(),
  `f5-storage-codex-home-${Math.random().toString(36).slice(2)}`,
);

it.layer(
  makeStorageTestLayer({ settings: { providers: { codex: { homePath: codexStagingHome } } } }),
)("StorageMaintenance Codex marketplace staging", (it) => {
  it.effect("offers old marketplace upgrade leftovers and deletes only confirmed ones", () =>
    Effect.gen(function* () {
      const storage = yield* StorageMaintenance;
      const marketplaces = NodePath.join(codexStagingHome, ".tmp", "marketplaces");
      const oldClone = NodePath.join(marketplaces, ".staging", "marketplace-upgrade-old");
      const freshClone = NodePath.join(marketplaces, ".staging", "marketplace-upgrade-fresh");
      const lateClone = NodePath.join(marketplaces, ".staging", "marketplace-upgrade-late");
      const makeDir = async (target: string, ageMs: number) => {
        await writeFile(NodePath.join(target, "pack"), "x".repeat(4096));
        const when = new Date(Date.now() - ageMs);
        await NodeFS.utimes(target, when, when);
      };
      yield* Effect.promise(async () => {
        await makeDir(oldClone, 3 * 60 * 60 * 1_000);
        await makeDir(freshClone, 0);
      });

      try {
        const report = yield* storage.inspect({ force: true });
        const category = report.categories.find((entry) => entry.id === "codexMarketplaceStaging");
        assert.equal(category?.section, "providers");
        assert.equal(category?.availability, "ready");
        assert.deepEqual(
          category?.targets.map((target) => target.path),
          [oldClone],
        );
        assert.isAtLeast(category?.reclaimableBytes ?? 0, 4096);

        // The low-disk banner's summary scans again without replacing the
        // nonce of the scan the user is looking at; cleanup below uses it.
        const summary = yield* storage.summarizeReclaimable;
        const staging = summary.find((item) => item.categoryId === "codexMarketplaceStaging");
        assert.equal(staging?.title, category?.title);
        assert.equal(staging?.bytes, category?.reclaimableBytes);
        assert.deepEqual(
          summary.map((item) => item.bytes),
          summary.map((item) => item.bytes).toSorted((left, right) => right - left),
        );

        // A leftover that ages past the guard after the scan was not confirmed.
        yield* Effect.promise(() => makeDir(lateClone, 3 * 60 * 60 * 1_000));
        const result = yield* storage.cleanup({
          operationId: "operation-codex-staging",
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: ["codexMarketplaceStaging"],
        });

        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.status, "Cleaned");
        assert.isAtLeast(result.reclaimedBytes, 4096);
        assert.equal(yield* Effect.promise(() => pathExists(oldClone)), false);
        assert.equal(yield* Effect.promise(() => pathExists(freshClone)), true);
        assert.equal(yield* Effect.promise(() => pathExists(lateClone)), true);
      } finally {
        yield* Effect.promise(() => NodeFS.rm(codexStagingHome, { recursive: true, force: true }));
      }
    }),
  );
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

it.layer(makeStorageTestLayer())("StorageMaintenance automatic maintenance", (it) => {
  it.effect("purges threads past their deletion or archive age, and nothing newer", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const deletedOld = ThreadId.makeUnsafe("auto-deleted-old");
        const deletedRecent = ThreadId.makeUnsafe("auto-deleted-recent");
        const archivedOld = ThreadId.makeUnsafe("auto-archived-old");
        const archivedRecent = ThreadId.makeUnsafe("auto-archived-recent");
        const live = ThreadId.makeUnsafe("auto-live");
        yield* seedThread({ sql, threadId: deletedOld, deletedAt: daysAgo(10) });
        yield* seedThread({ sql, threadId: deletedRecent, deletedAt: daysAgo(1) });
        yield* seedThread({ sql, threadId: archivedOld, archivedAt: daysAgo(40), deletedAt: null });
        yield* seedThread({
          sql,
          threadId: archivedRecent,
          archivedAt: daysAgo(5),
          deletedAt: null,
        });
        yield* seedThread({ sql, threadId: live, deletedAt: null });
        yield* sql`
          INSERT INTO orchestration_event_compaction (
            thread_id, compacted_through_sequence, compacted_at
          ) VALUES (${deletedOld}, 1, ${daysAgo(20)}), (${live}, 1, ${daysAgo(20)})
        `;

        const result = yield* storage.purgeThreads({
          operationId: "automatic-purge",
          deletedBefore: daysAgo(7),
          archivedBefore: daysAgo(30),
          maxThreads: 10,
        });

        assert.deepStrictEqual([...result.purgedThreadIds].toSorted(), [archivedOld, deletedOld]);
        assert.deepStrictEqual(result.archivedThreadIds, [archivedOld]);
        for (const kept of [deletedRecent, archivedRecent, live]) {
          assert.equal(yield* countRows(sql, "projection_threads", kept), 1);
        }
        for (const purged of [deletedOld, archivedOld]) {
          assert.equal(yield* countRows(sql, "projection_threads", purged), 0);
        }
        const watermarks = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM orchestration_event_compaction
        `;
        assert.deepStrictEqual(watermarks, [{ threadId: live }]);

        // Archived threads are left alone unless a cutoff is given, and a
        // capped pass takes the oldest deletions first.
        yield* seedThread({
          sql,
          threadId: ThreadId.makeUnsafe("auto-archived-old-2"),
          archivedAt: daysAgo(400),
          deletedAt: null,
        });
        const deletedOldest = ThreadId.makeUnsafe("auto-deleted-oldest");
        yield* seedThread({ sql, threadId: deletedOldest, deletedAt: daysAgo(90) });
        const capped = yield* storage.purgeThreads({
          operationId: "automatic-purge-capped",
          deletedBefore: daysAgo(0),
          archivedBefore: null,
          maxThreads: 1,
        });
        assert.deepStrictEqual(capped.purgedThreadIds, [deletedOldest]);
        assert.deepStrictEqual(capped.archivedThreadIds, []);
        assert.equal(yield* countRows(sql, "projection_threads", deletedRecent), 1);
      }),
    ),
  );

  it.effect("prunes old logs of archived, deleted and unknown threads only", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const archived = ThreadId.makeUnsafe("logs-archived");
        const live = ThreadId.makeUnsafe("logs-live");
        yield* seedThread({ sql, threadId: archived, archivedAt: daysAgo(1), deletedAt: null });
        yield* seedThread({ sql, threadId: live, deletedAt: null });
        const logPath = (name: string) => NodePath.join(config.providerLogsDir, `${name}.log`);
        const write = async (name: string, ageDays: number) => {
          await writeFile(logPath(name), "log");
          const when = new Date(Date.now() - ageDays * DAY_MS);
          await NodeFS.utimes(logPath(name), when, when);
        };
        yield* Effect.promise(async () => {
          await write(toSafeThreadAttachmentSegment(archived)!, 20);
          await write(toSafeThreadAttachmentSegment(live)!, 20);
          await write("logs-unknown-thread", 20);
          await write("logs-unknown-recent", 1);
        });

        const archivedLog = `${toSafeThreadAttachmentSegment(archived)}.log`;
        const exists = (name: string) => Effect.promise(() => pathExists(logPath(name)));
        // Archived threads can be unarchived: their logs are kept unless asked.
        const listed = yield* storage.listTerminalThreadLogs({
          modifiedBefore: daysAgo(14),
          includeArchived: false,
        });
        assert.deepStrictEqual(
          listed.map((file) => file.name),
          ["logs-unknown-thread.log"],
        );
        const result = yield* storage.pruneTerminalThreadLogs({
          operationId: "terminal-logs",
          modifiedBefore: daysAgo(14),
          includeArchived: false,
        });
        assert.equal(result.perTargetReclaimed.length, 1);
        assert.isTrue(yield* exists(toSafeThreadAttachmentSegment(archived)!));
        assert.isTrue(yield* exists(toSafeThreadAttachmentSegment(live)!));
        assert.isTrue(yield* exists("logs-unknown-recent"));
        assert.isFalse(yield* exists("logs-unknown-thread"));

        // A thread unarchived after a preview listed its log keeps the log:
        // the prune lists again under the maintenance lock.
        const preview = yield* storage.listTerminalThreadLogs({
          modifiedBefore: daysAgo(14),
          includeArchived: true,
        });
        assert.deepStrictEqual(
          preview.map((file) => file.name),
          [archivedLog],
        );
        yield* sql`UPDATE projection_threads SET archived_at = NULL WHERE thread_id = ${archived}`;
        const afterUnarchive = yield* storage.pruneTerminalThreadLogs({
          operationId: "terminal-logs-unarchived",
          modifiedBefore: daysAgo(14),
          includeArchived: true,
        });
        assert.equal(afterUnarchive.perTargetReclaimed.length, 0);
        assert.isTrue(yield* exists(toSafeThreadAttachmentSegment(archived)!));

        yield* sql`
          UPDATE projection_threads SET archived_at = ${daysAgo(1)} WHERE thread_id = ${archived}
        `;
        const withArchived = yield* storage.pruneTerminalThreadLogs({
          operationId: "terminal-logs-archived",
          modifiedBefore: daysAgo(14),
          includeArchived: true,
        });
        assert.equal(withArchived.perTargetReclaimed.length, 1);
        assert.isFalse(yield* exists(toSafeThreadAttachmentSegment(archived)!));
      }),
    ),
  );

  it.effect("purges missing workspaces with a warning while preserving busy threads", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const stuck = ThreadId.makeUnsafe("purge-stuck");
        const busy = ThreadId.makeUnsafe("purge-busy");
        const purgeable = ThreadId.makeUnsafe("purge-ok");
        // Oldest: checkpoint refs but no workspace to delete them from.
        yield* seedThread({ sql, threadId: stuck, deletedAt: daysAgo(30) });
        yield* sql`
          UPDATE projection_threads SET project_id = 'project-gone' WHERE thread_id = ${stuck}
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, state, requested_at, checkpoint_turn_count, checkpoint_ref,
            checkpoint_files_json
          ) VALUES (
            ${stuck}, 'turn-stuck', 'completed', ${daysAgo(30)}, 1, 'refs/t3/checkpoints/stuck', '[]'
          )
        `;
        // Next: a deleted thread whose session is still running.
        yield* seedThread({ sql, threadId: busy, deletedAt: daysAgo(20) });
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id, provider_thread_id,
            active_turn_id, last_error, updated_at
          ) VALUES (
            ${busy}, 'running', 'codex', 'session-busy', 'thread-busy', NULL, NULL, ${daysAgo(0)}
          )
        `;
        yield* seedThread({ sql, threadId: purgeable, deletedAt: daysAgo(10) });
        const pass = (operationId: string) =>
          storage.purgeThreads({
            operationId,
            deletedBefore: daysAgo(7),
            archivedBefore: null,
            maxThreads: 1,
          });

        // Missing recorded workspaces no longer prevent a purge. Ref copies in
        // a moved repository are explicitly reported and left alone.
        const first = yield* pass("purge-first");
        assert.deepStrictEqual(first.purgedThreadIds, [stuck]);
        assert.equal(yield* countRows(sql, "projection_threads", stuck), 0);
        assert.isTrue(
          first.warnings.some((warning) => warning.reason.includes("moved repository")),
        );
        // ...and then waits behind the thread that can be purged.
        const second = yield* pass("purge-second");
        assert.deepStrictEqual(second.purgedThreadIds, [purgeable]);
        assert.equal(yield* countRows(sql, "projection_threads", busy), 1);
      }),
    ),
  );

  it.effect("returns free pages of an incremental database in steps", () =>
    Effect.gen(function* () {
      const storage = yield* StorageMaintenance;
      const sql = yield* SqlClient.SqlClient;
      const autoVacuum = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
      assert.equal(autoVacuum[0]?.auto_vacuum, 2);
      yield* sql`CREATE TABLE filler (value TEXT)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
        INSERT INTO filler SELECT printf('%.4000c', 'x') FROM n
      `;
      yield* sql`DELETE FROM filler`;
      const before = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      assert.isAbove(before[0]!.freelist_count, 1_000);

      const result = yield* storage.reclaimDatabaseSpace({ maxDurationMs: 10_000 });
      assert.equal(result.action, "incremental");
      // This fixture uses :memory:; releasing pages frees no on-disk bytes.
      assert.equal(result.reclaimedBytes, 0);
      const after = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      assert.equal(after[0]!.freelist_count, 0);
      assert.deepStrictEqual(yield* storage.reclaimDatabaseSpace({ maxDurationMs: 10_000 }), {
        action: "none",
        reclaimedBytes: 0,
      });
    }),
  );
});

it.effect("successful compaction without file-size reduction stays succeeded", () =>
  withHomeSandbox(
    Effect.gen(function* () {
      const storage = yield* StorageMaintenance,
        config = yield* ServerConfig;
      yield* Effect.promise(async () => {
        await NodeFS.mkdir(NodePath.dirname(config.dbPath), { recursive: true });
        const db = await openRuntimeSqliteDatabase(config.dbPath, { readOnly: false });
        try {
          db.exec(
            "PRAGMA auto_vacuum=INCREMENTAL; CREATE TABLE kept(value TEXT); INSERT INTO kept VALUES ('kept'); VACUUM",
          );
        } finally {
          db.close();
        }
      });
      const report = yield* storage.inspect({ force: true });
      const operation = yield* storage.acceptCleanup({
        operationId: "already-compact",
        backendEpoch: (yield* storage.getStatus).backendEpoch,
        scanId: report.scanId,
        nonce: report.confirmationNonce,
        categoryIds: ["databaseVacuum"],
        confirmationText: "DELETE",
      });
      const result = yield* awaitOperation(storage, operation.operationId);
      assert.equal(result.status.state, "succeeded");
      assert.equal(result.status.result?.reclaimedBytes, 0);
      assert.deepStrictEqual(result.status.result?.warnings, []);
    }),
  ).pipe(Effect.provide(makeStorageTestLayer())),
);

it.layer(makeStorageTestLayer())("StorageMaintenance scan and operation safety", (it) => {
  for (const afterMark of [false, true]) {
    it.effect(
      `cancelling orphan cleanup ${afterMark ? "after" : "before"} marking preserves lifecycle safety`,
      () =>
        withHomeSandbox(
          Effect.gen(function* () {
            const storage = yield* StorageMaintenance,
              sql = yield* SqlClient.SqlClient,
              config = yield* ServerConfig;
            const threadId = ThreadId.makeUnsafe(`attachment-cancel-${afterMark}`);
            yield* seedThread({ sql, threadId, deletedAt: null });
            const id = `cancel-image-${afterMark}`,
              path = NodePath.join(config.attachmentsDir, id);
            yield* Effect.promise(() => writeFile(path, "image bytes"));
            yield* sql`INSERT INTO attachments(attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash, final_path, lifecycle, created_at, updated_at)
          VALUES (${id}, ${threadId}, 'image', 'cancel.png', 'image/png', 11, 'hash', ${path}, 'ready', '2026-01-01', '2026-01-01')`;
            const report = yield* storage.inspect({ force: true });
            const operationId = `cancel-attachment-${afterMark}`;
            if (afterMark) {
              const original = yield* Effect.promise(() =>
                vi.importActual<typeof import("./storagePathSafety.ts")>("./storagePathSafety.ts"),
              );
              vi.mocked(removeFileIfSafe).mockImplementationOnce(async (input) => {
                const rows = await Effect.runPromise(
                  sql<{
                    lifecycle: string;
                  }>`SELECT lifecycle FROM attachments WHERE attachment_id = ${id}`,
                );
                assert.equal(rows[0]?.lifecycle, "deleting");
                await Effect.runPromise(storage.cancel(operationId));
                return original.removeFileIfSafe(input);
              });
            }
            const result = yield* storage.cleanup(
              {
                operationId,
                scanId: report.scanId,
                nonce: report.confirmationNonce,
                categoryIds: ["orphanAttachments"],
                targetSelections: [{ categoryId: "orphanAttachments", targetIds: [id] }],
                options: { vacuumAfterDeletes: false },
              },
              {
                publishProgress: (progress) =>
                  !afterMark &&
                  progress.categoryId === "orphanAttachments" &&
                  progress.phase === "deleting"
                    ? storage.cancel(operationId)
                    : Effect.void,
              },
            );
            assert.isTrue(result.cancelled);
            const rows = yield* sql<{
              lifecycle: string;
            }>`SELECT lifecycle FROM attachments WHERE attachment_id = ${id}`;
            assert.equal(rows.length, afterMark ? 0 : 1);
            if (!afterMark) {
              assert.equal(rows[0]?.lifecycle, "ready");
              yield* sql`INSERT INTO attachment_owners VALUES (${id}, 'ingress', 'cancelled-cleanup-reused', '2026-01-01')`;
            }
            assert.equal(yield* Effect.promise(() => pathExists(path)), !afterMark);
            assert.equal(
              (yield* sql`SELECT 1 FROM attachment_cleanup_jobs WHERE attachment_id = ${id}`)
                .length,
              0,
            );
          }),
        ),
    );
  }
  it.effect(
    "retains a long-running operation from completion, including idempotent acceptance",
    () =>
      withHomeSandbox(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance,
            sql = yield* SqlClient.SqlClient,
            config = yield* ServerConfig;
          const threadId = ThreadId.makeUnsafe("long-attachment-cleanup");
          yield* seedThread({ sql, threadId, deletedAt: null });
          const path = NodePath.join(config.attachmentsDir, "long-cleanup.png");
          yield* Effect.promise(() => writeFile(path, "image bytes"));
          yield* sql`INSERT INTO attachments(attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash, final_path, lifecycle, created_at, updated_at)
        VALUES ('long-cleanup', ${threadId}, 'image', 'long.png', 'image/png', 11, 'hash', ${path}, 'ready', '2026-01-01', '2026-01-01')`;
          const report = yield* storage.inspect({ force: true });
          const request = {
            operationId: "long-cleanup",
            backendEpoch: (yield* storage.getStatus).backendEpoch,
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["orphanAttachments"] as const,
            targetSelections: [
              { categoryId: "orphanAttachments" as const, targetIds: ["long-cleanup"] },
            ],
            options: { vacuumAfterDeletes: false },
          };
          const started = Date.now();
          vi.useFakeTimers({ toFake: ["Date"] });
          yield* Effect.gen(function* () {
            const original = yield* Effect.promise(() =>
              vi.importActual<typeof import("./storagePathSafety.ts")>("./storagePathSafety.ts"),
            );
            vi.mocked(removeFileIfSafe).mockImplementationOnce(async (input) => {
              vi.setSystemTime(started + 20 * 60_000);
              return original.removeFileIfSafe(input);
            });
            yield* storage.acceptCleanup(request);
            const finished = yield* awaitOperation(storage, request.operationId);
            assert.equal(finished.status.state, "succeeded");
            assert.equal(finished.results[0]?.perTargetReclaimed[0]?.id, "long-cleanup");
            assert.equal((yield* storage.acceptCleanup(request)).state, "succeeded");
            vi.setSystemTime(started + 34 * 60_000);
            assert.equal(
              (yield* storage.getOperation({ operationId: request.operationId })).status.state,
              "succeeded",
            );
            vi.setSystemTime(started + 36 * 60_000);
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(storage.getOperation({ operationId: request.operationId })),
              ),
            );
          }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
        }),
      ),
  );

  it.effect(
    "accepts an operation once and rejects conflicting reuse or a previous backend epoch",
    () =>
      withHomeSandbox(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance,
            config = yield* ServerConfig;
          const log = NodePath.join(config.providerLogsDir, "operation-orphan.log");
          yield* Effect.promise(() => writeFile(log, "data"));
          const report = yield* storage.inspect({ force: true });
          const request = {
            operationId: "test-idempotent",
            backendEpoch: (yield* storage.getStatus).backendEpoch,
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["providerLogsForTerminalThreads"] as const,
            options: { vacuumAfterDeletes: false },
          };
          const first = yield* storage.acceptCleanup(request),
            second = yield* storage.acceptCleanup(request);
          assert.equal(first.operationId, second.operationId);
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                storage.acceptCleanup({ ...request, confirmationText: "changed" }),
              ),
            ),
          );
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                storage.acceptCleanup({ ...request, backendEpoch: "previous-backend" }),
              ),
            ),
          );
          const result = yield* awaitOperation(storage, request.operationId);
          assert.equal(result.status.state, "succeeded");
          assert.isFalse(yield* Effect.promise(() => pathExists(log)));
          assert.equal((yield* storage.acceptCleanup(request)).state, "succeeded");
        }),
      ),
  );
  it.effect("shares a scan nonce across windows and rejects it after a real mutation", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const report = yield* storage.inspect({ force: true });
        const first = yield* storage.getUsage(),
          second = yield* storage.getUsage();
        assert.deepStrictEqual(first.confirmation, second.confirmation);
        yield* storage.noteStorageMutated;
        const result = yield* Effect.exit(
          storage.cleanup({
            operationId: "stale-generation",
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["databaseVacuum"],
            confirmationText: "DELETE",
          }),
        );
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result))
          assert.include((Cause.squash(result.cause) as Error).message, "Storage changed");
      }),
    ),
  );
  it.effect("retains orphan attachment metadata and retry jobs when unlink is refused", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance,
          sql = yield* SqlClient.SqlClient,
          config = yield* ServerConfig;
        const threadId = ThreadId.makeUnsafe("orphan-refused-thread"),
          path = NodePath.join(config.attachmentsDir, "directory-instead-of-file");
        yield* seedThread({ sql, threadId, deletedAt: null });
        yield* Effect.promise(() => NodeFS.mkdir(path, { recursive: true }));
        yield* sql`INSERT INTO attachments(attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash, final_path, lifecycle, created_at, updated_at)
      VALUES ('orphan-refused', ${threadId}, 'image', 'refused.png', 'image/png', 0, 'hash', ${path}, 'ready', '2026-01-01', '2026-01-01')`;
        const report = yield* storage.inspect({ force: true });
        const result = yield* storage.cleanup({
          operationId: "orphan-refusal",
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: ["orphanAttachments"],
          options: { vacuumAfterDeletes: false },
        });
        assert.equal(result.reclaimedBytes, 0);
        const rows = yield* sql<{
          lifecycle: string;
          lastError: string;
        }>`SELECT lifecycle, last_error AS "lastError" FROM attachments JOIN attachment_cleanup_jobs USING (attachment_id) WHERE attachment_id = 'orphan-refused'`;
        assert.equal(rows[0]?.lifecycle, "deleting");
        assert.include(rows[0]?.lastError ?? "", "non-file");
        for (const kind of [
          "ingress",
          "queue_item",
          "message",
          "user_input",
          "rewind_draft",
          "activity",
        ]) {
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                sql`INSERT INTO attachment_owners VALUES ('orphan-refused', ${kind}, 'owner', '2026-01-01')`,
              ),
            ),
          );
        }
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              sql`UPDATE attachments SET lifecycle = 'ready' WHERE attachment_id = 'orphan-refused'`,
            ),
          ),
        );
        // Refusal does not permanently reserve this content-addressed id.
        // After correcting the filesystem problem, confirmed cleanup finalizes
        // the absent bytes and deletes the old registry/job, permitting reuse.
        yield* Effect.promise(() => NodeFS.rmdir(path));
        const retry = yield* storage.inspect({ force: true });
        yield* storage.cleanup({
          operationId: "orphan-refusal-retry",
          scanId: retry.scanId,
          nonce: retry.confirmationNonce,
          categoryIds: ["orphanAttachments"],
          options: { vacuumAfterDeletes: false },
        });
        const remaining =
          yield* sql`SELECT 1 FROM attachments WHERE attachment_id = 'orphan-refused'`;
        assert.equal(remaining.length, 0);
        const jobs =
          yield* sql`SELECT 1 FROM attachment_cleanup_jobs WHERE attachment_id = 'orphan-refused'`;
        assert.equal(jobs.length, 0);
      }),
    ),
  );
  for (const archived of [false, true])
    it.effect(
      `retains files before purging a ${archived ? "archived" : "deleted"} thread owned by a scheduled run`,
      () =>
        withHomeSandbox(
          Effect.gen(function* () {
            const storage = yield* StorageMaintenance;
            const sql = yield* SqlClient.SqlClient;
            const config = yield* ServerConfig;
            const threadId = ThreadId.makeUnsafe(`scheduled-purge-${archived}`);
            const file = NodePath.join(
              config.attachmentsDir,
              `${threadId}-11111111-1111-4111-8111-111111111111.txt`,
            );
            yield* seedThread({
              sql,
              threadId,
              archivedAt: archived ? daysAgo(90) : null,
              deletedAt: archived ? null : daysAgo(40),
            });
            yield* Effect.promise(() => writeFile(file, "execution evidence"));
            yield* sql`INSERT INTO scheduled_tasks(id,project_id,definition_json,request_hash,requested_at,version,enabled,updated_at)
          VALUES(${`owned-task:${archived}`},'project','{}','hash','2026-01-01',1,0,'2026-01-01')`;
            yield* sql`INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,state_json,snapshot_json,thread_id,owns_execution,canceled,capacity,created_at)
          VALUES(${`owned-run:${archived}`},${`owned-task:${archived}`},'2026-01-01','manual','needs_attention','{}','{}',${threadId},1,1,1,'2026-01-01')`;
            const report = yield* storage.inspect({ force: true });
            const result = yield* storage.cleanup({
              operationId: `scheduled-purge:${archived}`,
              scanId: report.scanId,
              nonce: report.confirmationNonce,
              categoryIds: [archived ? "purgeArchivedThreads" : "purgeDeletedThreads"],
              ...(archived ? { confirmationText: "DELETE" } : {}),
              options: { vacuumAfterDeletes: false },
            });
            assert.equal(
              yield* Effect.promise(() => NodeFS.readFile(file, "utf8")),
              "execution evidence",
            );
            assert.equal(yield* countRows(sql, "projection_threads", threadId), 1);
            assert.isTrue(
              result.warnings.some((warning) => warning.reason.includes("scheduled run")),
            );
            assert.equal(result.reclaimedBytes, 0);
          }),
        ),
    );
  it.effect("preserves settlement process claims across attempted permanent thread purge", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("settlement-purge-claim");
        const archivedAt = daysAgo(90);
        yield* seedThread({ sql, threadId, archivedAt, deletedAt: null });
        yield* sql`INSERT INTO thread_settlement_hooks(thread_id,job_id,settled_at,worktree_path,project_id,scripts_json,state,updated_at) SELECT thread_id,'hook',${archivedAt},'/tmp/settlement-hook',project_id,'[]','pending',${archivedAt} FROM projection_threads WHERE thread_id=${threadId}`;
        for (const state of ["pending", "running", "orphaned"]) {
          yield* sql`UPDATE thread_settlement_hooks SET state=${state} WHERE thread_id=${threadId}`;
          const report = yield* storage.inspect({ force: true });
          const result = yield* storage.cleanup({
            operationId: `settlement-purge-${state}`,
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["purgeArchivedThreads"],
            confirmationText: "DELETE",
            options: { vacuumAfterDeletes: false },
          });
          assert.isTrue(
            result.warnings.some((warning) => warning.reason.includes("Settlement script")),
          );
          assert.lengthOf(
            yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL`,
            1,
          );
          assert.equal(
            (yield* sql<{
              state: string;
            }>`SELECT state FROM thread_settlement_hooks WHERE thread_id=${threadId}`)[0]?.state,
            state,
          );
        }
      }),
    ),
  );

  it.effect("blocks archived purge before deletion when a native operation needs recovery", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance,
          sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("archived-native-recovery"),
          archivedAt = daysAgo(90);
        yield* seedThread({ sql, threadId, archivedAt, deletedAt: null });
        yield* sql`INSERT INTO native_operations VALUES ('native-recovery', ${threadId}, 0, 'indeterminate', '{}', '2026-01-01', '2026-01-01')`;
        const report = yield* storage.inspect({ force: true });
        const result = yield* storage.cleanup({
          operationId: "blocked-archived",
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: ["purgeArchivedThreads"],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });
        const rows = yield* sql<{
          archivedAt: string;
          deletedAt: string | null;
        }>`SELECT archived_at AS "archivedAt", deleted_at AS "deletedAt" FROM projection_threads WHERE thread_id = ${threadId}`;
        assert.equal(rows[0]?.archivedAt, archivedAt);
        assert.isNull(rows[0]?.deletedAt);
        assert.isTrue(
          result.warnings.some((warning) => warning.reason.includes("Native operation")),
        );
      }),
    ),
  );
  it.effect("retries SQL rollback after files have already been removed", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance,
          sql = yield* SqlClient.SqlClient,
          config = yield* ServerConfig;
        const threadId = ThreadId.makeUnsafe("rollback-after-files"),
          file = NodePath.join(
            config.attachmentsDir,
            `${threadId}-11111111-1111-4111-8111-111111111111.txt`,
          );
        yield* seedThread({ sql, threadId, deletedAt: daysAgo(40) });
        yield* Effect.promise(() => writeFile(file, "retryable bytes"));
        yield* sql`CREATE TRIGGER block_test_purge BEFORE DELETE ON projection_threads WHEN OLD.thread_id = 'rollback-after-files' BEGIN SELECT RAISE(ABORT, 'test SQL failure'); END`;
        const first = yield* storage.inspect({ force: true });
        const failed = yield* storage.cleanup({
          operationId: "rollback-first",
          scanId: first.scanId,
          nonce: first.confirmationNonce,
          categoryIds: ["purgeDeletedThreads"],
          options: { vacuumAfterDeletes: false },
        });
        assert.equal(yield* countRows(sql, "projection_threads", threadId), 1);
        assert.isFalse(yield* Effect.promise(() => pathExists(file)));
        assert.isTrue(
          failed.warnings.some((warning) =>
            warning.reason.startsWith("Deleted, cleanup incomplete"),
          ),
        );
        assert.isAbove(failed.reclaimedBytes, 0);
        yield* sql`DROP TRIGGER block_test_purge`;
        const second = yield* storage.inspect({ force: true });
        const retried = yield* storage.cleanup({
          operationId: "rollback-second",
          scanId: second.scanId,
          nonce: second.confirmationNonce,
          categoryIds: ["purgeDeletedThreads"],
          options: { vacuumAfterDeletes: false },
        });
        assert.equal(yield* countRows(sql, "projection_threads", threadId), 0);
        assert.equal(retried.reclaimedBytes, 0);
        assert.isTrue(
          retried.results[0]?.perTargetReclaimed.some(
            (target) => target.id === threadId && target.status === "Removed",
          ),
        );
      }),
    ),
  );
  it.effect(
    "retains an archived thread before the boundary and reports incomplete deletion after it",
    () =>
      withHomeSandbox(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance,
            sql = yield* SqlClient.SqlClient,
            config = yield* ServerConfig;
          const threadId = ThreadId.makeUnsafe("archived-unsafe-file"),
            file = NodePath.join(config.attachmentsDir, "unsafe-file.png");
          yield* seedThread({ sql, threadId, archivedAt: daysAgo(90), deletedAt: null });
          yield* Effect.promise(() => NodeFS.symlink(config.stateDir, file));
          yield* sql`INSERT INTO attachments(attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash, final_path, lifecycle, created_at, updated_at) VALUES ('unsafe-file', ${threadId}, 'image', 'unsafe.png', 'image/png', 0, 'hash', ${file}, 'ready', '2026-01-01', '2026-01-01')`;
          const report = yield* storage.inspect({ force: true });
          const result = yield* storage.cleanup({
            operationId: "archived-boundary",
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["purgeArchivedThreads"],
            confirmationText: "DELETE",
            options: { vacuumAfterDeletes: false },
          });
          const rows = yield* sql<{
            deletedAt: string | null;
          }>`SELECT deleted_at AS "deletedAt" FROM projection_threads WHERE thread_id = ${threadId}`;
          assert.isNotNull(rows[0]?.deletedAt);
          assert.isTrue(
            result.results[0]?.perTargetReclaimed.some(
              (target) => target.status === "Deleted, cleanup incomplete",
            ),
          );
          assert.isTrue(yield* Effect.promise(() => pathExists(file)));
        }),
      ),
  );
  it.effect("cancels while waiting for provider access before the archived delete boundary", () =>
    withHomeSandbox(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance,
            sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.makeUnsafe("cancel-before-boundary");
          yield* seedThread({ sql, threadId, archivedAt: daysAgo(90), deletedAt: null });
          const report = yield* storage.inspect({ force: true });
          const entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          yield* withProviderThreadAccess(
            threadId,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Effect.forkIn(yield* Scope.Scope));
          yield* Deferred.await(entered);
          const operation = yield* storage.acceptCleanup({
            operationId: "cancel-queued",
            backendEpoch: (yield* storage.getStatus).backendEpoch,
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["purgeArchivedThreads"],
            confirmationText: "DELETE",
            options: { vacuumAfterDeletes: false },
          });
          yield* storage.cancel(operation.operationId);
          yield* Deferred.succeed(release, undefined);
          const result = yield* awaitOperation(storage, operation.operationId);
          assert.equal(result.status.state, "cancelled");
          assert.deepStrictEqual(result.status.result?.results, []);
          const rows = yield* sql<{
            deletedAt: string | null;
          }>`SELECT deleted_at AS "deletedAt" FROM projection_threads WHERE thread_id = ${threadId}`;
          assert.isNull(rows[0]?.deletedAt);
        }),
      ),
    ),
  );
});

it.effect(
  "getUsage returns before a blocked worktree readiness check and joins repeated rescans",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const base = makeGitCoreStub();
      const blocked = makeGitCoreStub({
        status: (input) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(base.status(input)),
          ),
      });
      return yield* withHomeSandbox(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance,
            config = yield* ServerConfig;
          const path = NodePath.join(config.worktreesDir, "blocked-readiness");
          yield* Effect.promise(() =>
            writeGitWorktreeMetadata({
              worktreePath: path,
              mainWorktreePath: NodePath.join(config.baseDir, "main-readiness"),
            }),
          );
          const first = yield* storage.getUsage({ force: true });
          assert.isNull(first.report);
          assert.equal(first.status.scan.state, "scanning");
          yield* Deferred.await(entered);
          const second = yield* storage.getUsage({ force: true });
          assert.isNull(second.report);
          assert.equal(second.status.scan.startedAt, first.status.scan.startedAt);
          yield* Deferred.succeed(release, undefined);
          const report = yield* storage.inspect();
          assert.equal(
            report.categories.find((category) => category.id === "inactiveF5Worktrees")
              ?.targetCount,
            1,
          );
        }).pipe(
          Effect.provide(makeStorageTestLayer({ gitCore: blocked })),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        ),
      );
    }),
);

function seedProject(input: {
  readonly sql: SqlClient.SqlClient;
  readonly projectId: string;
  readonly workspaceRoot: string;
}) {
  const now = new Date().toISOString();
  return input.sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model, scripts_json, created_at, updated_at, deleted_at
    )
    VALUES (
      ${ProjectId.makeUnsafe(input.projectId)}, ${input.projectId}, ${input.workspaceRoot},
      ${null}, ${"[]"}, ${now}, ${now}, ${null}
    )
  `;
}

const localBranches = (cwd: string) =>
  runGit(cwd, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

const registeredPaths = (cwd: string) =>
  runGit(cwd, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => NodePath.normalize(line.slice("worktree ".length)));

it.layer(
  makeStorageTestLayer({
    gitCore: "real",
    settings: {
      worktreeDisposablePaths: ["README.md"],
      providers: {
        codex: { homePath: NodePath.join(NodeOS.tmpdir(), "f5-storage-real-git-codex-home") },
      },
    },
  }),
)("StorageMaintenance worktree cleanup against real repositories", (it) => {
  it.effect(
    "removes inactive F5 worktrees and deletes only merged, unreferenced branches",
    () =>
      withHomeSandbox(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance;
          const config = yield* ServerConfig;
          const sql = yield* SqlClient.SqlClient;
          const repo = yield* Effect.promise(() => makeClonedRepo("f5-storage-managed-"));
          yield* Effect.addFinalizer(() => Effect.promise(repo.cleanup));
          const managed = (name: string) => NodePath.join(config.worktreesDir, "managed", name);
          yield* Effect.promise(async () => {
            runGit(repo.root, "worktree", "add", "-q", "-b", "merged-a", managed("a"), "main");
            runGit(repo.root, "worktree", "add", "-q", "-b", "pushed-b", managed("b"), "main");
            await writeFile(NodePath.join(managed("b"), "b.txt"), "b\n");
            runGit(managed("b"), "add", ".");
            runGit(managed("b"), "commit", "-q", "-m", "b");
            runGit(managed("b"), "push", "-q", "-u", "origin", "pushed-b");
            runGit(repo.root, "worktree", "add", "-q", "-b", "archived-c", managed("c"), "main");
            runGit(repo.root, "worktree", "add", "-q", "-b", "ahead-d", managed("d"), "main");
            await writeFile(NodePath.join(managed("d"), "d.txt"), "d\n");
            runGit(managed("d"), "add", ".");
            runGit(managed("d"), "commit", "-q", "-m", "d");
            // Ignored build output no longer blocks storage cleanup.
            await writeFile(
              NodePath.join(repo.root, ".git", "info", "exclude"),
              "dist/\n*.tsbuildinfo\n",
            );
            await writeFile(NodePath.join(managed("a"), "node_modules", "x", "index.js"), "x");
            await writeFile(NodePath.join(managed("a"), "dist", "index.js"), "x");
            await writeFile(NodePath.join(managed("a"), "app.tsbuildinfo"), "{}");
            // The default branch, and a long-lived branch with a live upstream, are kept even
            // when merged; a branch that only tracks origin/main is not long-lived.
            runGit(repo.root, "checkout", "-q", "-b", "feature-x");
            runGit(repo.root, "worktree", "add", "-q", managed("m"), "main");
            runGit(repo.root, "branch", "release-1", "main");
            runGit(repo.root, "push", "-q", "-u", "origin", "release-1");
            runGit(repo.root, "worktree", "add", "-q", managed("r"), "release-1");
            runGit(
              repo.root,
              "worktree",
              "add",
              "-q",
              "--track",
              "-b",
              "tracks-main",
              managed("t"),
              "origin/main",
            );
          });
          yield* seedProject({ sql, projectId: "project-managed", workspaceRoot: repo.root });
          yield* seedThread({
            sql,
            threadId: ThreadId.makeUnsafe("thread-archived-managed-c"),
            archivedAt: "2026-04-01T00:00:00.000Z",
            deletedAt: null,
            worktreePath: managed("c"),
          });

          const report = yield* storage.inspect({ force: true });
          const category = report.categories.find((entry) => entry.id === "inactiveF5Worktrees");
          const target = (name: string) =>
            category?.targets.find((entry) => entry.path === managed(name));
          assert.equal(target("a")?.safeToDelete, true, target("a")?.disabledReason);
          assert.equal(target("b")?.safeToDelete, true, target("b")?.disabledReason);
          assert.equal(target("c")?.safeToDelete, true, target("c")?.disabledReason);
          assert.equal(target("d")?.safeToDelete, false);
          assert.equal(
            target("d")?.disabledReason,
            "it has commits that are not in origin/main and not pushed",
          );
          // The managed worktrees are not offered again as external ones.
          assert.deepEqual(
            report.categories.find((entry) => entry.id === "externalWorktrees")?.targets ?? [],
            [],
          );

          const result = yield* storage.cleanup({
            operationId: "operation-real-managed-worktrees",
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["inactiveF5Worktrees"],
            targetSelections: [
              {
                categoryId: "inactiveF5Worktrees",
                targetIds: ["a", "b", "c", "m", "r", "t"].map((name) => target(name)!.id),
              },
            ],
            confirmationText: "DELETE",
            options: { vacuumAfterDeletes: false },
          });

          const reclaimed = result.results[0]?.perTargetReclaimed ?? [];
          assert.equal(result.results[0]?.status, "Cleaned");
          assert.deepEqual(reclaimed.map((entry) => [entry.path, entry.branch]).toSorted(), [
            [managed("a"), "deleted"],
            [managed("b"), "kept"],
            [managed("c"), "kept"],
            [managed("m"), "kept"],
            [managed("r"), "kept"],
            [managed("t"), "deleted"],
          ]);
          const branches = localBranches(repo.root);
          assert.notInclude(branches, "merged-a");
          assert.notInclude(branches, "tracks-main");
          assert.include(branches, "main");
          assert.include(branches, "release-1");
          assert.include(branches, "pushed-b");
          assert.include(branches, "archived-c");
          assert.include(branches, "ahead-d");
          assert.equal(yield* Effect.promise(() => pathExists(managed("d"))), true);
        }),
      ),
    // Seven real worktrees, each inspected and removed with several Git calls.
    60_000,
  );

  it.effect(
    "offers external worktrees and missing registrations, discarding reviewed changes",
    () =>
      withHomeSandbox(
        Effect.gen(function* () {
          const storage = yield* StorageMaintenance;
          const config = yield* ServerConfig;
          const sql = yield* SqlClient.SqlClient;
          yield* Effect.promise(() => new ProfileRegistryStore(config.defaultStateDir!).init());
          const repo = yield* Effect.promise(() => makeClonedRepo("f5-storage-external-"));
          yield* Effect.addFinalizer(() => Effect.promise(repo.cleanup));
          const external = NodePath.join(repo.dir, "external-e");
          const kept = NodePath.join(repo.dir, "external-kept");
          const gone = NodePath.join(repo.dir, "gone-g");
          yield* Effect.promise(async () => {
            runGit(repo.root, "worktree", "add", "-q", "-b", "external-e", external, "main");
            await NodeFS.writeFile(NodePath.join(external, "README.md"), "regenerated\n");
            runGit(repo.root, "worktree", "add", "-q", "-b", "external-kept", kept, "main");
            await NodeFS.writeFile(NodePath.join(kept, ".env"), "SECRET=1\n");
            runGit(repo.root, "worktree", "add", "-q", "-b", "gone-g", gone, "main");
            await NodeFS.rm(gone, { recursive: true, force: true });
          });
          yield* seedProject({ sql, projectId: "project-external", workspaceRoot: repo.root });

          const report = yield* storage.inspect({ force: true });
          const externalCategory = report.categories.find(
            (entry) => entry.id === "externalWorktrees",
          );
          const staleCategory = report.categories.find(
            (entry) => entry.id === "staleWorktreeRegistrations",
          );
          assert.equal(externalCategory?.defaultSelected, false);
          assert.equal(externalCategory?.impact, "high");
          assert.equal(staleCategory?.defaultSelected, true);
          const externalTarget = externalCategory?.targets.find((entry) => entry.path === external);
          const keptTarget = externalCategory?.targets.find((entry) => entry.path === kept);
          const staleTarget = staleCategory?.targets.find((entry) => entry.path === gone);
          assert.equal(externalTarget?.safeToDelete, true, externalTarget?.disabledReason);
          assert.equal(
            externalTarget?.detail,
            "External · external-e · Discards 1 changed file: README.md",
          );
          assert.equal(keptTarget?.safeToDelete, false);
          assert.match(keptTarget?.disabledReason ?? "", /\.env/);
          assert.equal(staleTarget?.safeToDelete, true);
          assert.equal(staleTarget?.bytes, 0);

          const result = yield* storage.cleanup({
            operationId: "operation-real-external-worktrees",
            scanId: report.scanId,
            nonce: report.confirmationNonce,
            categoryIds: ["externalWorktrees", "staleWorktreeRegistrations"],
            targetSelections: [
              { categoryId: "externalWorktrees", targetIds: [externalTarget!.id] },
              { categoryId: "staleWorktreeRegistrations", targetIds: [staleTarget!.id] },
            ],
            confirmationText: "DELETE",
            options: { vacuumAfterDeletes: false },
          });

          assert.deepEqual(
            result.results.map((entry) => [entry.categoryId, entry.status]),
            [
              ["externalWorktrees", "Cleaned"],
              ["staleWorktreeRegistrations", "Cleaned"],
            ],
          );
          assert.equal(yield* Effect.promise(() => pathExists(external)), false);
          assert.equal(yield* Effect.promise(() => pathExists(kept)), true);
          const registered = registeredPaths(repo.root);
          assert.notInclude(registered, external);
          assert.notInclude(registered, gone);
          assert.include(registered, kept);
          assert.notInclude(localBranches(repo.root), "external-e");
        }),
      ),
  );

  it.effect("refuses external cleanup when local changes differ from the reviewed ones", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.promise(() => new ProfileRegistryStore(config.defaultStateDir!).init());
        const repo = yield* Effect.promise(() => makeClonedRepo("f5-storage-drift-"));
        yield* Effect.addFinalizer(() => Effect.promise(repo.cleanup));
        const external = NodePath.join(repo.dir, "external-drift");
        yield* Effect.promise(async () => {
          runGit(repo.root, "worktree", "add", "-q", "-b", "external-drift", external, "main");
          await NodeFS.writeFile(NodePath.join(external, "README.md"), "regenerated\n");
        });
        yield* seedProject({ sql, projectId: "project-drift", workspaceRoot: repo.root });

        const report = yield* storage.inspect({ force: true });
        const target = report.categories
          .find((entry) => entry.id === "externalWorktrees")
          ?.targets.find((entry) => entry.path === external);
        assert.equal(target?.safeToDelete, true, target?.disabledReason);
        yield* Effect.promise(() =>
          NodeFS.writeFile(NodePath.join(external, "README.md"), "edited after review\n"),
        );

        const result = yield* storage.cleanup({
          operationId: "operation-real-external-drift",
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: ["externalWorktrees"],
          targetSelections: [{ categoryId: "externalWorktrees", targetIds: [target!.id] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.notEqual(result.results[0]?.status, "Cleaned");
        assert.equal(yield* Effect.promise(() => pathExists(external)), true);
        assert.equal(
          yield* Effect.promise(() =>
            NodeFS.readFile(NodePath.join(external, "README.md"), "utf8"),
          ),
          "edited after review\n",
        );
      }),
    ),
  );

  it.effect("refuses removal when only staged content changed after review", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.promise(() => new ProfileRegistryStore(config.defaultStateDir!).init());
        const repo = yield* Effect.promise(() => makeClonedRepo("f5-storage-index-"));
        yield* Effect.addFinalizer(() => Effect.promise(repo.cleanup));
        const external = NodePath.join(repo.dir, "external-index");
        yield* Effect.promise(async () => {
          runGit(repo.root, "worktree", "add", "-q", "-b", "external-index", external, "main");
          await NodeFS.writeFile(NodePath.join(external, "README.md"), "staged\n");
          runGit(external, "add", "README.md");
          await NodeFS.writeFile(NodePath.join(external, "README.md"), "working\n");
        });
        yield* seedProject({ sql, projectId: "project-index", workspaceRoot: repo.root });

        const report = yield* storage.inspect({ force: true });
        const target = report.categories
          .find((entry) => entry.id === "externalWorktrees")
          ?.targets.find((entry) => entry.path === external);
        assert.equal(target?.safeToDelete, true, target?.disabledReason);
        // Stage other content without touching the working file; status stays `MM`.
        yield* Effect.promise(async () => {
          const blob = NodePath.join(repo.dir, "blob.txt");
          await NodeFS.writeFile(blob, "written straight to the index\n");
          const sha = runGit(external, "hash-object", "-w", blob);
          runGit(external, "update-index", "--cacheinfo", `100644,${sha},README.md`);
        });

        const result = yield* storage.cleanup({
          operationId: "operation-real-external-index",
          scanId: report.scanId,
          nonce: report.confirmationNonce,
          categoryIds: ["externalWorktrees"],
          targetSelections: [{ categoryId: "externalWorktrees", targetIds: [target!.id] }],
          confirmationText: "DELETE",
          options: { vacuumAfterDeletes: false },
        });

        assert.notEqual(result.results[0]?.status, "Cleaned");
        assert.equal(yield* Effect.promise(() => pathExists(external)), true);
      }),
    ),
  );

  it.effect("applies disposable paths only for projects in the worktree's repository", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const config = yield* ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const owned = yield* Effect.promise(() => makeClonedRepo("f5-storage-owned-"));
        const unowned = yield* Effect.promise(() => makeClonedRepo("f5-storage-unowned-"));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => Promise.all([owned.cleanup(), unowned.cleanup()])),
        );
        const ownedTree = NodePath.join(config.worktreesDir, "owned", "regenerated");
        const unownedTree = NodePath.join(config.worktreesDir, "unowned", "regenerated");
        yield* Effect.promise(async () => {
          runGit(owned.root, "worktree", "add", "-q", "-b", "regen", ownedTree, "main");
          await NodeFS.writeFile(NodePath.join(ownedTree, "README.md"), "regenerated\n");
          runGit(unowned.root, "worktree", "add", "-q", "-b", "regen", unownedTree, "main");
          await NodeFS.writeFile(NodePath.join(unownedTree, "README.md"), "regenerated\n");
          await NodeFS.mkdir(NodePath.join(owned.root, "packages", "app"), { recursive: true });
        });
        // A project rooted in a subdirectory still owns the repository's worktrees.
        yield* seedProject({
          sql,
          projectId: "project-subdirectory",
          workspaceRoot: NodePath.join(owned.root, "packages", "app"),
        });

        const report = yield* storage.inspect({ force: true });
        const targets = report.categories.find(
          (entry) => entry.id === "inactiveF5Worktrees",
        )?.targets;
        const ownedTarget = targets?.find((entry) => entry.path === ownedTree);
        const unownedTarget = targets?.find((entry) => entry.path === unownedTree);

        assert.equal(ownedTarget?.safeToDelete, true, ownedTarget?.disabledReason);
        assert.match(ownedTarget?.detail ?? "", /Discards 1 changed file: README\.md/);
        // No project owns this repository, so the global list does not apply.
        assert.equal(unownedTarget?.safeToDelete, false);
        assert.equal(
          unownedTarget?.disabledReason,
          "it has uncommitted changes (including untracked files)",
        );
      }),
    ),
  );

  it.effect("reports a warning instead of failing when the default branch cannot be fetched", () =>
    withHomeSandbox(
      Effect.gen(function* () {
        const storage = yield* StorageMaintenance;
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* Effect.promise(() => makeClonedRepo("f5-storage-fetch-"));
        yield* Effect.addFinalizer(() => Effect.promise(repo.cleanup));
        runGit(repo.root, "remote", "set-url", "origin", NodePath.join(repo.dir, "missing.git"));
        yield* seedProject({ sql, projectId: "project-fetch", workspaceRoot: repo.root });

        const report = yield* storage.inspect({ force: true });

        assert.isTrue(
          report.warnings.some(
            (warning) =>
              warning.path === repo.root && /Could not refresh origin\/main/.test(warning.reason),
          ),
        );
        assert.isTrue(report.categories.some((entry) => entry.id === "inactiveF5Worktrees"));
      }),
    ),
  );
});

it.layer(makeStorageTestLayer({ gitCore: "real" }))(
  "StorageMaintenance automatic worktree cleanup",
  (it) => {
    it.effect(
      "removes safe managed worktrees and prunes missing entries, never external ones",
      () =>
        withHomeSandbox(
          Effect.gen(function* () {
            const storage = yield* StorageMaintenance;
            const config = yield* ServerConfig;
            const sql = yield* SqlClient.SqlClient;
            yield* Effect.promise(() => new ProfileRegistryStore(config.defaultStateDir!).init());
            const repo = yield* Effect.promise(() => makeClonedRepo("f5-storage-automatic-"));
            yield* Effect.addFinalizer(() => Effect.promise(repo.cleanup));
            const orphan = NodePath.join(config.worktreesDir, "automatic", "orphan");
            const dirty = NodePath.join(config.worktreesDir, "automatic", "dirty");
            const external = NodePath.join(repo.dir, "external-auto");
            const gone = NodePath.join(repo.dir, "gone-auto");
            const goneManaged = yield* Effect.promise(async () => {
              runGit(repo.root, "worktree", "add", "-q", "-b", "orphan", orphan, "main");
              runGit(repo.root, "worktree", "add", "-q", "-b", "dirty", dirty, "main");
              await NodeFS.writeFile(NodePath.join(dirty, "work.txt"), "unsaved\n");
              runGit(repo.root, "worktree", "add", "-q", "-b", "external-auto", external, "main");
              runGit(repo.root, "worktree", "add", "-q", "-b", "gone-auto", gone, "main");
              await NodeFS.rm(gone, { recursive: true, force: true });
              const managedGone = NodePath.join(
                await NodeFS.realpath(NodePath.dirname(orphan)),
                "gone-managed",
              );
              runGit(repo.root, "worktree", "add", "-q", "-b", "gone-managed", managedGone, "main");
              await NodeFS.rm(managedGone, { recursive: true, force: true });
              return managedGone;
            });
            yield* seedProject({ sql, projectId: "project-automatic", workspaceRoot: repo.root });

            // The preview lists what the hourly run would do, and only inside the F5 folder.
            const preview = yield* storage.previewInactiveWorktrees;
            const previewed = new Map(preview.map((entry) => [entry.path, entry.action]));
            assert.equal(previewed.get(orphan), "remove");
            assert.equal(previewed.get(dirty), "skip");
            assert.equal(previewed.get(goneManaged), "remove");
            assert.isFalse(previewed.has(external));
            assert.isFalse(previewed.has(gone));

            const results = yield* storage.cleanInactiveWorktreesAutomatically({
              operationId: "operation-automatic-worktrees",
            });

            const byCategory = new Map(results?.map((entry) => [entry.categoryId, entry]));
            assert.deepEqual(
              byCategory.get("inactiveF5Worktrees")?.perTargetReclaimed.map((entry) => entry.path),
              [orphan],
            );
            assert.deepEqual(
              byCategory
                .get("staleWorktreeRegistrations")
                ?.perTargetReclaimed.map((entry) => entry.path),
              [goneManaged],
            );
            assert.equal(yield* Effect.promise(() => pathExists(orphan)), false);
            assert.equal(yield* Effect.promise(() => pathExists(dirty)), true);
            assert.equal(yield* Effect.promise(() => pathExists(external)), true);
            assert.notInclude(localBranches(repo.root), "orphan");
            assert.include(registeredPaths(repo.root), external);
            // A missing folder outside the F5 folder may be an unmounted disk: keep its entry.
            assert.include(registeredPaths(repo.root), gone);
            assert.notInclude(registeredPaths(repo.root), goneManaged);
          }),
        ),
    );
  },
);
