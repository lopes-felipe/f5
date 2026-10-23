import { assertScheduledThreadPurgeable, purgeThreadRows } from "./threadPurgePolicy.ts";
import {
  retainedWorkflowThreadIds as workflowRetention,
  workflowEntries,
} from "../orchestration/workflowArchiveLifecycle.ts";
import { storageLstat, storageReadDir } from "./diskUsage.ts";
import { recordStorageAutomationAudit, pruneStorageAutomationAudit } from "./automationAudit.ts";
import { databaseMaintenanceEffect } from "./databaseMaintenance.ts";
import { canonicalJsonHash } from "../canonicalJsonHash.ts";
import { makeUsageScanCoordinator } from "./usageScanCoordinator.ts";
import { withProviderThreadAccess } from "../provider/providerThreadAccess.ts";
import { cleanupRequiresTypedDelete } from "@t3tools/shared/storageCleanup";
import { userFacingCauseMessage } from "../causeMessage.ts";
import {
  type DiscardableChanges,
  evaluateWorktreeRemoval,
  removeWorktreeSafely,
  readWorktreeClaims,
  stopDeletedWorktreeClaims,
  type WorktreeRemovalPolicy,
} from "../project/worktreeClaims.ts";
import { refreshDefaultBranch } from "../project/worktreeMerge.ts";
import { readProjectSettings } from "../project/projectSettings.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { pathContains } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { stripPathTerminator } from "../git/worktreeList.ts";
import { withAttachmentRetentionLease } from "./attachmentRetention.ts";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  type CheckpointRef,
  CommandId,
  type DiskSpaceReclaimableItem,
  type StorageCleanupCategoryId,
  type StorageCleanupCategoryResult,
  type StorageCleanupCategoryUsage,
  type StorageCleanupProgressPayload,
  type StorageCleanupRequest,
  type StorageCleanupTargetSelection,
  type StorageCleanupResult,
  type StorageCleanupTarget,
  type StorageGetUsageRequest,
  type StorageGetUsageResult,
  type StorageStatus,
  type StorageCleanupStatus,
  type StorageGetTargetsRequest,
  type StorageGetTargetsResult,
  type StorageGetOperationRequest,
  type StorageGetOperationResult,
  type StoragePathWarning,
  type StorageScanStatus,
  type StorageUsageReport,
  ThreadId,
} from "@t3tools/contracts";
import { defaultF5BaseDir, legacyT3BaseDir } from "@t3tools/shared/appStatePaths";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
  Semaphore,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitCore, type RegisteredWorktree } from "../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { withWorktreeLifecycleLock } from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  type CodexMarketplaceLeftover,
  codexMarketplaceLeftoverBytes,
  listCodexMarketplaceLeftovers,
  removeCodexMarketplaceLeftover,
  resolveCodexLaunchHomes,
} from "./codexMarketplaceStaging.ts";
import {
  AUTO_VACUUM_INCREMENTAL,
  freeDatabaseBytes,
  incrementalVacuum,
  liveDatabaseBytes,
  readDatabasePages,
  vacuumFreeSpaceShortfall,
} from "./databaseSpace.ts";
import {
  enumerateFiles,
  recursiveSize,
  measureTree,
  indexFilesBySegment,
  fileIdentity,
  allocatedBytes,
  type FileIdentity,
  type EnumeratedFile,
} from "./diskUsage.ts";
import { probeLegacyState, type LegacyProbeResult } from "./legacyStateProbe.ts";
import {
  isPathWithinRoot,
  removeFileIfSafe,
  removeTreeIfSafe,
  safeLstat,
  validateDeletablePath,
  isEnoent,
} from "./storagePathSafety.ts";

const USAGE_CACHE_TTL_MS = 10 * 60_000;
/** Total time a scan may spend refreshing `origin/<default>` across repositories. */
const REMOTE_REFRESH_BUDGET = "60 seconds";
const NONCE_TTL_MS = 15 * 60_000;
const EVENTS_ROTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ARCHIVED_THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Free pages worth one full VACUUM to switch to incremental auto-vacuum. */
const AUTO_CONVERT_MIN_FREE_BYTES = 256 * 1024 * 1024;
const AUTO_CONVERT_MIN_FREE_FRACTION = 0.2;
/** Conversion reserves the database, so automatic runs wait for this quiet interval. */
const AUTO_CONVERT_QUIET_MS = 30 * 60 * 1_000;
export const PURGE_FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1_000;

const WORKTREE_SCAN_MAX_DEPTH = 4;
const GIT_WORKTREE_METADATA_UNRESOLVED = "Git worktree metadata could not be resolved.";

export class StorageMaintenanceError extends Schema.TaggedErrorClass<StorageMaintenanceError>()(
  "StorageMaintenanceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface StorageCleanupContext {
  readonly publishProgress?: (
    event: StorageCleanupProgressPayload,
  ) => Effect.Effect<void, never, never>;
}

/** What the cleanup helpers need from a request: progress and cancellation key on it. */
type CleanupOperation = Pick<StorageCleanupRequest, "operationId">;
type CleanupInput = Omit<StorageCleanupRequest, "backendEpoch"> & {
  readonly backendEpoch?: string;
};

export interface AutomaticThreadPurgeResult {
  readonly purgedThreadIds: ReadonlyArray<ThreadId>;
  /** Archived threads soft-deleted for this purge. */
  readonly archivedThreadIds: ReadonlyArray<ThreadId>;
  readonly reclaimedBytes: number;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
}

export interface DatabaseSpaceResult {
  /** `converted`: one full VACUUM switched the database to incremental auto-vacuum. */
  readonly action: "incremental" | "converted" | "none";
  readonly reclaimedBytes: number;
  /** Why a needed conversion did not run. */
  readonly skippedReason?: string;
}

export interface StorageMaintenanceShape {
  readonly getUsage: (
    request?: StorageGetUsageRequest,
  ) => Effect.Effect<StorageGetUsageResult, StorageMaintenanceError>;
  readonly getStatus: Effect.Effect<StorageStatus>;
  readonly noteStorageMutated: Effect.Effect<void>;
  readonly acceptCleanup: (
    request: CleanupInput,
  ) => Effect.Effect<StorageCleanupStatus, StorageMaintenanceError>;
  readonly getTargets: (
    request: StorageGetTargetsRequest,
  ) => Effect.Effect<StorageGetTargetsResult, StorageMaintenanceError>;
  readonly getOperation: (
    request: StorageGetOperationRequest,
  ) => Effect.Effect<StorageGetOperationResult, StorageMaintenanceError>;
  readonly inspect: (
    request?: StorageGetUsageRequest,
  ) => Effect.Effect<
    StorageUsageReport & { readonly confirmationNonce: string },
    StorageMaintenanceError
  >;
  /**
   * Reclaimable categories from the same scan as `inspect`, biggest first.
   * Issues no confirmation nonce, so a scan open in the Storage settings
   * stays valid. For the low-disk banner.
   */
  readonly summarizeReclaimable: Effect.Effect<
    ReadonlyArray<DiskSpaceReclaimableItem>,
    StorageMaintenanceError
  >;
  readonly cleanup: (
    request: CleanupInput,
    context?: StorageCleanupContext,
  ) => Effect.Effect<StorageCleanupResult, StorageMaintenanceError>;
  readonly cancel: (operationId: string) => Effect.Effect<void>;
  /**
   * Automatic purge for the storage cleanup worker: threads deleted at or
   * before `deletedBefore`, and threads archived at or before `archivedBefore`
   * (soft-deleted first, guarded on their archive time). Null skips a kind.
   * Same per-thread steps and safety checks as the manual purge. Takes the
   * oldest `maxThreads` threads that are not busy; the rest wait for the
   * next call. A thread this skipped or failed to purge goes to the back of
   * the order for {@link PURGE_FAILURE_BACKOFF_MS}, so a few stuck threads
   * cannot hold every slot.
   * `reclaimedBytes` counts files only: sizing the rows would read every
   * deleted thread's events.
   */
  readonly purgeThreads: (input: {
    readonly operationId: string;
    readonly deletedBefore: string | null;
    readonly archivedBefore: string | null;
    readonly maxThreads: number;
  }) => Effect.Effect<AutomaticThreadPurgeResult, StorageMaintenanceError>;
  /**
   * Returns free database pages to the file system: bounded incremental
   * vacuum steps on an incremental database. A non-incremental database with
   * enough free pages is switched with one full VACUUM, but only while no
   * agent is working, no thread was used for a while, and free disk covers it.
   */
  readonly reclaimDatabaseSpace: (input: {
    readonly maxDurationMs: number;
  }) => Effect.Effect<DatabaseSpaceResult, StorageMaintenanceError>;
  /**
   * Per-thread provider logs last written before `modifiedBefore` whose
   * thread is deleted or gone (or archived, with `includeArchived`), and not
   * busy. Live threads keep their logs: transcript repair rebuilds from them.
   */
  readonly listTerminalThreadLogs: (input: {
    readonly modifiedBefore: string;
    readonly includeArchived: boolean;
  }) => Effect.Effect<ReadonlyArray<EnumeratedFile>, StorageMaintenanceError>;
  /**
   * Deletes the logs {@link StorageMaintenanceShape.listTerminalThreadLogs}
   * lists, re-listing them under the maintenance lock.
   */
  readonly pruneTerminalThreadLogs: (input: {
    readonly operationId: string;
    readonly modifiedBefore: string;
    readonly includeArchived: boolean;
  }) => Effect.Effect<StorageCleanupCategoryResult, StorageMaintenanceError>;
  /**
   * Hourly automation: refresh the default branch of each repository with an
   * F5 worktree, then remove every eligible inactive F5 worktree and prune
   * missing registrations inside the F5 worktrees folder, with the same checks
   * as the Storage settings cleanup. External worktrees are never touched.
   * Null when a Storage settings cleanup is running.
   */
  readonly cleanInactiveWorktreesAutomatically: (input: {
    readonly operationId: string;
  }) => Effect.Effect<ReadonlyArray<StorageCleanupCategoryResult> | null, StorageMaintenanceError>;
  /**
   * Read-only preview of the hourly run, from the last fetched refs. Each
   * candidate is removed, or skipped with its reason.
   */
  readonly previewInactiveWorktrees: Effect.Effect<
    ReadonlyArray<InactiveWorktreePreview>,
    StorageMaintenanceError
  >;
}

export interface InactiveWorktreePreview {
  readonly path: string;
  readonly kind: "worktree" | "missingRegistration";
  readonly action: "remove" | "skip";
  readonly reason: string;
}

export class StorageMaintenance extends ServiceMap.Service<
  StorageMaintenance,
  StorageMaintenanceShape
>()("t3/storage/StorageMaintenance") {}

interface ThreadRow {
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly title: string;
  readonly lastInteractionAt: string;
  readonly projectName: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly workspaceRoot: string | null;
}

interface OrphanAttachmentRow {
  readonly attachmentId: string;
  readonly name: string;
  readonly finalPath: string;
  readonly lifecycle?: string;
  readonly lastError?: string | null;
}

type LegacyCleanupCategoryId = Extract<
  StorageCleanupCategoryId,
  | "legacyT3Userdata"
  | "legacyT3Diverged"
  | "legacyT3Worktrees"
  | "legacyT3Dev"
  | "legacyT3Caches"
  | "legacyT3Root"
  | "f5UserdataEmpty"
>;

type PerTargetReclaimed = Array<StorageCleanupCategoryResult["perTargetReclaimed"][number]>;

interface WorktreeReview {
  readonly canonicalRoot: string;
  readonly commonDir: string;
  readonly head: string | null;
  readonly registration: string;
  readonly branch?: string | null;
  /** Uncommitted changes matching the project's disposable paths, discarded on removal. */
  readonly discardChanges?: DiscardableChanges;
  /** External worktrees: the project checkout Git runs in. */
  readonly projectRoot?: string;
}
interface StorageReview {
  readonly worktrees: ReadonlyMap<string, WorktreeReview>;
  readonly identities: ReadonlyMap<string, FileIdentity | null>;
  readonly threads: ReadonlyMap<string, ThreadRow>;
}
interface UsageNonceState {
  readonly scanId: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
  readonly generation: number;
  readonly review: StorageReview;
  readonly categories: ReadonlyMap<StorageCleanupCategoryId, StorageCleanupCategoryUsage>;
  used: boolean;
}

interface WorktreeRemovalReadiness {
  readonly review?: WorktreeReview;
  /** The removal policy the gate used, including resolved disposable paths. */
  readonly policy?: WorktreeRemovalPolicy;
  readonly commandCwd: string | null;
  readonly disabledReason?: string;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
  /**
   * Whether the branch may be deleted after removal. Kept out of the hashed
   * review: a fetch between scan and confirmation must not invalidate it.
   */
  readonly branchDeletable?: boolean;
}

function storageCauseMessage(cause: Cause.Cause<unknown>): string {
  return userFacingCauseMessage(cause, "Storage operation failed.", { maxLength: 300 });
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function uniqueCategoryIds(
  categoryIds: ReadonlyArray<StorageCleanupCategoryId>,
): ReadonlyArray<StorageCleanupCategoryId> {
  const seen = new Set<StorageCleanupCategoryId>();
  const ordered: StorageCleanupCategoryId[] = [];
  for (const categoryId of categoryIds) {
    if (!seen.has(categoryId)) {
      seen.add(categoryId);
      ordered.push(categoryId);
    }
  }
  const nonVacuum = ordered.filter((categoryId) => categoryId !== "databaseVacuum");
  return [
    ...nonVacuum.filter((categoryId) => categoryId === "purgeArchivedThreads"),
    ...nonVacuum.filter((categoryId) => categoryId !== "purgeArchivedThreads"),
    ...ordered.filter((categoryId) => categoryId === "databaseVacuum"),
  ];
}

function normalizeTargetSelections(
  selections: ReadonlyArray<StorageCleanupTargetSelection> | undefined,
): Map<StorageCleanupCategoryId, ReadonlySet<string>> {
  const result = new Map<StorageCleanupCategoryId, Set<string>>();
  for (const selection of selections ?? []) {
    const existing = result.get(selection.categoryId) ?? new Set<string>();
    for (const targetId of selection.targetIds) {
      existing.add(targetId);
    }
    result.set(selection.categoryId, existing);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await storageLstat(path);
    return true;
  } catch {
    return false;
  }
}

async function databaseFileBytes(dbPath: string): Promise<number> {
  const stats = await Promise.all(
    ["", "-wal", "-shm", "-journal"].map((suffix) => safeLstat(`${dbPath}${suffix}`)),
  );
  return stats.reduce((total, stat) => total + (stat ? allocatedBytes(stat) : 0), 0);
}

function providerLogSegmentFromName(name: string): string | null {
  const match = /^(.+)\.log(?:\.\d+)?$/.exec(name);
  const segment = match?.[1];
  if (!segment || segment === "events" || segment === "_global") {
    return null;
  }
  return segment;
}

function isEventsLogRotation(file: EnumeratedFile): boolean {
  return /^events\.log\.\d+$/.test(file.name);
}

function isBusySession(input: {
  readonly status: string | null;
  readonly activeTurnId: string | null;
}) {
  return input.status === "starting" || input.status === "running" || input.activeTurnId !== null;
}

function isActiveStorageThread(thread: ThreadRow): boolean {
  return thread.deletedAt === null && thread.archivedAt === null;
}

function normalizePathForCompare(path: string): string {
  return Path.resolve(path);
}

function pathContainsOrEquals(rootPath: string, targetPath: string): boolean {
  const root = normalizePathForCompare(rootPath);
  const target = normalizePathForCompare(targetPath);
  const relative = Path.relative(root, target);
  return (
    relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  return pathContainsOrEquals(leftPath, rightPath) || pathContainsOrEquals(rightPath, leftPath);
}

function sumNonOverlappingPathUsages(
  usages: ReadonlyArray<{ readonly path: string; readonly bytes: number }>,
): number {
  const countedRoots: string[] = [];
  let total = 0;
  for (const usage of usages
    .filter((entry) => entry.bytes > 0)
    .toSorted(
      (left, right) =>
        normalizePathForCompare(left.path).length - normalizePathForCompare(right.path).length,
    )) {
    if (countedRoots.some((root) => pathContainsOrEquals(root, usage.path))) {
      continue;
    }
    countedRoots.push(usage.path);
    total += usage.bytes;
  }
  return total;
}

function categoryUsage(input: {
  readonly id: StorageCleanupCategoryId;
  readonly section: StorageCleanupCategoryUsage["section"];
  readonly title: string;
  readonly description: string;
  readonly bytes: number;
  readonly reclaimableBytes: number;
  readonly defaultSelected: boolean;
  readonly impact: StorageCleanupCategoryUsage["impact"];
  readonly targets?: ReadonlyArray<StorageCleanupTarget>;
  readonly disabledReason?: string | undefined;
  readonly warnings?: ReadonlyArray<StoragePathWarning>;
}): StorageCleanupCategoryUsage {
  const targetCount = input.targets?.length ?? 0;
  const disabledReason =
    input.disabledReason ??
    (input.reclaimableBytes <= 0 && input.id !== "databaseVacuum" && targetCount === 0
      ? "No reclaimable storage found."
      : undefined);
  return {
    id: input.id,
    section: input.section,
    title: input.title,
    description: input.description,
    bytes: clampBytes(input.bytes),
    reclaimableBytes: clampBytes(input.reclaimableBytes),
    measurement: input.warnings?.length ? "partial" : "complete",
    eligibleThreadCount:
      input.id === "purgeDeletedThreads" || input.id === "purgeArchivedThreads" ? targetCount : 0,
    defaultSelected: input.defaultSelected,
    impact: input.impact,
    availability: disabledReason ? "disabled" : "ready",
    ...(disabledReason ? { disabledReason } : {}),
    targetCount,
    targets: [...(input.targets ?? [])],
    warnings: (input.warnings ?? []).map((warning) => warningFor(warning.path, warning.reason)),
  };
}

function resultFor(input: {
  readonly categoryId: StorageCleanupCategoryId;
  readonly status: StorageCleanupCategoryResult["status"];
  readonly reclaimedBytes?: number;
  readonly perTargetReclaimed?: StorageCleanupCategoryResult["perTargetReclaimed"];
  readonly warnings?: ReadonlyArray<StoragePathWarning>;
  readonly message?: string;
}): StorageCleanupCategoryResult {
  return {
    categoryId: input.categoryId,
    status: input.status,
    reclaimedBytes: clampBytes(input.reclaimedBytes ?? 0),
    perTargetReclaimed: [...(input.perTargetReclaimed ?? [])],
    warnings: (input.warnings ?? []).map((warning) => warningFor(warning.path, warning.reason)),
    ...(input.message ? { message: input.message.replace(/\s+/g, " ").slice(0, 300) } : {}),
  };
}

function warningFor(path: string, reason: string): StoragePathWarning {
  return { path, reason: reason.replace(/\s+/g, " ").trim().slice(0, 300) };
}

function toStorageMaintenanceError(operation: string) {
  return (cause: unknown) =>
    Schema.is(StorageMaintenanceError)(cause)
      ? cause
      : new StorageMaintenanceError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
}

function parseActiveTurnId(runtimePayloadJson: string | null): string | null {
  if (!runtimePayloadJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(runtimePayloadJson) as { activeTurnId?: unknown };
    return typeof parsed.activeTurnId === "string" && parsed.activeTurnId.length > 0
      ? parsed.activeTurnId
      : null;
  } catch {
    return null;
  }
}

async function listProviderLogFiles(providerLogsDir: string): Promise<{
  readonly files: ReadonlyArray<EnumeratedFile>;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
}> {
  if (!(await exists(providerLogsDir))) {
    return { files: [], warnings: [] };
  }
  const result = await enumerateFiles(providerLogsDir, { maxDepth: 1 });
  return { files: result.files, warnings: result.errors };
}

async function listGitWorktreeDirectories(input: {
  readonly root: string;
  readonly maxDepth: number;
}): Promise<{
  readonly paths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
}> {
  const warnings: StoragePathWarning[] = [];
  const paths: string[] = [];
  const rootStat = await safeLstat(input.root);
  if (!rootStat) {
    return { paths, warnings };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    warnings.push(
      warningFor(input.root, "Refused to scan a symlinked or non-directory F5 worktrees root."),
    );
    return { paths, warnings };
  }

  const visit = async (directory: string, depth: number): Promise<void> => {
    const gitPath = Path.join(directory, ".git");
    const gitStat = await safeLstat(gitPath);
    if (gitStat?.isFile() === true) {
      paths.push(directory);
      return;
    }
    if (depth >= input.maxDepth) {
      return;
    }

    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await storageReadDir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push(warningFor(directory, error instanceof Error ? error.message : String(error)));
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          warnings.push(warningFor(Path.join(directory, entry.name), "Skipped symbolic link."));
        }
        continue;
      }
      await visit(Path.join(directory, entry.name), depth + 1);
    }
  };

  await visit(input.root, 0);
  return {
    paths: paths.toSorted((left, right) => left.localeCompare(right)),
    warnings,
  };
}

function legacyAllowedRootForCategory(categoryId: LegacyCleanupCategoryId): string {
  const homeDir = OS.homedir();
  return categoryId === "f5UserdataEmpty" ? defaultF5BaseDir(homeDir) : legacyT3BaseDir(homeDir);
}

async function resolveWorktreeRemoveCwd(targetPath: string): Promise<string | null> {
  const gitPath = Path.join(targetPath, ".git");
  const gitStat = await safeLstat(gitPath);
  if (!gitStat) {
    return null;
  }
  if (!gitStat.isFile()) {
    return null;
  }

  const gitFile = await FS.readFile(gitPath, "utf8");
  const match = /^gitdir: ([\s\S]+)$/.exec(stripPathTerminator(gitFile));
  if (!match) {
    return null;
  }

  const gitDir = Path.resolve(targetPath, match[1]!);
  const commonDirFile = Path.join(gitDir, "commondir");
  const commonDir = (await safeLstat(commonDirFile))?.isFile()
    ? Path.resolve(gitDir, stripPathTerminator(await FS.readFile(commonDirFile, "utf8")))
    : Path.dirname(Path.dirname(gitDir));
  if (Path.basename(commonDir) !== ".git") {
    return null;
  }
  const mainWorktree = Path.dirname(commonDir);
  const mainStat = await safeLstat(mainWorktree);
  return mainStat?.isDirectory() === true && !mainStat.isSymbolicLink() ? mainWorktree : null;
}

async function loadStatfs(): Promise<
  ((path: string) => Promise<{ bavail: number; bsize: number }>) | null
> {
  const direct = (
    FS as typeof FS & {
      statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
    }
  ).statfs;
  if (typeof direct === "function") {
    return direct;
  }
  const imported = (await import("node:fs/promises")) as typeof FS & {
    statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  };
  return typeof imported.statfs === "function" ? imported.statfs : null;
}

const makeStorageMaintenance = Effect.gen(function* () {
  const removalServices = yield* Effect.services<
    | GitCore
    | ServerConfig
    | OrchestrationEngineService
    | ProviderService
    | TerminalManager
    | NextTurnQueueStore
  >();
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminals = yield* TerminalManager;
  const checkpointStore = yield* CheckpointStore;
  const git = yield* GitCore;
  const eventStore = yield* OrchestrationEventStore;
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const withSql = Effect.provideService(SqlClient.SqlClient, sql);
  const readPages = withSql(readDatabasePages);
  const compactDatabase = (operationId?: string) =>
    Effect.gen(function* () {
      const gate = yield* engine.acquireMaintenanceLock();
      return yield* Effect.scoped(
        Effect.gen(function* () {
          if (operationId && cancelledOperations.has(operationId))
            return yield* new StorageMaintenanceError({
              operation: "compactDatabase",
              message: "Database compaction was cancelled.",
            });
          const connection = yield* sql.reserve;
          if (operationId && cancelledOperations.has(operationId))
            return yield* new StorageMaintenanceError({
              operation: "compactDatabase",
              message: "Database compaction was cancelled.",
            });
          // Reserving without BEGIN lets the helper own SQLite's write lock while
          // ordinary queries wait asynchronously on the main connection semaphore.
          yield* connection.execute("PRAGMA wal_checkpoint(TRUNCATE)", [], undefined);
          if (operationId) markStorageMutation(operationId);
          yield* databaseMaintenanceEffect(
            config.dbPath,
            () => operationId !== undefined && cancelledOperations.has(operationId),
          );
        }),
      ).pipe(Effect.ensuring(Scope.close(gate, Exit.void).pipe(Effect.ignore)));
    });

  const scope = yield* Scope.Scope;
  const issuedConfirmations = new Map<string, UsageNonceState>();
  const scanReviews = new Map<string, StorageReview>();
  const operationReviews = new Map<string, StorageReview>();
  const backendEpoch = Crypto.randomUUID();
  let cleanupStatus: StorageCleanupStatus | null = null;
  let operationRevision = 0;
  const cancelledOperations = new Set<string>();
  const cancellableOperations = new Set<string>();
  const mutatedOperations = new Set<string>();
  const markStorageMutation = (operationId: string) => {
    mutatedOperations.add(operationId);
  };
  const finishStorageMutation = (operationId: string): Effect.Effect<void> =>
    Effect.suspend(() =>
      mutatedOperations.delete(operationId) ? noteStorageMutated : Effect.void,
    );
  /** Threads the automatic purge could not remove, and when to try them first again. */
  const purgeRetryAtMs = new Map<string, number>();

  const reviewIdentity = (
    operationId: string,
    path: string,
    fallback?: FileIdentity,
  ): FileIdentity | null | undefined => {
    const review = operationReviews.get(operationId);
    return review ? (review.identities.get(path) ?? null) : fallback;
  };
  const queryThreadRows = () =>
    sql<ThreadRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title AS "title",
        thread.last_interaction_at AS "lastInteractionAt",
        project.title AS "projectName",
        thread.worktree_path AS "worktreePath",
        thread.archived_at AS "archivedAt",
        thread.deleted_at AS "deletedAt",
        project.workspace_root AS "workspaceRoot"
      FROM projection_threads AS thread
      LEFT JOIN projection_projects AS project
        ON project.project_id = thread.project_id
      ORDER BY thread.thread_id ASC
    `;

  const retainedWorkflowThreadIds = () => engine.getReadModel().pipe(Effect.map(workflowRetention));

  const canonicalOrNull = (path: string) =>
    Effect.tryPromise(() => canonicalWorktreePath(path)).pipe(
      Effect.orElseSucceed(() => null as string | null),
    );

  /** Non-deleted projects with their canonical workspace roots (null when unresolvable). */
  const listProjectRoots = () =>
    Effect.gen(function* () {
      const projects = (yield* engine.getReadModel()).projects.filter(
        (project) => project.deletedAt === null,
      );
      return yield* Effect.forEach(projects, (project) =>
        canonicalOrNull(project.workspaceRoot).pipe(Effect.map((root) => ({ project, root }))),
      );
    });

  const commonDirOf = (cwd: string) =>
    git.resolveCommonDir(cwd).pipe(
      Effect.flatMap(canonicalOrNull),
      Effect.orElseSucceed(() => null),
    );

  /** Each project's repository common dir and disposable paths (null when unreadable). */
  const readProjectDisposablePaths = Effect.gen(function* () {
    if (settingsService._tag === "None") return [];
    const global = yield* settingsService.value.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (global === null) return [];
    return yield* Effect.forEach(
      (yield* listProjectRoots()).filter((entry) => entry.root !== null),
      ({ project }) =>
        Effect.all({
          commonDir: commonDirOf(project.workspaceRoot),
          paths: readProjectSettings(global, project).pipe(
            Effect.map(
              (resolved): ReadonlyArray<string> | null => resolved.settings.worktreeDisposablePaths,
            ),
            Effect.catchCause(() => Effect.succeed(null)),
          ),
        }),
      { concurrency: 4 },
    );
  });

  /**
   * A lookup of the disposable worktree paths of the projects in a worktree's
   * repository, matched by Git common dir so subdirectory and linked-worktree
   * projects count. With several projects, only patterns they all list apply.
   * No matching project, or unreadable settings, means nothing is discardable.
   * Project ownership and settings are read once per lookup, so create one per
   * scan or cleanup pass: a later pass sees settings changes.
   */
  const makeDisposablePathsLookup = Effect.gen(function* () {
    const projects = yield* Effect.cached(readProjectDisposablePaths);
    return (commandCwd: string): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function* () {
        const commonDir = yield* commonDirOf(commandCwd);
        if (commonDir === null) return [];
        const owners = (yield* projects).filter((entry) => entry.commonDir === commonDir);
        if (owners.some((entry) => entry.paths === null)) return [];
        const [first, ...rest] = owners.map((entry) => entry.paths ?? []);
        return (first ?? []).filter((pattern) => rest.every((paths) => paths.includes(pattern)));
      });
  });

  /** Set by a forced scan (Rescan): refresh `origin/<default>` before measuring. */
  let refreshRemotesBeforeNextScan = false;

  /**
   * Refresh each project repository's default branch once; failures become
   * warnings. Repositories without `origin` are skipped, and `onlyCommonDirs`
   * limits the refresh to repositories that own a candidate.
   */
  const refreshProjectRemotes = (
    onlyCommonDirs?: ReadonlySet<string>,
  ): Effect.Effect<ReadonlyArray<StoragePathWarning>> =>
    Effect.gen(function* () {
      const seen = new Set<string>();
      const roots: string[] = [];
      for (const { project, root } of yield* listProjectRoots()) {
        if (root === null) continue;
        const commonDir = yield* commonDirOf(project.workspaceRoot);
        if (commonDir === null || seen.has(commonDir)) continue;
        seen.add(commonDir);
        if (onlyCommonDirs && !onlyCommonDirs.has(commonDir)) continue;
        const hasOrigin = yield* git.listRemotes(project.workspaceRoot).pipe(
          Effect.map((remotes) => remotes.some((remote) => remote.name === "origin")),
          Effect.orElseSucceed(() => false),
        );
        if (hasOrigin) roots.push(project.workspaceRoot);
      }
      const warnings: StoragePathWarning[] = [];
      yield* Effect.forEach(
        roots,
        (root) =>
          refreshDefaultBranch(git, root).pipe(
            Effect.map((message) => {
              if (message) warnings.push(warningFor(root, message));
            }),
          ),
        { concurrency: 2, discard: true },
      ).pipe(
        Effect.timeout(REMOTE_REFRESH_BUDGET),
        Effect.catchCause(() =>
          Effect.sync(() => {
            warnings.push(
              warningFor(
                "origin",
                "Refreshing remotes took too long; merge checks use refs from the last fetch.",
              ),
            );
          }),
        ),
      );
      return warnings;
    });

  /**
   * Delete the removed worktree's local branch when it was merged at review,
   * no thread still references the worktree (an archived thread recreates its
   * checkout from the branch), and no other worktree has it checked out.
   * The default branch and branches with a live upstream are always kept.
   */
  const deleteMergedBranch = (input: {
    readonly cwd: string;
    readonly review: WorktreeReview | undefined;
    readonly branchDeletable: boolean;
    readonly referencedByThreads: boolean;
  }): Effect.Effect<"deleted" | "kept" | undefined> =>
    Effect.gen(function* () {
      const { review } = input;
      if (!review?.branch) return undefined;
      if (!input.branchDeletable || !review.head || input.referencedByThreads)
        return "kept" as const;
      const defaultBranch = yield* git
        .readDefaultBranch(input.cwd)
        .pipe(Effect.orElseSucceed(() => null));
      if (defaultBranch === null || defaultBranch === review.branch) return "kept" as const;
      const registrations = yield* git
        .listWorktrees(input.cwd)
        .pipe(Effect.orElseSucceed(() => null));
      if (registrations === null || registrations.some((entry) => entry.branch === review.branch))
        return "kept" as const;
      const deleted = yield* git
        .deleteBranchIfAt({ cwd: input.cwd, branch: review.branch, expectedSha: review.head })
        .pipe(Effect.orElseSucceed(() => false));
      return deleted ? ("deleted" as const) : ("kept" as const);
    });

  const discardDetail = (review: WorktreeReview | undefined): string | null => {
    const paths = review?.discardChanges?.paths;
    if (!paths?.length) return null;
    const shown = paths.slice(0, 3).join(", ");
    return `Discards ${paths.length} changed file${paths.length === 1 ? "" : "s"}: ${shown}${
      paths.length > 3 ? "…" : ""
    }`;
  };

  const homeRelative = (value: string) => {
    const relative = Path.relative(OS.homedir(), value);
    return relative.length > 0 && !relative.startsWith("..") && !Path.isAbsolute(relative)
      ? Path.join("~", relative)
      : value;
  };

  const inspectWorktreeRemovalReadiness = (input: {
    readonly targetPath: string;
    readonly metadataOperation: string;
    readonly metadataDisabledReason: string;
    /** Defaults to storage maintenance, or legacy cleanup for legacy operations. */
    readonly policy?: WorktreeRemovalPolicy;
    /** The repository checkout to run Git in; resolved from `.git` when omitted. */
    readonly commandCwd?: string;
    /** Resolves the owning project's disposable paths once the repository is known. */
    readonly disposablePaths?: (commandCwd: string) => Effect.Effect<ReadonlyArray<string>>;
  }): Effect.Effect<WorktreeRemovalReadiness, never> =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const commandCwdExit = yield* Effect.exit(
        Effect.tryPromise({
          try: async () => input.commandCwd ?? (await resolveWorktreeRemoveCwd(input.targetPath)),
          catch: (cause) =>
            new StorageMaintenanceError({
              operation: input.metadataOperation,
              message: "Failed to resolve Git worktree metadata.",
              cause,
            }),
        }),
      );
      if (Exit.isFailure(commandCwdExit)) {
        warnings.push(warningFor(input.targetPath, storageCauseMessage(commandCwdExit.cause)));
        return {
          commandCwd: null,
          disabledReason: input.metadataDisabledReason,
          warnings,
        };
      }

      const commandCwd = commandCwdExit.value;
      if (!commandCwd || Path.resolve(commandCwd) === Path.resolve(input.targetPath)) {
        return {
          commandCwd: null,
          disabledReason: input.metadataDisabledReason,
          warnings,
        };
      }

      const basePolicy: WorktreeRemovalPolicy = input.policy ?? {
        kind: input.metadataOperation.includes("legacy") ? "legacyCleanup" : "storageMaintenance",
        ownThreadId: null,
      };
      const policy: WorktreeRemovalPolicy =
        (basePolicy.kind === "storageMaintenance" || basePolicy.kind === "externalCleanup") &&
        input.disposablePaths
          ? { ...basePolicy, disposablePaths: yield* input.disposablePaths(commandCwd) }
          : basePolicy;
      const gate = yield* evaluateWorktreeRemoval({
        projectCwd: commandCwd,
        path: input.targetPath,
        policy,
      }).pipe(Effect.provideServices(removalServices));
      if (gate.blockedReasons.length)
        return {
          commandCwd,
          disabledReason:
            gate.blockedReasons.join("; ") || "Deleted thread processes must be stopped first.",
          warnings,
        };

      return {
        commandCwd,
        warnings,
        policy,
        branchDeletable: gate.branchDeletable,
        ...(gate.registration
          ? {
              review: {
                canonicalRoot: gate.registration.canonicalPath,
                commonDir: yield* git.resolveCommonDir(commandCwd),
                head: gate.registration.headSha,
                registration: gate.registration.path,
                branch: gate.branch,
                ...(gate.discardChanges ? { discardChanges: gate.discardChanges } : {}),
                ...(policy.kind === "externalCleanup" ? { projectRoot: commandCwd } : {}),
              },
            }
          : {}),
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not verify storage worktree", cause).pipe(
          Effect.as({
            commandCwd: null,
            disabledReason: storageCauseMessage(cause),
            warnings: [],
          } satisfies WorktreeRemovalReadiness),
        ),
      ),
      Effect.timeoutOption("15 seconds"),
      Effect.map((result) =>
        Option.isSome(result)
          ? result.value
          : {
              commandCwd: null,
              disabledReason: "Could not verify this worktree in time. Rescan to retry.",
              warnings: [],
            },
      ),
    );

  const readBusyThreadSegments = (allThreads: ReadonlyArray<ThreadRow>) =>
    Effect.gen(function* () {
      const threadToSegment = new Map<string, string>();
      for (const thread of allThreads) {
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        if (segment) {
          threadToSegment.set(thread.threadId, segment);
        }
      }

      const busyThreadIds = new Set<string>();
      const projectionRows = yield* sql<{
        readonly threadId: string;
        readonly status: string | null;
        readonly activeTurnId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
      `;
      for (const row of projectionRows) {
        if (isBusySession(row)) {
          busyThreadIds.add(row.threadId);
        }
      }

      const runtimeRows = yield* sql<{
        readonly threadId: string;
        readonly status: string | null;
        readonly runtimePayloadJson: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          runtime_payload_json AS "runtimePayloadJson"
        FROM provider_session_runtime
      `;
      for (const row of runtimeRows) {
        const activeTurnId = parseActiveTurnId(row.runtimePayloadJson);
        if (isBusySession({ status: row.status, activeTurnId })) {
          busyThreadIds.add(row.threadId);
        }
      }

      const busySegments = new Set<string>();
      for (const threadId of busyThreadIds) {
        const segment = threadToSegment.get(threadId) ?? toSafeThreadAttachmentSegment(threadId);
        if (segment) {
          busySegments.add(segment);
        }
      }
      return busySegments;
    });

  const computeProviderLogCandidates = (
    allThreads: ReadonlyArray<ThreadRow>,
    options?: {
      /** Keep archived threads' logs: they can be unarchived. */
      readonly archivedAlive?: boolean;
      readonly files?: ReadonlyArray<EnumeratedFile>;
      readonly busySegments?: ReadonlySet<string>;
    },
  ) =>
    Effect.gen(function* () {
      const aliveSegments = new Set(
        allThreads
          .filter((thread) =>
            options?.archivedAlive ? thread.deletedAt === null : isActiveStorageThread(thread),
          )
          .map((thread) => toSafeThreadAttachmentSegment(thread.threadId))
          .filter((segment): segment is string => segment !== null),
      );
      const busySegments = options?.busySegments ?? (yield* readBusyThreadSegments(allThreads));
      const { files, warnings } = options?.files
        ? { files: options.files, warnings: [] }
        : yield* Effect.tryPromise({
            try: () => listProviderLogFiles(config.providerLogsDir),
            catch: (cause) =>
              new StorageMaintenanceError({
                operation: "StorageMaintenance.inspect.providerLogs",
                message: "Failed to inspect provider logs.",
                cause,
              }),
          });
      const segmentSet = new Set<string>();
      const candidates: Array<EnumeratedFile & { segment: string }> = [];
      for (const file of files) {
        const segment = providerLogSegmentFromName(file.name);
        if (!segment) {
          continue;
        }
        segmentSet.add(segment);
        if (aliveSegments.has(segment) || busySegments.has(segment)) {
          continue;
        }
        candidates.push({ ...file, segment });
      }

      return {
        files: candidates,
        warnings,
        segmentCount: segmentSet.size,
      };
    });

  const computeEventsLogRotationCandidates = (scannedFiles?: ReadonlyArray<EnumeratedFile>) =>
    Effect.tryPromise({
      try: async () => {
        const { files, warnings } = scannedFiles
          ? { files: scannedFiles, warnings: [] }
          : await listProviderLogFiles(config.providerLogsDir);
        const cutoffMs = Date.now() - EVENTS_ROTATION_RETENTION_MS;
        return {
          files: files.filter((file) => isEventsLogRotation(file) && file.mtimeMs < cutoffMs),
          warnings,
        };
      },
      catch: (cause) =>
        new StorageMaintenanceError({
          operation: "StorageMaintenance.inspect.eventsLogRotations",
          message: "Failed to inspect provider event log rotations.",
          cause,
        }),
    });

  /**
   * Leftover Codex marketplace upgrade clones and backups in every Codex home
   * this profile launches. Null when settings are unavailable.
   */
  const computeCodexMarketplaceLeftovers = (signal?: AbortSignal) =>
    Effect.gen(function* () {
      if (settingsService._tag === "None") return null;
      const settings = yield* settingsService.value.getSettings.pipe(
        Effect.orElseSucceed(() => null),
      );
      if (settings === null) return null;
      const homes = resolveCodexLaunchHomes({
        settings,
        profile: config.profile,
        stateDir: config.stateDir,
      });
      return yield* Effect.tryPromise({
        try: async () => {
          const leftovers = await listCodexMarketplaceLeftovers({ homes, nowMs: Date.now() });
          const sized: Array<{
            readonly leftover: CodexMarketplaceLeftover;
            readonly bytes: number;
          }> = [];
          for (const leftover of leftovers) {
            sized.push({ leftover, bytes: await codexMarketplaceLeftoverBytes(leftover, signal) });
          }
          return sized;
        },
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.codexMarketplaceStaging",
            message: "Failed to inspect Codex marketplace staging directories.",
            cause,
          }),
      });
    });

  const computeVacuumReclaimableBytes = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly pageSize: number }>`PRAGMA page_size`;
      const freeRows = yield* sql<{ readonly freelistCount: number }>`PRAGMA freelist_count`;
      return clampBytes((rows[0]?.pageSize ?? 0) * (freeRows[0]?.freelistCount ?? 0));
    }).pipe(Effect.catch(() => Effect.succeed(0)));

  const computeF5WorktreeTargets = (
    scan?: {
      threads: ReadonlyArray<ThreadRow>;
      paths: ReadonlyArray<string>;
      byCheckpoint: Map<string, { bytes: number; latestMtimeMs: number }>;
      worktreeReviews: Map<string, WorktreeReview>;
    },
    /** Cleanup re-measures each target as it removes it, so it skips sizing here. */
    options?: { readonly skipSizing?: boolean },
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const allThreads = scan?.threads ?? (yield* queryThreadRows());
      const disposablePathsFor = yield* makeDisposablePathsLookup;
      const listed = scan
        ? { paths: scan.paths, warnings: [] }
        : yield* Effect.tryPromise({
            try: () =>
              listGitWorktreeDirectories({
                root: config.worktreesDir,
                maxDepth: WORKTREE_SCAN_MAX_DEPTH,
              }),
            catch: (cause) =>
              new StorageMaintenanceError({
                operation: "StorageMaintenance.inspect.f5Worktrees.list",
                message: "Failed to inspect F5 worktrees.",
                cause,
              }),
          });
      warnings.push(...listed.warnings);

      const targets = yield* Effect.forEach(
        listed.paths,
        (targetPath) =>
          Effect.gen(function* () {
            const usageExit = yield* Effect.exit(
              Effect.tryPromise({
                try: () =>
                  scan || options?.skipSizing
                    ? Promise.resolve({
                        bytes: scan?.byCheckpoint.get(Path.resolve(targetPath))?.bytes ?? 0,
                        errors: [] as ReadonlyArray<StoragePathWarning>,
                        fileCount: 0,
                        directoryCount: 0,
                      })
                    : recursiveSize(targetPath),
                catch: (cause) =>
                  new StorageMaintenanceError({
                    operation: "StorageMaintenance.inspect.f5Worktrees.size",
                    message: "Failed to size F5 worktree.",
                    cause,
                  }),
              }),
            );
            const bytes = Exit.isSuccess(usageExit) ? usageExit.value.bytes : 0;
            if (Exit.isSuccess(usageExit)) {
              warnings.push(...usageExit.value.errors);
            } else {
              warnings.push(warningFor(targetPath, storageCauseMessage(usageExit.cause)));
            }

            const nonDeletedReferences = allThreads.filter(
              (thread) =>
                thread.deletedAt === null &&
                thread.worktreePath !== null &&
                pathsOverlap(targetPath, thread.worktreePath),
            );
            const activeReferences = nonDeletedReferences.filter(isActiveStorageThread);
            const archivedReferences = nonDeletedReferences.filter(
              (thread) => thread.archivedAt !== null,
            );

            let disabledReason: string | undefined;
            let review: WorktreeReview | undefined;
            if (Path.resolve(targetPath) === Path.resolve(config.worktreesDir)) {
              disabledReason = "Refused to delete the configured F5 worktrees root.";
            } else if (!isPathWithinRoot({ root: config.worktreesDir, target: targetPath })) {
              disabledReason = "Worktree is outside the configured F5 worktrees root.";
            } else if (activeReferences.length > 0) {
              disabledReason = "Referenced by an active thread.";
            } else {
              const readiness = yield* inspectWorktreeRemovalReadiness({
                targetPath,
                metadataOperation: "StorageMaintenance.inspect.f5Worktrees.cwd",
                metadataDisabledReason: GIT_WORKTREE_METADATA_UNRESOLVED,
                disposablePaths: disposablePathsFor,
              });
              warnings.push(...readiness.warnings);
              disabledReason = readiness.disabledReason;
              review = readiness.review;
              if (readiness.review) scan?.worktreeReviews.set(targetPath, readiness.review);
            }
            const discards = disabledReason === undefined ? discardDetail(review) : null;

            const relativeLabel = Path.relative(config.worktreesDir, targetPath);
            const contextThread = nonDeletedReferences.toSorted((a, b) =>
              b.lastInteractionAt.localeCompare(a.lastInteractionAt),
            )[0];
            const latestMtimeMs = scan?.byCheckpoint.get(Path.resolve(targetPath))?.latestMtimeMs;
            return {
              id: targetPath,
              label: relativeLabel.length > 0 ? relativeLabel : Path.basename(targetPath),
              ...(contextThread
                ? {
                    threadTitle: contextThread.title,
                    projectName:
                      contextThread.projectName ?? Path.basename(contextThread.workspaceRoot ?? ""),
                  }
                : {}),
              ...(latestMtimeMs ? { latestMtime: new Date(latestMtimeMs).toISOString() } : {}),
              path: targetPath,
              bytes,
              safeToDelete: disabledReason === undefined,
              ...(disabledReason ? { disabledReason } : {}),
              detail: [
                archivedReferences.length > 0
                  ? `Referenced by ${archivedReferences.length} archived thread${
                      archivedReferences.length === 1 ? "" : "s"
                    }.`
                  : "Orphaned F5 worktree.",
                discards,
              ]
                .filter(Boolean)
                .join(" · "),
            } satisfies StorageCleanupTarget;
          }),
        { concurrency: 4 },
      );

      return { targets, warnings };
    });

  /** Registered linked worktrees of each project repository, read once per repository. */
  const listProjectRegistrations = () =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const projects = yield* listProjectRoots();
      const seen = new Set<string>();
      const registrations: Array<{
        readonly entry: RegisteredWorktree;
        readonly projectRoot: string;
        readonly projectName: string;
      }> = [];
      for (const { project, root } of projects) {
        if (root === null) continue;
        const entries = yield* git.listWorktrees(project.workspaceRoot).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              if (!/not a git repository/i.test(error.detail))
                warnings.push(warningFor(project.workspaceRoot, error.detail));
              return [] as ReadonlyArray<RegisteredWorktree>;
            }),
          ),
        );
        for (const entry of entries) {
          if (entry.isMain || entry.bare || seen.has(entry.canonicalPath)) continue;
          seen.add(entry.canonicalPath);
          registrations.push({
            // Git uses forward slashes on Windows. Storage targets and review
            // keys use native paths; preserve GitCore's transport representation.
            entry: { ...entry, path: Path.normalize(entry.path) },
            projectRoot: project.workspaceRoot,
            projectName: project.title,
          });
        }
      }
      return {
        registrations,
        projectRoots: projects.flatMap((entry) => (entry.root ? [entry.root] : [])),
        warnings,
      };
    });

  /**
   * Linked worktrees of project repositories that live outside the F5 and
   * legacy T3 worktrees folders (temporary directories, other tools' folders,
   * sibling checkouts). Removed only with `git worktree remove`, per target.
   */
  const computeExternalWorktreeTargets = (scan?: {
    readonly threads: ReadonlyArray<ThreadRow>;
    readonly worktreeReviews: Map<string, WorktreeReview>;
    readonly signal?: AbortSignal | undefined;
  }) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const allThreads = scan?.threads ?? (yield* queryThreadRows());
      const managedRoot = yield* canonicalOrNull(config.worktreesDir);
      const legacyRoot = yield* canonicalOrNull(Path.join(legacyT3BaseDir(), "worktrees"));
      const disposablePathsFor = yield* makeDisposablePathsLookup;
      const listed = yield* listProjectRegistrations();
      warnings.push(...listed.warnings);
      const candidates: Array<(typeof listed.registrations)[number]> = [];
      for (const registration of listed.registrations) {
        const canonicalPath = registration.entry.canonicalPath;
        if (managedRoot && pathContains(managedRoot, canonicalPath)) continue;
        if (legacyRoot && pathContains(legacyRoot, canonicalPath)) continue;
        if (listed.projectRoots.includes(canonicalPath)) continue;
        const stat = yield* Effect.tryPromise(() => safeLstat(registration.entry.path)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (stat?.isDirectory() && !stat.isSymbolicLink()) candidates.push(registration);
      }
      const targets = yield* Effect.forEach(
        candidates,
        ({ entry, projectRoot, projectName }) =>
          Effect.gen(function* () {
            const targetPath = entry.path;
            const usage = yield* Effect.tryPromise(() =>
              recursiveSize(targetPath, scan?.signal ? { signal: scan.signal } : {}),
            ).pipe(Effect.orElseSucceed(() => null));
            if (usage) warnings.push(...usage.errors);
            else warnings.push(warningFor(targetPath, "Failed to size external worktree."));
            const references = allThreads.filter(
              (thread) =>
                thread.deletedAt === null &&
                thread.worktreePath !== null &&
                (pathsOverlap(targetPath, thread.worktreePath) ||
                  pathsOverlap(entry.canonicalPath, thread.worktreePath)),
            );
            let disabledReason: string | undefined;
            let review: WorktreeReview | undefined;
            if (references.some(isActiveStorageThread)) {
              disabledReason = "Referenced by an active thread.";
            } else {
              const readiness = yield* inspectWorktreeRemovalReadiness({
                targetPath,
                metadataOperation: "StorageMaintenance.inspect.externalWorktrees.cwd",
                metadataDisabledReason: GIT_WORKTREE_METADATA_UNRESOLVED,
                policy: { kind: "externalCleanup", ownThreadId: null },
                commandCwd: projectRoot,
                disposablePaths: disposablePathsFor,
              });
              warnings.push(...readiness.warnings);
              disabledReason = readiness.disabledReason;
              review = readiness.review;
              if (readiness.review) scan?.worktreeReviews.set(targetPath, readiness.review);
            }
            const contextThread = references.toSorted((a, b) =>
              b.lastInteractionAt.localeCompare(a.lastInteractionAt),
            )[0];
            return {
              id: targetPath,
              label: homeRelative(targetPath),
              projectName,
              ...(contextThread ? { threadTitle: contextThread.title } : {}),
              path: targetPath,
              bytes: usage?.bytes ?? 0,
              safeToDelete: disabledReason === undefined,
              ...(disabledReason ? { disabledReason } : {}),
              detail: [
                `External · ${entry.branch ?? "detached"}`,
                disabledReason === undefined ? discardDetail(review) : null,
              ]
                .filter(Boolean)
                .join(" · "),
            } satisfies StorageCleanupTarget;
          }),
        { concurrency: 4 },
      );
      return { targets, warnings };
    });

  /** Unlocked worktree registrations whose directory no longer exists. */
  const computeStaleRegistrationTargets = (threads?: ReadonlyArray<ThreadRow>) =>
    Effect.gen(function* () {
      const allThreads = threads ?? (yield* queryThreadRows());
      const listed = yield* listProjectRegistrations();
      const targets: Array<StorageCleanupTarget & { readonly projectRoot: string }> = [];
      for (const { entry, projectRoot, projectName } of listed.registrations) {
        if (entry.locked !== null) continue;
        const missing = yield* Effect.tryPromise(() => safeLstat(entry.path)).pipe(
          Effect.map((stat) => stat === null),
          Effect.orElseSucceed(() => false),
        );
        if (!missing) continue;
        const active = allThreads.some(
          (thread) =>
            isActiveStorageThread(thread) &&
            thread.worktreePath !== null &&
            Path.resolve(thread.worktreePath) === Path.resolve(entry.path),
        );
        targets.push({
          id: entry.path,
          label: homeRelative(entry.path),
          projectName,
          path: entry.path,
          projectRoot,
          bytes: 0,
          safeToDelete: !active,
          ...(active
            ? {
                disabledReason:
                  "Referenced by an active thread. Recreate or remove it from the thread.",
              }
            : {}),
          detail: `Missing folder · ${entry.branch ?? "detached"}`,
        });
      }
      return { targets, warnings: listed.warnings };
    });

  const enrichLegacyWorktreeTargets = (
    probe: LegacyProbeResult,
    worktreeReviews?: Map<string, WorktreeReview>,
  ): Effect.Effect<LegacyProbeResult, never> =>
    Effect.gen(function* () {
      const worktreeTargets = probe.targetsByCategory.legacyT3Worktrees;
      if (!worktreeTargets || worktreeTargets.length === 0) {
        return probe;
      }

      const warnings: StoragePathWarning[] = [...probe.warnings];
      const enrichedTargets: StorageCleanupTarget[] = [];
      for (const target of worktreeTargets) {
        if (!target.safeToDelete || !target.path) {
          enrichedTargets.push(target);
          continue;
        }

        const readiness = yield* inspectWorktreeRemovalReadiness({
          targetPath: target.path,
          metadataOperation: "StorageMaintenance.inspect.legacyT3Worktrees.cwd",
          metadataDisabledReason: GIT_WORKTREE_METADATA_UNRESOLVED,
        });
        warnings.push(...readiness.warnings);
        if (readiness.review) worktreeReviews?.set(target.path, readiness.review);
        enrichedTargets.push(
          readiness.disabledReason
            ? {
                ...target,
                safeToDelete: false,
                disabledReason: readiness.disabledReason,
              }
            : target,
        );
      }

      return {
        ...probe,
        warnings,
        targetsByCategory: {
          ...probe.targetsByCategory,
          legacyT3Worktrees: enrichedTargets,
        },
      };
    });

  /** The read-only scan behind a usage report, without its confirmation nonce. */
  const scanUsage = (
    signal?: AbortSignal,
    progress: (phase: NonNullable<StorageScanStatus["phase"]>, entries?: number) => void = () => {},
  ) =>
    Effect.gen(function* () {
      const nowMs = Date.now();
      const phaseDurations: Record<string, number> = {};
      let phaseStartedAt = nowMs,
        currentPhase = "database";
      const phase = (next: Parameters<typeof progress>[0], entries?: number) => {
        if (next !== currentPhase) {
          phaseDurations[currentPhase] =
            (phaseDurations[currentPhase] ?? 0) + Date.now() - phaseStartedAt;
          currentPhase = next;
          phaseStartedAt = Date.now();
        }
        progress(next, entries);
      };
      const warnings: StoragePathWarning[] = [];
      if (refreshRemotesBeforeNextScan) {
        refreshRemotesBeforeNextScan = false;
        phase("remotes");
        warnings.push(...(yield* refreshProjectRemotes()));
        phase("database");
      }
      const allThreads = yield* queryThreadRows();
      const archivedThreadCutoffIso = new Date(nowMs - ARCHIVED_THREAD_RETENTION_MS).toISOString();
      const retained = yield* retainedWorkflowThreadIds();
      const deletedThreads = allThreads.filter(
        (thread) => thread.deletedAt !== null && !retained.has(thread.threadId),
      );
      const busySegments = yield* readBusyThreadSegments(allThreads);
      const purgeDeletedThreadCandidates = deletedThreads.filter((thread) => {
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        return segment === null || !busySegments.has(segment);
      });
      const purgeArchivedThreadCandidates = allThreads.filter((thread) => {
        if (
          thread.deletedAt !== null ||
          thread.archivedAt === null ||
          retained.has(thread.threadId) ||
          thread.archivedAt > archivedThreadCutoffIso
        ) {
          return false;
        }
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        return segment === null || !busySegments.has(segment);
      });
      const archivedThreadCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_threads
        WHERE archived_at IS NOT NULL
          AND deleted_at IS NULL
      `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

      phase("files");
      const rootTraversalStartedAt = Date.now();
      const listedWorktrees = yield* Effect.tryPromise(() =>
        listGitWorktreeDirectories({
          root: config.worktreesDir,
          maxDepth: WORKTREE_SCAN_MAX_DEPTH,
        }),
      );
      const providerHomesDir =
        config.providerHomesDir ?? Path.join(config.stateDir, "provider-homes");
      let providerHomesListingFailed = false;
      const providerChildren = yield* Effect.tryPromise(async () => {
        try {
          return (await storageReadDir(providerHomesDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => Path.join(providerHomesDir, entry.name));
        } catch (error) {
          if (!isEnoent(error)) {
            providerHomesListingFailed = true;
            warnings.push(
              warningFor(providerHomesDir, error instanceof Error ? error.message : String(error)),
            );
          }
          return [];
        }
      });
      const worktreeReviews = new Map<string, WorktreeReview>();
      const identities = new Map<string, FileIdentity | null>();
      const checkpointPaths = new Set([
        config.stateDir,
        config.logsDir,
        config.providerLogsDir,
        config.attachmentsDir,
        config.worktreesDir,
        providerHomesDir,
        ...listedWorktrees.paths,
      ]);
      const attachmentFiles: EnumeratedFile[] = [];
      const scannedProviderFiles: EnumeratedFile[] = [];
      const persistenceBytes = { file: 0, directory: 0 };
      let visited = 0,
        lastProgressAt = 0;
      const measured = yield* Effect.tryPromise(() =>
        measureTree([config.stateDir, config.worktreesDir], {
          ...(signal ? { signal } : {}),
          checkpoints: [
            config.stateDir,
            config.logsDir,
            config.providerLogsDir,
            config.attachmentsDir,
            config.worktreesDir,
            providerHomesDir,
            ...providerChildren,
            ...listedWorktrees.paths,
          ],
          onEntry: ({ path, stat, bytes, checkpoints }) => {
            if (path === Path.join(config.stateDir, "storage-usage.json"))
              persistenceBytes.file = bytes;
            if (path === config.stateDir) persistenceBytes.directory = bytes;
            visited++;
            if (Date.now() - lastProgressAt >= 500) {
              lastProgressAt = Date.now();
              phase("files", visited);
            }
            if (
              checkpointPaths.has(path) ||
              checkpoints.includes(config.attachmentsDir) ||
              checkpoints.includes(config.providerLogsDir)
            )
              identities.set(path, fileIdentity(stat));
            if (stat.isFile() && checkpoints.includes(config.providerLogsDir))
              scannedProviderFiles.push({
                path,
                name: Path.basename(path),
                bytes,
                mtimeMs: stat.mtimeMs,
                identity: fileIdentity(stat),
              });
            if (stat.isFile() && checkpoints.includes(config.attachmentsDir))
              attachmentFiles.push({
                path,
                name: Path.basename(path),
                bytes,
                mtimeMs: stat.mtimeMs,
                identity: fileIdentity(stat),
              });
          },
        }),
      );
      phaseDurations.rootTraversal = Date.now() - rootTraversalStartedAt;
      phase("files", measured.entries);
      warnings.push(...measured.warnings, ...listedWorktrees.warnings);
      const usageAt = (path: string) => ({
        bytes: measured.byCheckpoint.get(Path.resolve(path))?.bytes ?? 0,
        errors: measured.warnings.filter(
          (warning) =>
            isPathWithinRoot({ root: path, target: warning.path }) ||
            isPathWithinRoot({ root: warning.path, target: path }),
        ),
      });
      const logsUsage = usageAt(config.logsDir);
      const attachmentsUsage = usageAt(config.attachmentsDir);
      const worktreesUsage = usageAt(config.worktreesDir);
      const providerHomesUsage = usageAt(providerHomesDir);
      const databaseBytes = yield* Effect.tryPromise(() => databaseFileBytes(config.dbPath));
      const attachmentsStartedAt = Date.now();
      const orphanAttachmentRows = yield* sql<OrphanAttachmentRow>`
        SELECT
          attachment.attachment_id AS "attachmentId",
          attachment.name AS "name",
          attachment.final_path AS "finalPath",
          attachment.lifecycle AS lifecycle, cleanup.last_error AS "lastError"
        FROM attachments AS attachment
        LEFT JOIN attachment_cleanup_jobs AS cleanup USING (attachment_id)
        WHERE attachment.lifecycle IN ('ready', 'deleting') AND NOT EXISTS (
          SELECT 1
          FROM attachment_owners AS owner
          WHERE owner.attachment_id = attachment.attachment_id
        )
        ORDER BY attachment.created_at ASC
      `;
      const attachmentMeasurements = new Map(
        attachmentFiles.map((file) => [file.path, file.bytes]),
      );
      const orphanAttachmentTargets = yield* Effect.forEach(
        orphanAttachmentRows,
        (attachment) =>
          Effect.tryPromise({
            try: async () => attachmentMeasurements.get(attachment.finalPath) ?? 0,
            catch: (cause) =>
              new StorageMaintenanceError({
                operation: "StorageMaintenance.inspect.orphanAttachments",
                message: "Failed to inspect an orphaned attachment.",
                cause,
              }),
          }).pipe(
            Effect.map(
              (bytes): StorageCleanupTarget => ({
                id: attachment.attachmentId,
                label: attachment.name,
                ...(attachment.lastError
                  ? { detail: `Previous cleanup: ${attachment.lastError}` }
                  : attachment.lifecycle === "deleting"
                    ? { detail: "Previous cleanup was interrupted; retry removal." }
                    : {}),
                path: attachment.finalPath,
                bytes,
                safeToDelete: isPathWithinRoot({
                  root: config.attachmentsDir,
                  target: attachment.finalPath,
                }),
                ...(!isPathWithinRoot({
                  root: config.attachmentsDir,
                  target: attachment.finalPath,
                })
                  ? { disabledReason: "Attachment path is outside the attachment storage root." }
                  : {}),
              }),
            ),
          ),
        { concurrency: 8 },
      );
      phaseDurations.attachments = Date.now() - attachmentsStartedAt;
      const liveWorktreePaths = new Set(
        allThreads
          .filter((thread) => isActiveStorageThread(thread) && thread.worktreePath !== null)
          .map((thread) => Path.resolve(thread.worktreePath!)),
      );
      phase("legacy");
      const legacyProbe = yield* Effect.tryPromise({
        try: () => probeLegacyState({ config, liveWorktreePaths, ...(signal ? { signal } : {}) }),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.legacy",
            message: "Failed to inspect legacy T3/F5 state.",
            cause,
          }),
      }).pipe(Effect.flatMap((probe) => enrichLegacyWorktreeTargets(probe, worktreeReviews)));
      warnings.push(...legacyProbe.warnings);

      const deletedSegments = new Set(
        purgeDeletedThreadCandidates.map((thread) =>
          toSafeThreadAttachmentSegment(thread.threadId),
        ),
      );
      const archivedSegments = new Set(
        purgeArchivedThreadCandidates.map((thread) =>
          toSafeThreadAttachmentSegment(thread.threadId),
        ),
      );
      const attachmentSegment = (file: EnumeratedFile) => {
        const id = parseAttachmentIdFromRelativePath(file.name);
        return id ? parseThreadSegmentFromAttachmentId(id) : null;
      };
      const deletedThreadAttachmentFiles = attachmentFiles.filter((file) => {
        const segment = attachmentSegment(file);
        return segment !== null && deletedSegments.has(segment);
      });
      const archivedThreadAttachmentFiles = attachmentFiles.filter((file) => {
        const segment = attachmentSegment(file);
        return segment !== null && archivedSegments.has(segment);
      });
      const providerLogsStartedAt = Date.now();
      const providerLogCandidates = yield* computeProviderLogCandidates(allThreads, {
        files: scannedProviderFiles,
        busySegments,
      });
      warnings.push(...providerLogCandidates.warnings);
      const eventsRotationCandidates =
        yield* computeEventsLogRotationCandidates(scannedProviderFiles);
      warnings.push(...eventsRotationCandidates.warnings);
      phaseDurations.providerLogs = Date.now() - providerLogsStartedAt;
      phase("worktrees", measured.entries);
      const f5WorktreeCandidates = yield* computeF5WorktreeTargets({
        threads: allThreads,
        paths: listedWorktrees.paths,
        byCheckpoint: measured.byCheckpoint,
        worktreeReviews,
      });
      warnings.push(...f5WorktreeCandidates.warnings);
      const externalWorktreeCandidates = yield* computeExternalWorktreeTargets({
        threads: allThreads,
        worktreeReviews,
        signal,
      });
      warnings.push(...externalWorktreeCandidates.warnings);
      const staleRegistrationCandidates = yield* computeStaleRegistrationTargets(allThreads);
      warnings.push(...staleRegistrationCandidates.warnings);
      const vacuumBytes = yield* computeVacuumReclaimableBytes();
      phase("providers", measured.entries);
      const codexLeftovers = yield* computeCodexMarketplaceLeftovers(signal);

      const deletedProviderLogBytes = providerLogCandidates.files
        .filter((file) => deletedSegments.has(file.segment))
        .reduce((total, file) => total + file.bytes, 0);
      const archivedProviderLogBytes = providerLogCandidates.files
        .filter((file) => archivedSegments.has(file.segment))
        .reduce((total, file) => total + file.bytes, 0);
      const purgeDeletedBytes =
        deletedThreadAttachmentFiles.reduce((total, file) => total + file.bytes, 0) +
        deletedProviderLogBytes;
      const purgeArchivedBytes =
        archivedThreadAttachmentFiles.reduce((total, file) => total + file.bytes, 0) +
        archivedProviderLogBytes;
      const terminalProviderLogBytes = providerLogCandidates.files.reduce(
        (total, file) => total + file.bytes,
        0,
      );
      const eventsRotationBytes = eventsRotationCandidates.files.reduce(
        (total, file) => total + file.bytes,
        0,
      );
      const f5WorktreeReclaimableBytes = f5WorktreeCandidates.targets
        .filter((target) => target.safeToDelete)
        .reduce((total, target) => total + target.bytes, 0);

      const threadSegments = new Set(
        allThreads
          .map((thread) => toSafeThreadAttachmentSegment(thread.threadId))
          .filter((segment): segment is string => segment !== null),
      );
      const attachmentIndex = indexFilesBySegment(attachmentFiles, threadSegments, "attachments");
      const providerLogIndex = indexFilesBySegment(
        providerLogCandidates.files,
        threadSegments,
        "logs",
      );
      const threadFileBytes = (thread: ThreadRow) => {
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        return segment
          ? [
              ...(attachmentIndex.get(segment) ?? []),
              ...(providerLogIndex.get(segment) ?? []),
            ].reduce((sum, file) => sum + file.bytes, 0)
          : 0;
      };
      const categories: StorageCleanupCategoryUsage[] = [
        categoryUsage({
          id: "purgeDeletedThreads",
          section: "database",
          title: "Purge deleted threads",
          description:
            "Permanently removes rows, attachments, and provider logs for threads already deleted in the UI.",
          bytes: purgeDeletedBytes,
          reclaimableBytes: purgeDeletedBytes,
          defaultSelected: true,
          impact: "none",
          disabledReason:
            deletedThreads.length === 0
              ? "There are no deleted threads to purge."
              : purgeDeletedThreadCandidates.length === 0
                ? "Deleted threads are currently tied to busy provider sessions."
                : undefined,
          targets: purgeDeletedThreadCandidates.map((thread) => ({
            id: thread.threadId,
            label: thread.title,
            threadTitle: thread.title,
            ...(thread.deletedAt ? { detail: `Deleted ${thread.deletedAt}` } : {}),
            bytes: threadFileBytes(thread),
            safeToDelete: true,
          })),
        }),
        categoryUsage({
          id: "purgeArchivedThreads",
          section: "database",
          title: "Purge archived threads older than 30 days",
          description:
            "Permanently deletes old archived threads, their attachments, provider logs, and database history.",
          bytes: purgeArchivedBytes,
          reclaimableBytes: purgeArchivedBytes,
          defaultSelected: false,
          impact: "high",
          disabledReason:
            purgeArchivedThreadCandidates.length === 0
              ? "There are no archived threads older than 30 days to purge."
              : undefined,
          targets: purgeArchivedThreadCandidates.map((thread) => ({
            id: thread.threadId,
            label: thread.title,
            bytes: threadFileBytes(thread),
            safeToDelete: true,
            ...(thread.archivedAt ? { detail: `Archived ${thread.archivedAt}` } : {}),
          })),
        }),
        categoryUsage({
          id: "databaseVacuum",
          section: "database",
          title: "Compact database",
          description:
            "Runs SQLite VACUUM after checking that enough free disk space is available.",
          bytes: databaseBytes,
          reclaimableBytes: vacuumBytes,
          defaultSelected: false,
          impact: "low",
          disabledReason: databaseBytes <= 0 ? "Database file does not exist." : undefined,
        }),
        categoryUsage({
          id: "inactiveF5Worktrees",
          section: "worktrees",
          title: "Delete inactive F5 worktrees",
          description:
            "Removes merged or pushed F5 worktrees that are orphaned or referenced only by archived threads. Build output is deleted; other uncommitted work keeps a worktree. Merged branches are deleted unless an archived thread needs them.",
          bytes: worktreesUsage.bytes,
          reclaimableBytes: f5WorktreeReclaimableBytes,
          defaultSelected: false,
          impact: "high",
          targets: f5WorktreeCandidates.targets,
        }),
        categoryUsage({
          id: "externalWorktrees",
          section: "worktrees",
          title: "Delete external worktrees",
          description:
            "Removes merged or pushed worktrees of your projects that live outside F5's worktrees folder, such as temporary or other tools' checkouts, with git worktree remove. Merged branches are deleted.",
          bytes: externalWorktreeCandidates.targets.reduce(
            (total, target) => total + target.bytes,
            0,
          ),
          reclaimableBytes: externalWorktreeCandidates.targets
            .filter((target) => target.safeToDelete)
            .reduce((total, target) => total + target.bytes, 0),
          defaultSelected: false,
          impact: "high",
          targets: externalWorktreeCandidates.targets,
        }),
        categoryUsage({
          id: "staleWorktreeRegistrations",
          section: "worktrees",
          title: "Prune missing worktree entries",
          description:
            "Forgets Git worktree registrations whose folder no longer exists. Nothing on disk is deleted.",
          bytes: 0,
          reclaimableBytes: 0,
          defaultSelected: true,
          impact: "none",
          targets: staleRegistrationCandidates.targets.map(
            ({ projectRoot: _projectRoot, ...target }) => target,
          ),
        }),
        categoryUsage({
          id: "providerLogsForTerminalThreads",
          section: "logs",
          title: "Prune logs for terminal threads",
          description: "Deletes diagnostic provider logs for threads that are no longer live.",
          bytes: logsUsage.bytes,
          reclaimableBytes: terminalProviderLogBytes,
          defaultSelected: true,
          impact: "none",
          targets: providerLogCandidates.files.map((file) => ({
            id: file.path,
            label: file.name,
            path: file.path,
            bytes: file.bytes,
            safeToDelete: true,
          })),
        }),
        categoryUsage({
          id: "providerLogRotations",
          section: "logs",
          title: "Prune old events.log rotations",
          description: "Deletes provider events.log rotations older than 30 days.",
          bytes: logsUsage.bytes,
          reclaimableBytes: eventsRotationBytes,
          defaultSelected: true,
          impact: "none",
          targets: eventsRotationCandidates.files.map((file) => ({
            id: file.path,
            label: file.name,
            path: file.path,
            bytes: file.bytes,
            safeToDelete: true,
          })),
        }),
        categoryUsage({
          id: "orphanAttachments",
          section: "attachments",
          title: "Delete orphaned attachments",
          description:
            "Deletes attachment files that are no longer owned by a queued turn or message.",
          bytes: attachmentsUsage.bytes,
          reclaimableBytes: orphanAttachmentTargets
            .filter((target) => target.safeToDelete)
            .reduce((total, target) => total + target.bytes, 0),
          defaultSelected: false,
          impact: "none",
          targets: orphanAttachmentTargets,
        }),
      ];
      if (codexLeftovers !== null) {
        const codexLeftoverBytes = codexLeftovers.reduce((total, entry) => total + entry.bytes, 0);
        categories.push(
          categoryUsage({
            id: "codexMarketplaceStaging",
            section: "providers",
            title: "Delete leftover Codex marketplace clones",
            description:
              "Deletes marketplace upgrade clones and backups older than 2 hours that Codex left in .tmp/marketplaces. Codex downloads the marketplace again on its next upgrade. Also runs hourly on its own.",
            bytes: codexLeftoverBytes,
            reclaimableBytes: codexLeftoverBytes,
            defaultSelected: true,
            impact: "none",
            targets: codexLeftovers.map(({ leftover, bytes }) => ({
              id: leftover.path,
              label: `${leftover.kind === "staging" ? "Upgrade clone" : "Upgrade backup"} ${Path.basename(leftover.path)}`,
              path: leftover.path,
              bytes,
              safeToDelete: true,
            })),
          }),
        );
      }

      const legacyCategoryMeta: ReadonlyArray<{
        readonly id: LegacyCleanupCategoryId;
        readonly title: string;
        readonly description: string;
      }> = [
        {
          id: "legacyT3Userdata",
          title: "Delete legacy ~/.t3/userdata",
          description: "Removes the migrated legacy T3 userdata source.",
        },
        {
          id: "legacyT3Diverged",
          title: "Delete legacy diverged snapshots",
          description: "Removes manual userdata.f5-diverged snapshots under ~/.t3.",
        },
        {
          id: "legacyT3Worktrees",
          title: "Delete legacy worktrees",
          description: "Removes unreferenced legacy T3 Git worktrees using git worktree remove.",
        },
        {
          id: "legacyT3Dev",
          title: "Delete legacy ~/.t3/dev",
          description: "Removes legacy development state.",
        },
        {
          id: "legacyT3Caches",
          title: "Delete legacy ~/.t3/caches",
          description: "Removes caches that can be rebuilt on demand.",
        },
        {
          id: "legacyT3Root",
          title: "Delete empty ~/.t3 root",
          description:
            "Removes the legacy root directory once all offered subdirectories are gone.",
        },
        {
          id: "f5UserdataEmpty",
          title: "Delete empty F5 userdata artifacts",
          description: "Removes recognizable ~/.f5/userdata.empty.* directories.",
        },
      ];

      for (const meta of legacyCategoryMeta) {
        const targets = legacyProbe.targetsByCategory[meta.id] ?? [];
        if (targets.length === 0 && meta.id === "f5UserdataEmpty") {
          continue;
        }
        const bytes = targets.reduce((total, target) => total + target.bytes, 0);
        const safeBytes = targets
          .filter((target) => target.safeToDelete)
          .reduce((total, target) => total + target.bytes, 0);
        const unsafeTarget = targets.find((target) => !target.safeToDelete);
        const isTargetLevelCleanup = meta.id === "legacyT3Worktrees";
        categories.push(
          categoryUsage({
            id: meta.id,
            section: "legacy",
            title: meta.title,
            description: meta.description,
            bytes,
            reclaimableBytes: isTargetLevelCleanup ? safeBytes : unsafeTarget ? 0 : bytes,
            defaultSelected: false,
            impact: "high",
            targets,
            disabledReason:
              legacyProbe.disabledReason ??
              (isTargetLevelCleanup && safeBytes > 0 ? undefined : unsafeTarget?.disabledReason),
          }),
        );
      }

      let remainingWarnings = 200;
      for (let index = 0; index < categories.length; index++) {
        const category = categories[index]!;
        const root =
          category.section === "logs"
            ? config.logsDir
            : category.section === "attachments" || category.id.startsWith("purge")
              ? config.attachmentsDir
              : category.section === "worktrees"
                ? config.worktreesDir
                : category.section === "providers"
                  ? providerHomesDir
                  : category.section === "legacy"
                    ? legacyT3BaseDir()
                    : config.stateDir;
        const measurementRoots =
          category.id === "databaseVacuum"
            ? [
                config.dbPath,
                `${config.dbPath}-wal`,
                `${config.dbPath}-shm`,
                `${config.dbPath}-journal`,
              ]
            : category.section === "providers"
              ? category.targets.flatMap((target) => (target.path ? [target.path] : []))
              : [root];
        const errors = warnings.filter((warning) =>
          measurementRoots.some(
            (root) =>
              isPathWithinRoot({ root, target: warning.path }) ||
              isPathWithinRoot({ root: warning.path, target: root }),
          ),
        );
        const measurement = errors.length
          ? category.bytes > 0
            ? ("partial" as const)
            : ("unavailable" as const)
          : category.measurement;
        const categoryWarnings = [...category.warnings, ...errors]
          .slice(0, remainingWarnings)
          .map((warning) => warningFor(warning.path, warning.reason));
        remainingWarnings -= categoryWarnings.length;
        categories[index] = {
          ...category,
          measurement,
          warnings: categoryWarnings,
          ...(measurement === "unavailable"
            ? { disabledReason: "Measurement is unavailable. Rescan to retry." }
            : {}),
        };
      }
      const fileCandidates = new Map<string, number>();
      for (const file of [
        ...deletedThreadAttachmentFiles,
        ...archivedThreadAttachmentFiles,
        ...providerLogCandidates.files,
        ...eventsRotationCandidates.files,
      ])
        fileCandidates.set(file.path, file.bytes);
      for (const target of orphanAttachmentTargets)
        if (target.safeToDelete && target.path) fileCandidates.set(target.path, target.bytes);
      const treeCandidates = categories
        .filter(
          (category) =>
            category.section === "worktrees" ||
            category.section === "legacy" ||
            category.section === "providers",
        )
        .flatMap((category) =>
          category.availability === "ready"
            ? category.targets
                .filter((target) => target.safeToDelete && target.path)
                .map((target) => ({ path: target.path!, bytes: target.bytes }))
            : [],
        );
      for (const path of fileCandidates.keys())
        if (treeCandidates.some((tree) => pathContainsOrEquals(tree.path, path)))
          fileCandidates.delete(path);
      const reclaimableBytes =
        [...fileCandidates.values()].reduce((sum, bytes) => sum + bytes, 0) +
        sumNonOverlappingPathUsages(treeCandidates) +
        vacuumBytes;
      const legacyUsages = Object.values(legacyProbe.targetsByCategory)
        .flatMap((targets) =>
          targets.map((target) => ({ path: target.path ?? target.id, bytes: target.bytes })),
        )
        .filter(
          (target) =>
            !pathContainsOrEquals(config.stateDir, target.path) &&
            !pathContainsOrEquals(config.worktreesDir, target.path),
        );
      const legacyOverlap =
        (legacyUsages.some((entry) => pathContainsOrEquals(entry.path, config.stateDir))
          ? usageAt(config.stateDir).bytes
          : 0) +
        (!pathContainsOrEquals(config.stateDir, config.worktreesDir) &&
        legacyUsages.some((entry) => pathContainsOrEquals(entry.path, config.worktreesDir))
          ? worktreesUsage.bytes
          : 0);
      const legacyBytes = Math.max(0, sumNonOverlappingPathUsages(legacyUsages) - legacyOverlap);
      const usage: Omit<StorageUsageReport, "scanId"> = {
        scannedAt: nowIso(),
        stateDir: config.stateDir,
        totalUsedBytes: measured.totalBytes + legacyBytes,
        reclaimableBytes,
        providerHomesBytes: providerHomesUsage.bytes,
        providerHomesMeasurement: providerHomesListingFailed
          ? "unavailable"
          : providerHomesUsage.errors.length
            ? providerHomesUsage.bytes > 0
              ? "partial"
              : "unavailable"
            : "complete",
        providerHomes: providerChildren.map((path) => ({
          name: Path.basename(path),
          path,
          bytes: usageAt(path).bytes,
        })),
        otherBytes: Math.max(
          0,
          measured.totalBytes -
            worktreesUsage.bytes -
            databaseBytes -
            logsUsage.bytes -
            attachmentsUsage.bytes -
            usageAt(providerHomesDir).bytes,
        ),
        warningsTruncated: warnings.length > 200,
        databaseBytes,
        worktreesBytes: worktreesUsage.bytes,
        logsBytes: logsUsage.bytes,
        attachmentsBytes: attachmentsUsage.bytes,
        legacyBytes,
        threadCount: allThreads.length,
        archivedThreadCount,
        deletedThreadCount: deletedThreads.length,
        providerLogSegmentCount: providerLogCandidates.segmentCount,
        envOverrideActive: legacyProbe.envOverrideActive,
        ...(legacyProbe.disabledReason
          ? { legacyCleanupDisabledReason: legacyProbe.disabledReason }
          : {}),
        categories,
        warnings: warnings.slice(0, 200).map((warning) => warningFor(warning.path, warning.reason)),
      };
      yield* Effect.forEach(
        categories
          .flatMap((category) => category.targets)
          .filter((target) => target.path && !identities.has(target.path)),
        (target) =>
          Effect.promise(async () => {
            const stat = await safeLstat(target.path!);
            identities.set(target.path!, stat ? fileIdentity(stat) : null);
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => warnings.push(warningFor(target.path!, String(error)))),
            ),
          ),
        { concurrency: 16, discard: true },
      );
      phase("finalizing", measured.entries);
      yield* Effect.logInfo("storage scan finished", {
        durationMs: Date.now() - nowMs,
        entries: measured.entries,
        phaseDurations: { ...phaseDurations, finalizing: Date.now() - phaseStartedAt },
        cacheHits: 0,
      });
      return {
        usage,
        persistenceBytes,
        review: {
          identities,
          worktrees: worktreeReviews,
          threads: new Map(allThreads.map((thread) => [thread.threadId, thread])),
        },
      };
    });

  const coordinator = yield* makeUsageScanCoordinator({
    stateDir: config.stateDir,
    scan: (signal, progress) =>
      scanUsage(signal, progress).pipe(
        Effect.map(({ usage, review, persistenceBytes }) => {
          const scanId = Crypto.randomUUID();
          scanReviews.set(scanId, review);
          while (scanReviews.size > 2) scanReviews.delete(scanReviews.keys().next().value!);
          return { report: { ...usage, scanId }, persistenceBytes };
        }),
        Effect.mapError(toStorageMaintenanceError("StorageMaintenance.scan")),
      ),
  });
  const pruneConfirmations = () => {
    const now = Date.now();
    for (const [id, issued] of issuedConfirmations)
      if (issued.expiresAtMs <= now) issuedConfirmations.delete(id);
  };
  yield* Effect.forever(
    Effect.sleep("30 seconds").pipe(Effect.andThen(Effect.sync(pruneConfirmations))),
  ).pipe(Effect.forkIn(scope));
  const noteStorageMutated = coordinator.noteMutated;
  const workflowEligibilityFingerprint = () =>
    engine.getReadModel().pipe(
      Effect.map((model) =>
        canonicalJsonHash(
          workflowEntries(model)
            .map((entry) => ({
              kind: entry.kind,
              id: entry.workflow.id,
              archivedAt: entry.workflow.archivedAt,
              deletedAt: entry.workflow.deletedAt,
              threadIds: entry.threadIds.toSorted(),
            }))
            .toSorted((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
        ),
      ),
    );
  let workflowEligibility = yield* workflowEligibilityFingerprint();
  yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
    Effect.gen(function* () {
      if (event.type === "thread.archived" || event.type === "thread.unarchived") {
        yield* noteStorageMutated;
      } else if (event.type.startsWith("project.") && event.type.includes("workflow")) {
        const next = yield* workflowEligibilityFingerprint();
        if (next !== workflowEligibility) {
          workflowEligibility = next;
          yield* noteStorageMutated;
        }
      }
    }),
  ).pipe(Effect.forkIn(scope, { startImmediately: true }));
  const getStatus: StorageMaintenanceShape["getStatus"] = Effect.gen(function* () {
    const state = yield* coordinator.snapshot;
    return {
      backendEpoch,
      revision: state.revision + operationRevision,
      updatedAt: nowIso(),
      scan: state.scan,
      cleanup: cleanupStatus,
    };
  });
  const getUsage: StorageMaintenanceShape["getUsage"] = (request = {}) =>
    Effect.gen(function* () {
      pruneConfirmations();
      if (request.force) refreshRemotesBeforeNextScan = true;
      let state = yield* coordinator.snapshot;
      if (
        request.force ||
        !state.latest ||
        state.latest.generation !== state.generation ||
        Date.now() - Date.parse(state.latest.report.scannedAt) >= USAGE_CACHE_TTL_MS
      ) {
        yield* coordinator.request(request.force);
        state = yield* coordinator.snapshot;
      }
      const latest = state.latest;
      let confirmation = null;
      if (
        latest &&
        latest.generation === state.generation &&
        Date.now() - Date.parse(latest.report.scannedAt) < USAGE_CACHE_TTL_MS
      ) {
        let issued = issuedConfirmations.get(latest.report.scanId);
        if (!issued) {
          issued = {
            scanId: latest.report.scanId,
            nonce: Crypto.randomUUID(),
            expiresAtMs: Date.now() + NONCE_TTL_MS,
            generation: state.generation,
            review: scanReviews.get(latest.report.scanId) ?? {
              identities: new Map(),
              worktrees: new Map(),
              threads: new Map(),
            },
            used: false,
            categories: new Map(
              latest.report.categories.map((category) => [category.id, category]),
            ),
          };
          issuedConfirmations.set(issued.scanId, issued);
          if (issuedConfirmations.size > 16)
            issuedConfirmations.delete(issuedConfirmations.keys().next().value!);
        }
        if (!issued.used && issued.expiresAtMs > Date.now())
          confirmation = {
            scanId: issued.scanId,
            nonce: issued.nonce,
            expiresAt: new Date(issued.expiresAtMs).toISOString(),
          };
      }
      return {
        report: latest
          ? {
              ...latest.report,
              categories: latest.report.categories.map((category) => ({
                ...category,
                targets: category.targets
                  .toSorted((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))
                  .slice(0, 500),
              })),
            }
          : null,
        confirmation,
        status: yield* getStatus,
      };
    });
  const inspect: StorageMaintenanceShape["inspect"] = (request = {}) =>
    Effect.gen(function* () {
      if (request.force) refreshRemotesBeforeNextScan = true;
      yield* coordinator.request(request.force);
      const latest = yield* coordinator.awaitLatest;
      if (!latest)
        return yield* new StorageMaintenanceError({
          operation: "inspect",
          message: "Storage scan failed.",
        });
      const usage = yield* getUsage();
      return { ...latest.report, confirmationNonce: usage.confirmation?.nonce ?? "expired" };
    });
  const summarizeReclaimable: StorageMaintenanceShape["summarizeReclaimable"] = Effect.gen(
    function* () {
      let latest = (yield* coordinator.snapshot).latest;
      if (!latest || Date.now() - Date.parse(latest.report.scannedAt) > 30 * 60_000) {
        yield* coordinator.request();
        latest = yield* coordinator.awaitLatest;
      }
      return (
        latest?.report.categories
          .filter((category) => category.availability === "ready" && category.reclaimableBytes > 0)
          .map((category) => ({
            categoryId: category.id,
            title: category.title,
            bytes: category.reclaimableBytes,
          }))
          .toSorted((a, b) => b.bytes - a.bytes) ?? []
      );
    },
  );

  const validateCleanupRequest = (request: CleanupInput) =>
    Effect.gen(function* () {
      const nonce = issuedConfirmations.get(request.scanId);
      if (nonce && nonce.generation !== (yield* coordinator.snapshot).generation)
        return yield* new StorageMaintenanceError({
          operation: "cleanup.validate",
          message:
            "Storage changed since this report was made. Review the refreshed report and try again.",
        });
      if (!nonce) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: "Storage scan expired or was evicted. Rescan to review cleanup.",
        });
      }
      if (nonce.used) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: "The storage cleanup confirmation nonce has already been used.",
        });
      }
      if (nonce.expiresAtMs <= Date.now()) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: "The storage cleanup confirmation nonce expired.",
        });
      }
      if (nonce.scanId !== request.scanId || nonce.nonce !== request.nonce) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: "The storage cleanup confirmation nonce does not match the current scan.",
        });
      }
      const requested = uniqueCategoryIds(request.categoryIds);
      const rejected = requested.find(
        (categoryId) => nonce.categories.get(categoryId)?.availability !== "ready",
      );
      if (rejected) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: `Storage cleanup category '${rejected}' is not available for this scan.`,
        });
      }
      const targetSelections = normalizeTargetSelections(request.targetSelections);
      for (const [categoryId, selectedTargetIds] of targetSelections) {
        const category = nonce.categories.get(categoryId);
        if (!category || !requested.includes(categoryId)) {
          return yield* new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.validate",
            message: `Storage cleanup target selection for '${categoryId}' is not part of this request.`,
          });
        }
        const allowedTargetIds = new Set(category.targets.map((target) => target.id));
        const rejectedTargetId = Array.from(selectedTargetIds).find(
          (targetId) => !allowedTargetIds.has(targetId),
        );
        if (rejectedTargetId) {
          return yield* new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.validate",
            message: `Storage cleanup target '${rejectedTargetId}' is not available for '${categoryId}'.`,
          });
        }
      }
      for (const categoryId of requested) {
        if (
          (categoryId === "legacyT3Worktrees" ||
            categoryId === "inactiveF5Worktrees" ||
            categoryId === "externalWorktrees") &&
          !targetSelections.has(categoryId)
        ) {
          return yield* new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.validate",
            message: `${categoryId} cleanup requires explicit target selection.`,
          });
        }
      }
      const requestedCategories = requested.map((categoryId) => {
        const category = nonce.categories.get(categoryId)!;
        const selected = targetSelections.get(categoryId);
        return selected
          ? { ...category, targets: category.targets.filter((target) => selected.has(target.id)) }
          : category;
      });
      for (const category of requestedCategories)
        if (!targetSelections.has(category.id))
          targetSelections.set(
            category.id,
            new Set(
              category.targets.filter((target) => target.safeToDelete).map((target) => target.id),
            ),
          );
      if (
        cleanupRequiresTypedDelete({
          categories: requestedCategories,
          targetSelections,
        }) &&
        request.confirmationText !== "DELETE"
      ) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: "Storage cleanup requires typed DELETE confirmation.",
        });
      }
      operationReviews.set(request.operationId, nonce.review);
      nonce.used = true;
      return {
        categoryIds: requested,
        requestedCategories,
        targetSelections,
      };
    });

  const publishProgress = (
    request: CleanupOperation,
    context: StorageCleanupContext | undefined,
    event: Omit<StorageCleanupProgressPayload, "operationId">,
  ) =>
    (context?.publishProgress ?? (() => Effect.void))({
      operationId: request.operationId,
      ...event,
      message: event.message.replace(/\s+/g, " ").slice(0, 300),
    });

  const checkCancelled = (operationId: string) => cancelledOperations.has(operationId);

  const deleteProviderLogFiles = (
    request: CleanupOperation,
    context: StorageCleanupContext | undefined,
    categoryId: StorageCleanupCategoryId,
    files: ReadonlyArray<EnumeratedFile>,
    preserveArchived = false,
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const knownThreads =
        categoryId === "providerLogsForTerminalThreads" ? yield* queryThreadRows() : [];
      const ownersBySegment = new Map<string, ThreadRow[]>();
      for (const thread of knownThreads) {
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        if (segment)
          ownersBySegment.set(segment, [...(ownersBySegment.get(segment) ?? []), thread]);
      }
      const grouped = new Map<string | null, EnumeratedFile[]>();
      for (const file of files) {
        const segment =
          categoryId === "providerLogsForTerminalThreads"
            ? providerLogSegmentFromName(file.name)
            : null;
        const bucket = grouped.get(segment) ?? [];
        bucket.push(file);
        grouped.set(segment, bucket);
      }
      let completedTargets = 0;
      for (const [segment, group] of grouped) {
        const owners = (segment ? (ownersBySegment.get(segment) ?? []) : []).toSorted((a, b) =>
          a.threadId.localeCompare(b.threadId),
        );
        // Bound time under the engine gate and amortize final eligibility queries
        // across rotations for the same conversation, rather than over every file.
        for (let offset = 0; offset < group.length; offset += 32) {
          if (checkCancelled(request.operationId)) break;
          const batch = group.slice(offset, offset + 32);
          yield* publishProgress(request, context, {
            categoryId,
            phase: "deleting",
            message: `Deleting ${batch[0]!.name}`,
            completedTargets,
            totalTargets: files.length,
          });
          const remove = Effect.gen(function* () {
            if (checkCancelled(request.operationId)) return;
            const gate = yield* engine.acquireMaintenanceLock();
            yield* Effect.gen(function* () {
              if (checkCancelled(request.operationId)) return;
              if (segment) {
                const matching = (yield* queryThreadRows()).filter(
                  (thread) => toSafeThreadAttachmentSegment(thread.threadId) === segment,
                );
                const busy = yield* readBusyThreadSegments(matching);
                if (
                  busy.has(segment) ||
                  matching.some((thread) =>
                    preserveArchived ? thread.deletedAt === null : isActiveStorageThread(thread),
                  )
                ) {
                  warnings.push(
                    warningFor(
                      batch[0]!.path,
                      "Skipped logs because their conversation became active.",
                    ),
                  );
                  return;
                }
              }
              for (const file of batch) {
                if (checkCancelled(request.operationId)) break;
                const deletion = yield* Effect.promise(() =>
                  removeFileIfSafe({
                    path: file.path,
                    allowedRoot: config.providerLogsDir,
                    expectedIdentity: reviewIdentity(request.operationId, file.path, file.identity),
                    isCancelled: () => checkCancelled(request.operationId),
                  }),
                );
                if (deletion.kind === "removed") markStorageMutation(request.operationId);
                if (deletion.warning) warnings.push(deletion.warning);
                else
                  perTargetReclaimed.push({
                    id: file.path,
                    path: file.path,
                    reclaimedBytes: deletion.reclaimedBytes,
                    status: "Removed",
                  });
              }
            }).pipe(Effect.ensuring(Scope.close(gate, Exit.void).pipe(Effect.ignore)));
          });
          yield* owners.reduceRight(
            (effect, thread) => withProviderThreadAccess(thread.threadId, effect),
            remove,
          );
          completedTargets += batch.length;
        }
      }
      return resultFor({
        categoryId,
        status: perTargetReclaimed.length ? "Cleaned" : warnings.length ? "Failed" : "Skipped",
        perTargetReclaimed,
        reclaimedBytes: perTargetReclaimed.reduce((sum, target) => sum + target.reclaimedBytes, 0),
        warnings,
      });
    });

  const purgeBlockReason = (thread: ThreadRow) =>
    Effect.gen(function* () {
      const scheduledBlock = yield* assertScheduledThreadPurgeable(sql, thread.threadId).pipe(
        Effect.as<string | undefined>(undefined),
        Effect.catchTag("ScheduledThreadPurgeBlocked", (error) => Effect.succeed(error.message)),
      );
      if (scheduledBlock) return scheduledBlock;
      if ((yield* retainedWorkflowThreadIds()).has(thread.threadId))
        return "Referenced by a workflow; delete the workflow before permanently purging its threads.";
      const rows = yield* sql<{ reason: string }>`
      SELECT 'Provider delivery needs recovery.' AS reason WHERE EXISTS (
        SELECT 1 FROM provider_turn_deliveries WHERE thread_id = ${thread.threadId}
        AND (state IN ('sending', 'ambiguous') OR reservation_released_at IS NULL))
      UNION ALL SELECT 'Settlement script process completion needs recovery.' WHERE EXISTS (
        SELECT 1 FROM thread_settlement_hooks WHERE thread_id = ${thread.threadId}
        AND state IN ('pending', 'running', 'orphaned'))
      UNION ALL SELECT 'Native operation needs recovery.' WHERE EXISTS (
        SELECT 1 FROM native_operations WHERE thread_id = ${thread.threadId}
        AND state IN ('requested', 'dispatched', 'running', 'indeterminate'))
      UNION ALL SELECT 'Rewind needs recovery.' WHERE EXISTS (
        SELECT 1 FROM rewind_operations WHERE thread_id = ${thread.threadId} AND state <> 'completed')
        OR EXISTS (SELECT 1 FROM rewind_requests WHERE thread_id = ${thread.threadId})
      UNION ALL SELECT 'Workspace transition needs recovery.' WHERE EXISTS (
        SELECT 1 FROM workspace_transitions WHERE thread_id = ${thread.threadId}
        AND phase IN ('reserved', 'stopping', 'applying', 'applied', 'needs_recovery'))
      UNION ALL SELECT 'Worktree preparation needs recovery.' WHERE EXISTS (
        SELECT 1 FROM worktree_preparations WHERE path = ${thread.worktreePath ?? ""}
        AND phase IN ('allocated', 'checkout_created', 'setup_running', 'setup_failed', 'setup_indeterminate'))
      UNION ALL SELECT 'An attachment is still owned by another conversation or ingress.' WHERE EXISTS (
        SELECT 1 FROM attachments AS attachment JOIN attachment_owners AS owner USING (attachment_id)
        WHERE attachment.thread_id = ${thread.threadId} AND (
          owner.owner_kind = 'ingress'
          OR (owner.owner_kind = 'message' AND EXISTS (SELECT 1 FROM projection_thread_messages WHERE message_id = owner.owner_id AND thread_id <> ${thread.threadId}))
          OR (owner.owner_kind = 'activity' AND EXISTS (SELECT 1 FROM projection_thread_activities WHERE activity_id = owner.owner_id AND thread_id <> ${thread.threadId}))
          OR (owner.owner_kind = 'queue_item' AND EXISTS (SELECT 1 FROM next_turn_queue WHERE item_id = owner.owner_id AND thread_id <> ${thread.threadId}))
          OR (owner.owner_kind = 'rewind_draft' AND EXISTS (SELECT 1 FROM rewind_operations WHERE operation_id = owner.owner_id AND thread_id <> ${thread.threadId}))
          OR (owner.owner_kind = 'user_input' AND EXISTS (SELECT 1 FROM projection_pending_user_inputs WHERE request_id = owner.owner_id AND thread_id <> ${thread.threadId}))
        ))
      UNION ALL SELECT 'Queued turn is being dispatched.'  WHERE EXISTS (
        SELECT 1 FROM next_turn_queue WHERE thread_id = ${thread.threadId} AND status = 'dispatching')
    `;
      return rows[0]?.reason;
    });

  const purgeDeletedThreads = (
    request: CleanupOperation,
    context?: StorageCleanupContext,
    input?: {
      readonly categoryId?: StorageCleanupCategoryId;
      readonly threadIds?: ReadonlyArray<ThreadId>;
      readonly warnings?: ReadonlyArray<StoragePathWarning>;
      readonly archivedBefore?: string;
    },
  ) =>
    Effect.gen(function* () {
      const categoryId = input?.categoryId ?? "purgeDeletedThreads";
      const warnings: StoragePathWarning[] = [...(input?.warnings ?? [])];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const snapshots = (yield* queryThreadRows()).filter(
        (thread) =>
          (input?.threadIds === undefined || input.threadIds.includes(thread.threadId)) &&
          (thread.deletedAt !== null ||
            (input?.archivedBefore !== undefined &&
              thread.archivedAt !== null &&
              thread.archivedAt <= input.archivedBefore)),
      );
      const listings = yield* Effect.tryPromise(() =>
        Promise.all([
          enumerateFiles(config.attachmentsDir),
          enumerateFiles(config.providerLogsDir),
        ]),
      );
      warnings.push(...listings.flatMap((listing) => listing.errors));
      if (warnings.length > 0 && listings.some((listing) => listing.errors.length > 0))
        return resultFor({
          categoryId,
          status: "Failed",
          warnings,
          message: "Could not enumerate thread files; cleanup was not started.",
        });
      const segments = new Set(
        snapshots
          .map((thread) => toSafeThreadAttachmentSegment(thread.threadId))
          .filter((segment): segment is string => segment !== null),
      );
      const attachmentIndex = indexFilesBySegment(listings[0].files, segments, "attachments");
      const logIndex = indexFilesBySegment(listings[1].files, segments, "logs");
      let completedTargets = 0;
      for (const currentSnapshot of snapshots) {
        const reviewed = operationReviews
          .get(request.operationId)
          ?.threads.get(currentSnapshot.threadId);
        const snapshot = reviewed ?? currentSnapshot;
        if (checkCancelled(request.operationId)) break;
        yield* publishProgress(request, context, {
          categoryId,
          phase: "purging",
          message: `Purging ${snapshot.title}`,
          completedTargets,
          totalTargets: snapshots.length,
        });
        let crossedBoundary = false;
        let fsReclaimed = 0;
        const outcome = yield* Effect.exit(
          withProviderThreadAccess(
            snapshot.threadId,
            Effect.gen(function* () {
              if (checkCancelled(request.operationId)) return false;
              const thread = (yield* queryThreadRows()).find(
                (row) => row.threadId === snapshot.threadId,
              );
              if (
                !thread ||
                thread.archivedAt !== snapshot.archivedAt ||
                thread.deletedAt !== snapshot.deletedAt
              ) {
                warnings.push(
                  warningFor(
                    snapshot.threadId,
                    "Thread was removed or its archive/deletion time changed since review.",
                  ),
                );
                return false;
              }
              const segment = toSafeThreadAttachmentSegment(thread.threadId);
              const busy = yield* readBusyThreadSegments([thread]);
              if (segment && busy.has(segment)) {
                warnings.push(
                  warningFor(
                    thread.threadId,
                    "Skipped thread because its provider session is currently busy.",
                  ),
                );
                return false;
              }
              const block = yield* purgeBlockReason(thread);
              if (block) {
                warnings.push(warningFor(thread.threadId, block));
                return false;
              }
              const activeTerminals = (yield* terminals.listSessions).filter(
                (terminal) =>
                  terminal.threadId === thread.threadId &&
                  (terminal.status === "running" || terminal.status === "starting"),
              );
              if (thread.deletedAt === null && activeTerminals.length) {
                warnings.push(
                  warningFor(thread.threadId, "Skipped archived thread with an active terminal."),
                );
                return false;
              }
              yield* providerService.stopSession({ threadId: thread.threadId });
              if (activeTerminals.length) yield* terminals.close({ threadId: thread.threadId });
              if (
                (yield* terminals.listSessions).some(
                  (terminal) =>
                    terminal.threadId === thread.threadId &&
                    (terminal.status === "running" || terminal.status === "starting"),
                )
              ) {
                warnings.push(
                  warningFor(thread.threadId, "Terminal did not stop; cleanup was not started."),
                );
                return false;
              }
              const checkpointRows = yield* sql<{
                checkpointRef: CheckpointRef;
              }>`SELECT DISTINCT checkpoint_ref AS "checkpointRef" FROM projection_turns WHERE thread_id = ${thread.threadId} AND checkpoint_ref IS NOT NULL`;
              let cwd: string | undefined;
              let expectedOids: Readonly<Record<string, string>> = {};
              let selectedRepository: string | undefined;
              const refs = checkpointRows.map((row) => row.checkpointRef);
              for (const path of new Set([thread.worktreePath, thread.workspaceRoot])) {
                if (!refs.length || !path || !(yield* Effect.promise(() => exists(path)))) continue;
                if (!(yield* checkpointStore.isGitRepository(path))) continue;
                const found = yield* checkpointStore.readCheckpointRefs({
                  cwd: path,
                  checkpointRefs: refs,
                });
                if (!Object.keys(found).length) continue;
                const repository = yield* git.resolveCommonDir(path);
                if (!cwd) {
                  cwd = path;
                  expectedOids = found;
                  selectedRepository = repository;
                } else if (repository !== selectedRepository) {
                  warnings.push(
                    warningFor(
                      thread.threadId,
                      "Checkpoint refs also exist at another recorded repository; those copies are not removed.",
                    ),
                  );
                }
              }
              if (checkpointRows.length && !cwd)
                warnings.push(
                  warningFor(
                    thread.threadId,
                    "Checkpoint refs were not found at the recorded workspace paths; copies in a moved repository are not removed.",
                  ),
                );
              if (checkCancelled(request.operationId)) return false;
              // Archived targets remain visible until every non-destructive preflight has passed.
              if (thread.deletedAt === null) {
                yield* engine.dispatch({
                  type: "thread.delete",
                  commandId: CommandId.makeUnsafe(
                    `server:storage-archived-delete:${Crypto.randomUUID()}`,
                  ),
                  threadId: thread.threadId,
                  expectedArchivedAt: thread.archivedAt!,
                });
                crossedBoundary = true;
                markStorageMutation(request.operationId);
              }
              // thread.delete validates ownership atomically; deleted threads cannot
              // acquire a new workflow owner while files are being removed.
              const retainedReason = yield* purgeBlockReason(thread);
              if (retainedReason) {
                warnings.push(warningFor(thread.threadId, retainedReason));
                return false;
              }
              if (cwd) {
                crossedBoundary = true;
                markStorageMutation(request.operationId);
                yield* checkpointStore.deleteCheckpointRefs({
                  cwd,
                  checkpointRefs: checkpointRows
                    .filter((row) => expectedOids[row.checkpointRef] !== undefined)
                    .map((row) => row.checkpointRef),
                  expectedOids,
                });
                const remaining = yield* checkpointStore.readCheckpointRefs({
                  cwd,
                  checkpointRefs: refs,
                });
                if (Object.keys(remaining).length)
                  return yield* new StorageMaintenanceError({
                    operation: "purge",
                    message: "Checkpoint ref remained after deletion.",
                  });
              }
              return yield* withAttachmentRetentionLease(
                config.attachmentsDir,
                Effect.gen(function* () {
                  if (!crossedBoundary && checkCancelled(request.operationId)) return false;
                  const attachmentBlock = yield* purgeBlockReason(thread);
                  if (attachmentBlock) {
                    warnings.push(warningFor(thread.threadId, attachmentBlock));
                    return false;
                  }
                  const registry = yield* sql<{
                    finalPath: string;
                  }>`SELECT final_path AS "finalPath" FROM attachments WHERE thread_id = ${thread.threadId}`;
                  const registeredPaths = new Set(registry.map((row) => row.finalPath));
                  const survivors = (yield* queryThreadRows()).filter(
                    (row) => row.threadId !== thread.threadId,
                  );
                  const sharedSegment =
                    segment &&
                    survivors.some(
                      (row) => toSafeThreadAttachmentSegment(row.threadId) === segment,
                    );
                  const files = new Map<string, { root: string; file?: EnumeratedFile }>();
                  for (const row of registry) {
                    const shared =
                      yield* sql`SELECT 1 FROM attachments WHERE final_path = ${row.finalPath} AND thread_id <> ${thread.threadId} LIMIT 1`;
                    if (!shared.length) files.set(row.finalPath, { root: config.attachmentsDir });
                  }
                  if (segment && !sharedSegment) {
                    for (const file of attachmentIndex.get(segment) ?? []) {
                      const id = parseAttachmentIdFromRelativePath(file.name);
                      if (
                        id &&
                        parseThreadSegmentFromAttachmentId(id) === segment &&
                        !registeredPaths.has(file.path)
                      )
                        files.set(file.path, { root: config.attachmentsDir, file });
                    }
                    for (const file of logIndex.get(segment) ?? [])
                      if (providerLogSegmentFromName(file.name) === segment)
                        files.set(file.path, { root: config.providerLogsDir, file });
                  }
                  if (!crossedBoundary && checkCancelled(request.operationId)) return false;
                  crossedBoundary = true;
                  for (const [path, entry] of files) {
                    const removal = yield* Effect.promise(() =>
                      removeFileIfSafe({
                        path,
                        allowedRoot: entry.root,
                        expectedIdentity: reviewIdentity(
                          request.operationId,
                          path,
                          entry.file?.identity,
                        ),
                      }),
                    );
                    if (removal.kind === "refused" || removal.kind === "failed")
                      return yield* new StorageMaintenanceError({
                        operation: "purge.files",
                        message: removal.warning.reason,
                      });
                    if (removal.kind === "removed") markStorageMutation(request.operationId);
                    fsReclaimed += removal.reclaimedBytes;
                  }
                  const remainingSessions = yield* providerService.listSessions();
                  if (
                    remainingSessions.some(
                      (session) =>
                        session.threadId === thread.threadId && session.status !== "closed",
                    )
                  )
                    return yield* new StorageMaintenanceError({
                      operation: "purge.recheck",
                      message: "Provider session remained active after stop.",
                    });
                  return yield* Effect.gen(function* () {
                    const purgeGate = yield* engine.acquireMaintenanceLock();
                    yield* Effect.addFinalizer(() => Scope.close(purgeGate, Exit.void));
                    const finalBlock = yield* purgeBlockReason(thread);
                    if (
                      (yield* terminals.listSessions).some(
                        (terminal) =>
                          terminal.threadId === thread.threadId &&
                          (terminal.status === "running" || terminal.status === "starting"),
                      )
                    )
                      return yield* new StorageMaintenanceError({
                        operation: "purge.recheck",
                        message: "A terminal became active during cleanup.",
                      });
                    if (
                      finalBlock ||
                      (segment && (yield* readBusyThreadSegments([thread])).has(segment))
                    )
                      return yield* new StorageMaintenanceError({
                        operation: "purge.recheck",
                        message: finalBlock ?? "Provider became busy.",
                      });
                    const transactionExit = yield* Effect.exit(
                      sql.withTransaction(
                        Effect.gen(function* () {
                          const commandIds = yield* eventStore.collectCommandIdsForThread(
                            thread.threadId,
                          );
                          yield* purgeThreadRows(sql, thread.threadId, nowIso(), commandIds);
                        }),
                      ),
                    );

                    if (Exit.isFailure(transactionExit))
                      return yield* Effect.failCause(transactionExit.cause);
                    markStorageMutation(request.operationId);
                    return true;
                  }).pipe(Effect.scoped);
                }),
              );
            }).pipe(Effect.scoped),
          ),
        );
        if (Exit.isFailure(outcome)) {
          yield* Effect.logWarning("Storage thread purge failed", {
            cause: Cause.pretty(outcome.cause),
          });
          warnings.push(
            warningFor(
              snapshot.threadId,
              `${crossedBoundary ? "Deleted, cleanup incomplete" : "Skipped"}: ${storageCauseMessage(outcome.cause)}`,
            ),
          );
        }
        perTargetReclaimed.push({
          id: snapshot.threadId,
          reclaimedBytes: fsReclaimed,
          status:
            Exit.isSuccess(outcome) && outcome.value
              ? "Removed"
              : crossedBoundary
                ? "Deleted, cleanup incomplete"
                : "Skipped",
        });
        completedTargets++;
      }
      return resultFor({
        categoryId,
        status: perTargetReclaimed.some((target) => target.status === "Removed")
          ? "Cleaned"
          : warnings.length
            ? "Failed"
            : "Skipped",
        reclaimedBytes: perTargetReclaimed.reduce(
          (total, entry) => total + entry.reclaimedBytes,
          0,
        ),
        perTargetReclaimed,
        warnings,
      });
    });

  const pruneProviderLogsForTerminalThreads = (
    request: CleanupInput,
    context?: StorageCleanupContext,
    selectedTargetIds?: ReadonlySet<string>,
  ) =>
    Effect.gen(function* () {
      const allThreads = yield* queryThreadRows();
      const candidates = yield* computeProviderLogCandidates(allThreads);
      return yield* deleteProviderLogFiles(
        request,
        context,
        "providerLogsForTerminalThreads",
        selectedTargetIds
          ? candidates.files.filter((file) => selectedTargetIds.has(file.path))
          : candidates.files,
      );
    });

  const pruneEventsLogRotations = (
    request: CleanupInput,
    context?: StorageCleanupContext,
    selectedTargetIds?: ReadonlySet<string>,
  ) =>
    Effect.gen(function* () {
      const candidates = yield* computeEventsLogRotationCandidates();
      return yield* deleteProviderLogFiles(
        request,
        context,
        "providerLogRotations",
        selectedTargetIds
          ? candidates.files.filter((file) => selectedTargetIds.has(file.path))
          : candidates.files,
      );
    });

  /**
   * Remove the leftovers the confirmed scan listed that are still leftovers
   * now (the age guard is re-applied), so nothing newer than the scan goes.
   */
  const cleanCodexMarketplaceStaging = (
    request: CleanupInput,
    context: StorageCleanupContext | undefined,
    category: StorageCleanupCategoryUsage | undefined,
  ) =>
    Effect.gen(function* () {
      const confirmed = new Set(category?.targets.map((target) => target.id) ?? []);
      const current = (yield* computeCodexMarketplaceLeftovers()) ?? [];
      const leftovers = current.filter(({ leftover }) => confirmed.has(leftover.path));
      return yield* Effect.tryPromise({
        try: async () => {
          const warnings: StoragePathWarning[] = [];
          const perTargetReclaimed: PerTargetReclaimed = [];
          let completedTargets = 0;
          for (const { leftover } of leftovers) {
            if (checkCancelled(request.operationId)) break;
            await Effect.runPromise(
              publishProgress(request, context, {
                categoryId: "codexMarketplaceStaging",
                phase: "deleting",
                message: `Deleting ${Path.basename(leftover.path)}`,
                completedTargets,
                totalTargets: leftovers.length,
              }),
            );
            const removal = await removeCodexMarketplaceLeftover(
              leftover,
              reviewIdentity(request.operationId, leftover.path),
              () => checkCancelled(request.operationId),
            );
            if (removal.kind === "removed") markStorageMutation(request.operationId);
            if (removal.warning) warnings.push(removal.warning);
            if (removal.kind === "removed" || removal.kind === "absent") {
              perTargetReclaimed.push({
                id: leftover.path,
                path: leftover.path,
                reclaimedBytes: removal.reclaimedBytes,
              });
            }
            completedTargets += 1;
          }
          return resultFor({
            categoryId: "codexMarketplaceStaging",
            status: perTargetReclaimed.length > 0 ? "Cleaned" : "Skipped",
            reclaimedBytes: perTargetReclaimed.reduce(
              (total, target) => total + target.reclaimedBytes,
              0,
            ),
            perTargetReclaimed,
            warnings,
          });
        },
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.codexMarketplaceStaging",
            message: "Failed to delete Codex marketplace staging directories.",
            cause,
          }),
      });
    });

  type StorageWorktreeRemoval =
    | { readonly kind: "skipped"; readonly warnings: ReadonlyArray<StoragePathWarning> }
    | {
        readonly kind: "removed";
        readonly warnings: ReadonlyArray<StoragePathWarning>;
        readonly bytes: number;
        readonly branch: "deleted" | "kept" | undefined;
      };

  /**
   * Remove one storage-cleanup worktree. The reference re-check and the
   * removal run under the worktree lifecycle lock, so a send, terminal open or
   * recreation that claims the path meanwhile is seen before anything is
   * removed. Without a scan review (automatic runs) the checks made under the
   * lock are the review.
   */
  const removeStorageWorktree = (input: {
    readonly operationId: string;
    readonly targetPath: string;
    readonly kind: "storageMaintenance" | "externalCleanup";
    /** External worktrees: the project checkout recorded at review. */
    readonly commandCwd?: string;
  }): Effect.Effect<StorageWorktreeRemoval, StorageMaintenanceError> =>
    Effect.gen(function* () {
      const { operationId, targetPath } = input;
      const operationLabel =
        input.kind === "externalCleanup" ? "externalWorktrees" : "inactiveF5Worktrees";
      const before = yield* Effect.tryPromise({
        try: () => recursiveSize(targetPath),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: `StorageMaintenance.cleanup.${operationLabel}.size`,
            message: "Failed to size the worktree before deletion.",
            cause,
          }),
      });
      const claims = yield* readWorktreeClaims(targetPath).pipe(
        Effect.provideServices(removalServices),
      );
      const stopped = yield* stopDeletedWorktreeClaims(claims.deletedThreadIds).pipe(
        Effect.provideServices(removalServices),
        Effect.exit,
      );
      if (Exit.isFailure(stopped))
        return {
          kind: "skipped",
          warnings: [
            warningFor(
              targetPath,
              `Could not stop deleted conversation processes: ${storageCauseMessage(stopped.cause)}`,
            ),
          ],
        };
      let branch: "deleted" | "kept" | undefined;
      return yield* withWorktreeLifecycleLock(
        targetPath,
        Effect.gen(function* () {
          if (checkCancelled(operationId)) return { kind: "skipped" as const, warnings: [] };
          if (input.kind === "storageMaintenance") {
            const reviewedPath = yield* Effect.promise(() =>
              validateDeletablePath({
                path: targetPath,
                allowedRoot: config.worktreesDir,
                expectedIdentity: reviewIdentity(operationId, targetPath),
                directoryIdentityOnly: true,
              }),
            );
            if (reviewedPath.kind !== "validated")
              return {
                kind: "skipped" as const,
                warnings: reviewedPath.warning ? [reviewedPath.warning] : [],
              };
          }
          const reviewed = operationReviews.get(operationId)?.worktrees.get(targetPath);
          if (input.kind === "externalCleanup" && !reviewed)
            return {
              kind: "skipped" as const,
              warnings: [warningFor(targetPath, "Rescan to review this worktree before removal.")],
            };
          const readiness = yield* inspectWorktreeRemovalReadiness({
            targetPath,
            metadataOperation: `StorageMaintenance.cleanup.${operationLabel}.cwd`,
            metadataDisabledReason: GIT_WORKTREE_METADATA_UNRESOLVED,
            policy: { kind: input.kind, ownThreadId: null },
            ...(input.commandCwd ? { commandCwd: input.commandCwd } : {}),
            // Fresh under the lock, so a settings change since the scan applies.
            disposablePaths: yield* makeDisposablePathsLookup,
          });
          if (readiness.disabledReason || !readiness.commandCwd)
            return {
              kind: "skipped" as const,
              warnings: [
                ...readiness.warnings,
                warningFor(
                  targetPath,
                  readiness.disabledReason ?? GIT_WORKTREE_METADATA_UNRESOLVED,
                ),
              ],
            };
          if (reviewed && canonicalJsonHash(readiness.review) !== canonicalJsonHash(reviewed))
            return {
              kind: "skipped" as const,
              warnings: [
                warningFor(
                  targetPath,
                  "Worktree repository, registration, HEAD, or local changes changed since review. Rescan to retry.",
                ),
              ],
            };
          const review = reviewed ?? readiness.review;
          const commandCwd = readiness.commandCwd;
          const removeExit = yield* Effect.exit(
            removeWorktreeSafely({
              projectCwd: commandCwd,
              path: targetPath,
              policy: readiness.policy ?? { kind: input.kind, ownThreadId: null },
              expectedRootIdentity: reviewIdentity(operationId, targetPath),
              isCancelled: () => checkCancelled(operationId),
              ...(review ? { expectedHead: review.head } : {}),
              expectedDiscardChanges: review?.discardChanges,
              afterRemoval: () =>
                deleteMergedBranch({
                  cwd: commandCwd,
                  review,
                  // Re-evaluated under the lock just now, not taken from the scan.
                  branchDeletable: readiness.branchDeletable === true,
                  referencedByThreads: claims.threadIds.length > 0,
                }).pipe(
                  Effect.map((outcome) => {
                    branch = outcome;
                  }),
                ),
            }).pipe(
              Effect.provideServices(removalServices),
              Effect.flatMap((result) =>
                result.blockedReasons.length
                  ? Effect.fail(new Error(result.blockedReasons.join("; ")))
                  : Effect.void,
              ),
            ),
          );
          if (Exit.isFailure(removeExit))
            return {
              kind: "skipped" as const,
              warnings: [
                ...readiness.warnings,
                warningFor(
                  targetPath,
                  `git worktree remove failed: ${storageCauseMessage(removeExit.cause)}`,
                ),
              ],
            };
          return {
            kind: "removed" as const,
            warnings: readiness.warnings,
            bytes: before.bytes,
            branch,
          };
        }),
      ).pipe(
        Effect.catchTag("RepositoryLifecycleError", (error) =>
          Effect.succeed({
            kind: "skipped" as const,
            warnings: [warningFor(targetPath, error.message)],
          }),
        ),
      );
    });

  /** Remove reviewed external worktrees, revalidating identity, claims and cancellation. */
  const cleanExternalWorktrees = (
    request: CleanupInput,
    context: StorageCleanupContext | undefined,
    selectedTargetIds: ReadonlySet<string> | undefined,
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const reviews = operationReviews.get(request.operationId)?.worktrees;
      const targetPaths = [...(selectedTargetIds ?? [])];
      let completedTargets = 0;
      for (const targetPath of targetPaths) {
        if (checkCancelled(request.operationId)) break;
        yield* publishProgress(request, context, {
          categoryId: "externalWorktrees",
          phase: "deleting",
          message: `Deleting ${homeRelative(targetPath)}`,
          completedTargets,
          totalTargets: targetPaths.length,
        });
        completedTargets += 1;
        const projectRoot = reviews?.get(targetPath)?.projectRoot;
        if (!projectRoot) {
          warnings.push(warningFor(targetPath, "Rescan to review this worktree before removal."));
          continue;
        }
        const targetStat = yield* Effect.tryPromise(() => safeLstat(targetPath)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
          warnings.push(
            warningFor(
              targetPath,
              "Refused to remove a missing, symlinked, or non-directory worktree.",
            ),
          );
          continue;
        }
        const outcome = yield* removeStorageWorktree({
          operationId: request.operationId,
          targetPath,
          kind: "externalCleanup",
          commandCwd: projectRoot,
        });
        warnings.push(...outcome.warnings);
        if (outcome.kind === "skipped") continue;
        markStorageMutation(request.operationId);
        perTargetReclaimed.push({
          id: targetPath,
          path: targetPath,
          reclaimedBytes: outcome.bytes,
          status: "Removed",
          ...(outcome.branch ? { branch: outcome.branch } : {}),
        });
      }
      return resultFor({
        categoryId: "externalWorktrees",
        status:
          perTargetReclaimed.length > 0 ? "Cleaned" : warnings.length > 0 ? "Failed" : "Skipped",
        reclaimedBytes: perTargetReclaimed.reduce(
          (total, target) => total + target.reclaimedBytes,
          0,
        ),
        perTargetReclaimed,
        warnings,
        ...(targetPaths.length === 0
          ? { message: "No selected external worktrees were found." }
          : {}),
      });
    });

  /** Missing worktree folders that were inside the F5 worktrees folder. */
  const isManagedWorktreePath = (path: string) =>
    Effect.gen(function* () {
      const managedRoot = yield* canonicalOrNull(config.worktreesDir);
      const resolved = Path.resolve(path);
      return (
        pathContains(Path.resolve(config.worktreesDir), resolved) ||
        (managedRoot !== null && pathContains(managedRoot, resolved))
      );
    });

  /**
   * Forget registrations whose folder is still missing, one at a time.
   * `managedOnly` (the hourly run) leaves entries outside the F5 worktrees
   * folder alone: an unmounted disk must not lose its checkout's registration.
   */
  const clearStaleRegistrations = (
    request: CleanupOperation,
    context: StorageCleanupContext | undefined,
    selectedTargetIds: ReadonlySet<string> | undefined,
    options?: { readonly managedOnly?: boolean },
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const candidates = yield* computeStaleRegistrationTargets();
      warnings.push(...candidates.warnings);
      const targets = yield* Effect.filter(candidates.targets, (target) =>
        selectedTargetIds !== undefined && !selectedTargetIds.has(target.id)
          ? Effect.succeed(false)
          : options?.managedOnly
            ? isManagedWorktreePath(target.id)
            : Effect.succeed(true),
      );
      let completedTargets = 0;
      for (const target of targets) {
        if (checkCancelled(request.operationId)) break;
        yield* publishProgress(request, context, {
          categoryId: "staleWorktreeRegistrations",
          phase: "deleting",
          message: `Pruning ${target.label}`,
          completedTargets,
          totalTargets: targets.length,
        });
        completedTargets += 1;
        if (!target.safeToDelete) {
          warnings.push(warningFor(target.id, target.disabledReason ?? "Target is not safe."));
          continue;
        }
        // Re-checks under the repository lock that the folder is still missing.
        const cleared = yield* git
          .clearMissingRegistration(target.projectRoot, target.id)
          .pipe(Effect.exit);
        if (Exit.isFailure(cleared)) {
          warnings.push(warningFor(target.id, storageCauseMessage(cleared.cause)));
          continue;
        }
        markStorageMutation(request.operationId);
        perTargetReclaimed.push({
          id: target.id,
          path: target.id,
          reclaimedBytes: 0,
          status: "Removed",
        });
      }
      return resultFor({
        categoryId: "staleWorktreeRegistrations",
        status:
          perTargetReclaimed.length > 0 ? "Cleaned" : warnings.length > 0 ? "Failed" : "Skipped",
        perTargetReclaimed,
        warnings,
        ...(targets.length === 0 ? { message: "No missing worktree entries were found." } : {}),
      });
    });

  /** Remove reviewed checkouts after revalidating identity, claims and cancellation. */
  const cleanF5Worktrees = (
    request: CleanupOperation,
    context: StorageCleanupContext | undefined,
    selectedTargetIds: ReadonlySet<string> | undefined,
    preflightWarnings: ReadonlyArray<StoragePathWarning>,
    /** Automatic runs: act on every eligible target and skip blocked ones silently. */
    options?: { readonly eligibleOnly?: boolean },
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [...preflightWarnings];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const candidates = yield* computeF5WorktreeTargets(undefined, { skipSizing: true });
      warnings.push(...candidates.warnings);
      const targets =
        selectedTargetIds !== undefined
          ? candidates.targets.filter((target) => selectedTargetIds.has(target.id))
          : options?.eligibleOnly
            ? candidates.targets.filter((target) => target.safeToDelete)
            : candidates.targets;
      if (targets.length === 0) {
        return resultFor({
          categoryId: "inactiveF5Worktrees",
          status: "Skipped",
          warnings,
          message: "No selected F5 worktrees were found.",
        });
      }

      let completedTargets = 0;
      for (const target of targets) {
        if (checkCancelled(request.operationId)) {
          break;
        }
        const targetPath = target.path;
        yield* publishProgress(request, context, {
          categoryId: "inactiveF5Worktrees",
          phase: "deleting",
          message: `Deleting ${target.label}`,
          completedTargets,
          totalTargets: targets.length,
        });

        if (!target.safeToDelete || !targetPath) {
          warnings.push(
            warningFor(
              targetPath ?? target.id,
              target.disabledReason ?? "Target is not safe to delete.",
            ),
          );
          completedTargets += 1;
          continue;
        }
        if (Path.resolve(targetPath) === Path.resolve(config.worktreesDir)) {
          warnings.push(
            warningFor(targetPath, "Refused to delete the configured F5 worktrees root."),
          );
          completedTargets += 1;
          continue;
        }
        if (!isPathWithinRoot({ root: config.worktreesDir, target: targetPath })) {
          warnings.push(warningFor(targetPath, "Target is outside the F5 worktrees root."));
          completedTargets += 1;
          continue;
        }
        const targetStat = yield* Effect.tryPromise({
          try: () => safeLstat(targetPath),
          catch: (cause) =>
            new StorageMaintenanceError({
              operation: "StorageMaintenance.cleanup.inactiveF5Worktrees.lstat",
              message: "Failed to inspect F5 worktree before deletion.",
              cause,
            }),
        });
        if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
          warnings.push(
            warningFor(
              targetPath,
              "Refused to remove a missing, symlinked, or non-directory worktree.",
            ),
          );
          completedTargets += 1;
          continue;
        }

        const outcome = yield* removeStorageWorktree({
          operationId: request.operationId,
          targetPath,
          kind: "storageMaintenance",
        });
        warnings.push(...outcome.warnings);
        if (outcome.kind === "skipped") {
          completedTargets += 1;
          continue;
        }

        markStorageMutation(request.operationId);
        perTargetReclaimed.push({
          id: target.id,
          path: targetPath,
          reclaimedBytes: outcome.bytes,
          status: "Removed",
          ...(outcome.branch ? { branch: outcome.branch } : {}),
        });
        completedTargets += 1;
      }

      return resultFor({
        categoryId: "inactiveF5Worktrees",
        status:
          perTargetReclaimed.length > 0 ? "Cleaned" : warnings.length > 0 ? "Failed" : "Skipped",
        reclaimedBytes: perTargetReclaimed.reduce(
          (total, target) => total + target.reclaimedBytes,
          0,
        ),
        perTargetReclaimed,
        warnings,
      });
    });

  const cleanOrphanAttachments = (
    request: CleanupInput,
    context: StorageCleanupContext | undefined,
    selectedTargetIds: ReadonlySet<string> | undefined,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<OrphanAttachmentRow>`
        SELECT
          attachment.attachment_id AS "attachmentId",
          attachment.name AS "name",
          attachment.final_path AS "finalPath",
          attachment.lifecycle AS lifecycle, cleanup.last_error AS "lastError"
        FROM attachments AS attachment
        LEFT JOIN attachment_cleanup_jobs AS cleanup USING (attachment_id)
        WHERE attachment.lifecycle IN ('ready', 'deleting') AND NOT EXISTS (
          SELECT 1
          FROM attachment_owners AS owner
          WHERE owner.attachment_id = attachment.attachment_id
        )
        ORDER BY attachment.created_at ASC
      `;
      const candidates =
        selectedTargetIds !== undefined
          ? rows.filter((row) => selectedTargetIds.has(row.attachmentId))
          : rows;
      if (candidates.length === 0) {
        return resultFor({
          categoryId: "orphanAttachments",
          status: "Skipped",
          message: "No orphaned attachments were found.",
        });
      }

      const warnings: StoragePathWarning[] = [];
      const perTargetReclaimed: PerTargetReclaimed = [];
      let completedTargets = 0;
      for (const attachment of candidates) {
        if (checkCancelled(request.operationId)) break;
        yield* publishProgress(request, context, {
          categoryId: "orphanAttachments",
          phase: "deleting",
          message: `Deleting ${attachment.name}`,
          completedTargets,
          totalTargets: candidates.length,
        });
        if (!isPathWithinRoot({ root: config.attachmentsDir, target: attachment.finalPath })) {
          warnings.push(
            warningFor(
              attachment.finalPath,
              "Skipped attachment because its path is outside the attachment storage root.",
            ),
          );
          completedTargets += 1;
          continue;
        }

        const marked = yield* sql.withTransaction(
          Effect.gen(function* () {
            // Cancellation before the lifecycle boundary must not reserve an
            // otherwise usable content-addressed attachment id.
            if (checkCancelled(request.operationId)) return false;
            const updated = yield* sql<OrphanAttachmentRow>`
              UPDATE attachments
              SET lifecycle = 'deleting', updated_at = ${nowIso()}
              WHERE attachment_id = ${attachment.attachmentId}
                AND NOT EXISTS (
                  SELECT 1
                  FROM attachment_owners AS owner
                  WHERE owner.attachment_id = attachments.attachment_id
                )
              RETURNING
                attachment_id AS "attachmentId", name, final_path AS "finalPath"
            `;
            if (!updated[0]) return false;
            const at = nowIso();
            yield* sql`
              INSERT INTO attachment_cleanup_jobs (
                attachment_id, path, attempt, created_at, updated_at
              ) VALUES (${attachment.attachmentId}, ${attachment.finalPath}, 0, ${at}, ${at})
              ON CONFLICT(attachment_id) DO UPDATE SET
                path = excluded.path,
                updated_at = excluded.updated_at
            `;
            return true;
          }),
        );
        if (!marked) {
          if (checkCancelled(request.operationId)) break;
          warnings.push(
            warningFor(
              attachment.finalPath,
              "Skipped attachment because it gained a live owner during cleanup.",
            ),
          );
          completedTargets += 1;
          continue;
        }

        markStorageMutation(request.operationId);
        const deletion = yield* Effect.exit(
          Effect.tryPromise({
            try: () =>
              removeFileIfSafe({
                path: attachment.finalPath,
                allowedRoot: config.attachmentsDir,
                expectedIdentity: reviewIdentity(request.operationId, attachment.finalPath),
                // Once marked, finish this attachment even if cancelled. A
                // refusal/failure keeps deleting + the retry job; it cannot be
                // resurrected without proving the bytes are safe to reference.
              }),
            catch: (cause) =>
              new StorageMaintenanceError({
                operation: "StorageMaintenance.cleanup.orphanAttachments.delete",
                message: "Failed to delete an orphaned attachment.",
                cause,
              }),
          }),
        );
        if (Exit.isFailure(deletion)) {
          yield* Effect.logWarning("Orphan attachment cleanup failed", {
            cause: Cause.pretty(deletion.cause),
          });
          warnings.push(warningFor(attachment.finalPath, storageCauseMessage(deletion.cause)));
          yield* sql`
            UPDATE attachment_cleanup_jobs
            SET attempt = attempt + 1, last_error = ${storageCauseMessage(deletion.cause)},
                updated_at = ${nowIso()}
            WHERE attachment_id = ${attachment.attachmentId}
          `;
          completedTargets += 1;
          continue;
        }
        if (deletion.value.warning) {
          warnings.push(deletion.value.warning);
          yield* sql`UPDATE attachment_cleanup_jobs SET attempt = attempt + 1,
            last_error = ${warningFor(attachment.finalPath, deletion.value.warning.reason).reason}, updated_at = ${nowIso()}
            WHERE attachment_id = ${attachment.attachmentId}`;
          completedTargets += 1;
          continue;
        }
        yield* sql`
          DELETE FROM attachments
          WHERE attachment_id = ${attachment.attachmentId}
            AND NOT EXISTS (
              SELECT 1
              FROM attachment_owners AS owner
              WHERE owner.attachment_id = attachments.attachment_id
            )
        `;
        perTargetReclaimed.push({
          id: attachment.attachmentId,
          path: attachment.finalPath,
          reclaimedBytes: deletion.value.reclaimedBytes,
        });
        completedTargets += 1;
      }

      return resultFor({
        categoryId: "orphanAttachments",
        status:
          perTargetReclaimed.length > 0 ? "Cleaned" : warnings.length > 0 ? "Failed" : "Skipped",
        reclaimedBytes: perTargetReclaimed.reduce(
          (total, target) => total + target.reclaimedBytes,
          0,
        ),
        perTargetReclaimed,
        warnings,
      });
    });

  const vacuumDatabase = (operationId?: string) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const beforeBytes = yield* Effect.tryPromise({
        try: () => databaseFileBytes(config.dbPath),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.databaseVacuum.stat",
            message: "Failed to stat database before compaction.",
            cause,
          }),
      });
      const statfs = yield* Effect.tryPromise({
        try: () => loadStatfs(),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.databaseVacuum.loadStatfs",
            message: "Failed to load filesystem free-space inspection.",
            cause,
          }),
      });
      if (!statfs) {
        return resultFor({
          categoryId: "databaseVacuum",
          status: "Failed",
          warnings: [warningFor(config.dbPath, "Filesystem free-space inspection is unavailable.")],
          message: "Filesystem free-space inspection is unavailable.",
        });
      }
      // VACUUM copies only live pages, so free pages need no room.
      const pages = yield* readPages;
      const shortfall = yield* Effect.tryPromise({
        try: () =>
          vacuumFreeSpaceShortfall({
            dbPath: config.dbPath,
            liveBytes: liveDatabaseBytes(pages),
            statfs,
          }),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.databaseVacuum.statfs",
            message: "Failed to inspect free disk space before database compaction.",
            cause,
          }),
      });
      if (shortfall !== null) {
        return resultFor({
          categoryId: "databaseVacuum",
          status: "Skipped",
          warnings: [warningFor(config.dbPath, `Skipped VACUUM because ${shortfall}.`)],
          message: "Not enough free disk space to compact the database.",
        });
      }
      yield* compactDatabase(operationId);
      const afterBytes = yield* Effect.tryPromise({
        try: () => databaseFileBytes(config.dbPath),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.databaseVacuum.statAfter",
            message: "Failed to stat database after compaction.",
            cause,
          }),
      });
      const reclaimedBytes = Math.max(0, beforeBytes - afterBytes);
      return resultFor({
        categoryId: "databaseVacuum",
        status: "Cleaned",
        reclaimedBytes,
        warnings,
      });
    });

  const cleanLegacyCategory = (
    request: CleanupInput,
    context: StorageCleanupContext | undefined,
    categoryId: LegacyCleanupCategoryId,
    selectedTargetIds?: ReadonlySet<string>,
  ) =>
    Effect.gen(function* () {
      const allThreads = yield* queryThreadRows();
      const liveWorktreePaths = new Set(
        allThreads
          .filter((thread) => isActiveStorageThread(thread) && thread.worktreePath !== null)
          .map((thread) => Path.resolve(thread.worktreePath!)),
      );
      const probe = yield* Effect.tryPromise({
        try: () => probeLegacyState({ config, liveWorktreePaths }),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: `StorageMaintenance.cleanup.${categoryId}.probe`,
            message: "Failed to inspect legacy state before cleanup.",
            cause,
          }),
      });
      const allTargets = probe.targetsByCategory[categoryId] ?? [];
      const targets =
        selectedTargetIds !== undefined
          ? allTargets.filter((target) => selectedTargetIds.has(target.id))
          : allTargets;
      if (targets.length === 0) {
        return resultFor({
          categoryId,
          status: "Skipped",
          message: "No targets found.",
        });
      }
      const warnings: StoragePathWarning[] = [];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const allowedRoot = legacyAllowedRootForCategory(categoryId);
      let completedTargets = 0;
      for (const target of targets) {
        if (checkCancelled(request.operationId)) {
          break;
        }
        const targetPath = target.path;
        yield* publishProgress(request, context, {
          categoryId,
          phase: "deleting",
          message: `Deleting ${target.label}`,
          completedTargets,
          totalTargets: targets.length,
        });
        if (!target.safeToDelete || !targetPath) {
          warnings.push(
            warningFor(
              targetPath ?? target.id,
              target.disabledReason ?? "Target is not safe to delete.",
            ),
          );
          completedTargets += 1;
          continue;
        }
        if (!isPathWithinRoot({ root: allowedRoot, target: targetPath })) {
          warnings.push(
            warningFor(targetPath, "Target is outside its allowed legacy cleanup root."),
          );
          completedTargets += 1;
          continue;
        }
        if (categoryId === "legacyT3Worktrees") {
          const targetStat = yield* Effect.tryPromise({
            try: () => safeLstat(targetPath),
            catch: (cause) =>
              new StorageMaintenanceError({
                operation: "StorageMaintenance.cleanup.legacyT3Worktrees.lstat",
                message: "Failed to inspect legacy worktree before deletion.",
                cause,
              }),
          });
          if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
            warnings.push(
              warningFor(
                targetPath,
                "Refused to remove a missing, symlinked, or non-directory worktree.",
              ),
            );
            completedTargets += 1;
            continue;
          }
          const readiness = yield* inspectWorktreeRemovalReadiness({
            targetPath,
            metadataOperation: "StorageMaintenance.cleanup.legacyT3Worktrees.cwd",
            metadataDisabledReason: GIT_WORKTREE_METADATA_UNRESOLVED,
          });
          warnings.push(...readiness.warnings);
          if (readiness.disabledReason || !readiness.commandCwd) {
            warnings.push(
              warningFor(targetPath, readiness.disabledReason ?? GIT_WORKTREE_METADATA_UNRESOLVED),
            );
            completedTargets += 1;
            continue;
          }
          const reviewed = operationReviews.get(request.operationId)?.worktrees.get(targetPath);
          const pathReview = yield* Effect.promise(() =>
            validateDeletablePath({
              path: targetPath,
              allowedRoot,
              expectedIdentity: reviewIdentity(request.operationId, targetPath),
              directoryIdentityOnly: true,
            }),
          );
          if (
            pathReview.kind !== "validated" ||
            (reviewed && canonicalJsonHash(readiness.review) !== canonicalJsonHash(reviewed))
          ) {
            warnings.push(
              warningFor(targetPath, "Worktree identity changed since review. Rescan to retry."),
            );
            completedTargets++;
            continue;
          }
          const before = yield* Effect.tryPromise({
            try: () => recursiveSize(targetPath),
            catch: (cause) =>
              new StorageMaintenanceError({
                operation: "StorageMaintenance.cleanup.legacyT3Worktrees.size",
                message: "Failed to size legacy worktree before deletion.",
                cause,
              }),
          });
          const commandCwd = readiness.commandCwd;
          if (!commandCwd) {
            warnings.push(warningFor(targetPath, GIT_WORKTREE_METADATA_UNRESOLVED));
            completedTargets += 1;
            continue;
          }
          const claims = yield* readWorktreeClaims(targetPath).pipe(
            Effect.provideServices(removalServices),
          );
          const stopped = yield* stopDeletedWorktreeClaims(claims.deletedThreadIds).pipe(
            Effect.provideServices(removalServices),
            Effect.exit,
          );
          if (Exit.isFailure(stopped)) {
            warnings.push(
              warningFor(
                targetPath,
                `Could not stop deleted conversation processes: ${storageCauseMessage(stopped.cause)}`,
              ),
            );
            completedTargets += 1;
            continue;
          }
          const exit = yield* Effect.exit(
            removeWorktreeSafely({
              projectCwd: commandCwd,
              path: targetPath,
              policy: { kind: "legacyCleanup", ownThreadId: null },
              expectedRootIdentity: reviewIdentity(request.operationId, targetPath),
              isCancelled: () => checkCancelled(request.operationId),
              ...(reviewed ? { expectedHead: reviewed.head } : {}),
            }).pipe(
              Effect.provideServices(removalServices),
              Effect.flatMap((result) =>
                result.blockedReasons.length
                  ? Effect.fail(new Error(result.blockedReasons.join("; ")))
                  : Effect.void,
              ),
            ),
          );
          if (Exit.isFailure(exit)) {
            warnings.push(
              warningFor(
                targetPath,
                `git worktree remove failed: ${storageCauseMessage(exit.cause)}`,
              ),
            );
            completedTargets += 1;
            continue;
          }
          markStorageMutation(request.operationId);
          perTargetReclaimed.push({
            id: target.id,
            path: targetPath,
            reclaimedBytes: before.bytes,
          });
          completedTargets += 1;
          continue;
        }

        const deletion = yield* Effect.tryPromise({
          try: () =>
            removeTreeIfSafe({
              path: targetPath,
              allowedRoot,
              expectedIdentity: reviewIdentity(request.operationId, targetPath),
              allowRoot: Path.resolve(targetPath) === Path.resolve(allowedRoot),
              recursive: categoryId !== "legacyT3Root",
              isCancelled: () => checkCancelled(request.operationId),
            }),
          catch: (cause) =>
            new StorageMaintenanceError({
              operation: `StorageMaintenance.cleanup.${categoryId}.delete`,
              message: "Failed to delete legacy storage target.",
              cause,
            }),
        });
        if (deletion.warning) {
          warnings.push(deletion.warning);
        } else {
          if (deletion.kind === "removed") markStorageMutation(request.operationId);
          perTargetReclaimed.push({
            id: target.id,
            path: targetPath,
            reclaimedBytes: deletion.kind === "removed" ? target.bytes : 0,
          });
        }
        completedTargets += 1;
      }

      return resultFor({
        categoryId,
        status:
          perTargetReclaimed.length > 0 ? "Cleaned" : warnings.length > 0 ? "Failed" : "Skipped",
        reclaimedBytes: perTargetReclaimed.reduce(
          (total, target) => total + target.reclaimedBytes,
          0,
        ),
        perTargetReclaimed,
        warnings,
      });
    });

  const cleanup = (
    request: CleanupInput,
    context?: StorageCleanupContext,
    prepared?: {
      categoryIds: ReadonlyArray<StorageCleanupCategoryId>;
      requestedCategories: ReadonlyArray<StorageCleanupCategoryUsage>;
      targetSelections: ReadonlyMap<StorageCleanupCategoryId, ReadonlySet<string>>;
    },
  ): Effect.Effect<StorageCleanupResult, StorageMaintenanceError> =>
    Effect.gen(function* () {
      const { categoryIds, requestedCategories, targetSelections } =
        prepared ?? (yield* validateCleanupRequest(request));
      if (!prepared) cancelledOperations.delete(request.operationId);
      cancellableOperations.add(request.operationId);
      const startedAt = nowIso();
      const requestedCategoryById = new Map(
        requestedCategories.map((category) => [category.id, category] as const),
      );
      const f5WorktreeReferenceWarnings: StoragePathWarning[] = [];

      return yield* Effect.gen(function* () {
        const results: StorageCleanupCategoryResult[] = [];
        let performedDeletes = false;

        for (const categoryId of categoryIds) {
          if (checkCancelled(request.operationId)) {
            break;
          }
          yield* publishProgress(request, context, {
            categoryId,
            phase: "starting",
            message: `Starting ${categoryId}`,
            completedTargets: 0,
            totalTargets: 1,
          });

          const result = yield* (() => {
            switch (categoryId) {
              case "purgeArchivedThreads":
                return purgeDeletedThreads(request, context, {
                  categoryId: "purgeArchivedThreads",
                  threadIds: (requestedCategoryById.get(categoryId)?.targets ?? []).map((target) =>
                    ThreadId.makeUnsafe(target.id),
                  ),
                  archivedBefore: new Date(Date.now() - ARCHIVED_THREAD_RETENTION_MS).toISOString(),
                });
              case "purgeDeletedThreads":
                return purgeDeletedThreads(request, context, {
                  threadIds: (requestedCategoryById.get(categoryId)?.targets ?? []).map((target) =>
                    ThreadId.makeUnsafe(target.id),
                  ),
                });
              case "inactiveF5Worktrees":
                return cleanF5Worktrees(
                  request,
                  context,
                  targetSelections.get(categoryId),
                  f5WorktreeReferenceWarnings,
                );
              case "externalWorktrees":
                return cleanExternalWorktrees(request, context, targetSelections.get(categoryId));
              case "staleWorktreeRegistrations":
                return clearStaleRegistrations(request, context, targetSelections.get(categoryId));
              case "providerLogsForTerminalThreads":
                return pruneProviderLogsForTerminalThreads(
                  request,
                  context,
                  targetSelections.get(categoryId),
                );
              case "providerLogRotations":
                return pruneEventsLogRotations(request, context, targetSelections.get(categoryId));
              case "orphanAttachments":
                return withAttachmentRetentionLease(
                  config.attachmentsDir,
                  cleanOrphanAttachments(request, context, targetSelections.get(categoryId)),
                );
              case "codexMarketplaceStaging":
                return cleanCodexMarketplaceStaging(
                  request,
                  context,
                  requestedCategoryById.get(categoryId),
                );
              case "databaseVacuum":
                return vacuumDatabase(request.operationId);
              case "legacyT3Userdata":
              case "legacyT3Diverged":
              case "legacyT3Worktrees":
              case "legacyT3Dev":
              case "legacyT3Caches":
              case "legacyT3Root":
              case "f5UserdataEmpty":
                return cleanLegacyCategory(
                  request,
                  context,
                  categoryId,
                  targetSelections.get(categoryId),
                );
            }
          })().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Storage cleanup category failed", {
                categoryId,
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.as(
                  resultFor({
                    categoryId,
                    status: "Failed",
                    warnings: [warningFor(categoryId, storageCauseMessage(cause))],
                    message: storageCauseMessage(cause),
                  }),
                ),
              ),
            ),
          );
          // Codex staging lives outside the database; removing it frees no pages.
          if (
            (categoryId.startsWith("purge") &&
              result.perTargetReclaimed.some((target) => target.status === "Removed")) ||
            (categoryId === "orphanAttachments" && result.perTargetReclaimed.length > 0)
          ) {
            performedDeletes = true;
          }
          results.push(result);
        }

        if (
          !checkCancelled(request.operationId) &&
          performedDeletes &&
          !categoryIds.includes("databaseVacuum") &&
          request.options?.vacuumAfterDeletes !== false
        ) {
          yield* publishProgress(request, context, {
            categoryId: "databaseVacuum",
            phase: "compacting",
            message: "Compacting database; conversations wait until this finishes.",
            completedTargets: 0,
            totalTargets: 1,
          });
          const vacuumResult = yield* vacuumDatabase(request.operationId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Storage post-delete compaction failed", {
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.as(
                  resultFor({
                    categoryId: "databaseVacuum",
                    status: checkCancelled(request.operationId) ? "Skipped" : "Failed",
                    warnings: [
                      warningFor(
                        config.dbPath,
                        checkCancelled(request.operationId)
                          ? "Database compaction was cancelled. Completed cleanup has been retained."
                          : storageCauseMessage(cause),
                      ),
                    ],
                  }),
                ),
              ),
            ),
          );
          results.push(vacuumResult);
        }

        if (
          checkCancelled(request.operationId) &&
          !results.some(
            (result) =>
              result.status === "Cleaned" ||
              result.reclaimedBytes > 0 ||
              result.perTargetReclaimed.some(
                (target) => target.status === "Deleted, cleanup incomplete",
              ),
          )
        )
          results.length = 0;
        let historyRecorded = true;
        for (const result of results) {
          const recorded = yield* recordStorageAutomationAudit({
            source: "manual",
            category: result.categoryId,
            operationId: request.operationId,
            job: result.categoryId.startsWith("purge")
              ? "thread-purge"
              : result.categoryId === "databaseVacuum"
                ? "database-vacuum"
                : result.categoryId === "codexMarketplaceStaging"
                  ? "codex-marketplace-staging"
                  : result.categoryId.startsWith("providerLog")
                    ? "provider-logs"
                    : "worktree-cleanup",
            target: requestedCategoryById.get(result.categoryId)?.title ?? result.categoryId,
            result:
              result.status === "Failed"
                ? "failed"
                : result.status === "Skipped"
                  ? "skipped"
                  : "removed",
            reasonCode: result.warnings.length ? "cleanup_incomplete" : "cleanup_completed",
            ...(result.warnings[0] ? { reason: result.warnings[0].reason } : {}),
            summary: {
              targetCount: result.perTargetReclaimed.length,
              reclaimedBytes: result.reclaimedBytes,
            },
          }).pipe(withSql);
          for (const warning of result.warnings.slice(0, 10)) {
            const detailRecorded = yield* recordStorageAutomationAudit({
              source: "manual",
              category: result.categoryId,
              operationId: request.operationId,
              job: result.categoryId.startsWith("purge")
                ? "thread-purge"
                : result.categoryId === "databaseVacuum"
                  ? "database-vacuum"
                  : "worktree-cleanup",
              target: isPathWithinRoot({ root: config.stateDir, target: warning.path })
                ? Path.relative(config.stateDir, warning.path)
                : Path.basename(warning.path),
              result: "failed",
              reasonCode: "cleanup_target_incomplete",
              reason: warning.reason,
            }).pipe(withSql);
            historyRecorded &&= detailRecorded;
          }
          historyRecorded &&= recorded;
        }
        yield* pruneStorageAutomationAudit.pipe(withSql);
        const warnings = results.flatMap((result) => result.warnings);
        if (!historyRecorded)
          warnings.push(
            warningFor("storage activity", "Cleanup finished, but history could not be recorded."),
          );
        const completedAt = nowIso();
        return {
          operationId: request.operationId,
          startedAt,
          completedAt,
          reclaimedBytes: results.reduce((total, result) => total + result.reclaimedBytes, 0),
          results,
          warnings,
          cancelled: checkCancelled(request.operationId),
        } satisfies StorageCleanupResult;
      }).pipe(
        Effect.ensuring(finishStorageMutation(request.operationId)),
        Effect.ensuring(
          Effect.sync(() => {
            cancelledOperations.delete(request.operationId);
            cancellableOperations.delete(request.operationId);
            operationReviews.delete(request.operationId);
          }),
        ),
      );
    }).pipe(Effect.mapError(toStorageMaintenanceError("StorageMaintenance.cleanup")));

  const cancel: StorageMaintenanceShape["cancel"] = (operationId) =>
    Effect.sync(() => {
      if (cancellableOperations.has(operationId)) {
        cancelledOperations.add(operationId);
        const record = operations.get(operationId);
        if (record && activeStates.has(record.status.state)) {
          record.status = { ...record.status, state: "cancelling" };
          cleanupStatus = record.status;
          operationRevision++;
        }
      }
    });

  const purgeThreads: StorageMaintenanceShape["purgeThreads"] = (input) =>
    Effect.gen(function* () {
      const allThreads = yield* queryThreadRows();
      const retained = yield* retainedWorkflowThreadIds();
      const busySegments = yield* readBusyThreadSegments(allThreads);
      const nowMs = Date.now();
      for (const [threadId, retryAtMs] of purgeRetryAtMs) {
        if (retryAtMs <= nowMs) purgeRetryAtMs.delete(threadId);
      }
      const { deletedBefore, archivedBefore } = input;
      const purgeable = (thread: ThreadRow) => {
        if (retained.has(thread.threadId)) return false;
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        return segment === null || !busySegments.has(segment);
      };
      // Threads that failed recently go last, then oldest first.
      const order = (at: (thread: ThreadRow) => string) => (left: ThreadRow, right: ThreadRow) =>
        Number(purgeRetryAtMs.has(left.threadId)) - Number(purgeRetryAtMs.has(right.threadId)) ||
        at(left).localeCompare(at(right));
      // Bound each pass; only the final per-thread row deletion takes the engine gate.
      const deleted = (
        deletedBefore === null
          ? []
          : allThreads.filter(
              (thread) =>
                thread.deletedAt !== null && thread.deletedAt <= deletedBefore && purgeable(thread),
            )
      )
        .toSorted(order((thread) => thread.deletedAt!))
        .slice(0, input.maxThreads);
      const archived = (
        archivedBefore === null
          ? []
          : allThreads.filter(
              (thread) =>
                thread.deletedAt === null &&
                thread.archivedAt !== null &&
                thread.archivedAt <= archivedBefore &&
                purgeable(thread),
            )
      )
        .toSorted(order((thread) => thread.archivedAt!))
        .slice(0, Math.max(0, input.maxThreads - deleted.length));
      if (deleted.length === 0 && archived.length === 0) {
        return { purgedThreadIds: [], archivedThreadIds: [], reclaimedBytes: 0, warnings: [] };
      }
      const operation = { operationId: input.operationId };
      const result = yield* purgeDeletedThreads(operation, undefined, {
        threadIds: [...deleted, ...archived].map((thread) => thread.threadId),
        ...(archivedBefore !== null ? { archivedBefore } : {}),
      }).pipe(Effect.ensuring(finishStorageMutation(input.operationId)));
      const purgedThreadIds = result.perTargetReclaimed
        .filter((target) => target.status === "Removed")
        .map((target) => ThreadId.makeUnsafe(target.id));
      const purged = new Set<string>(purgedThreadIds);
      for (const thread of [...deleted, ...archived]) {
        if (!purged.has(thread.threadId)) {
          purgeRetryAtMs.set(thread.threadId, Date.now() + PURGE_FAILURE_BACKOFF_MS);
        }
      }
      return {
        purgedThreadIds,
        archivedThreadIds: archived
          .filter((thread) => purged.has(thread.threadId))
          .map((thread) => thread.threadId),
        reclaimedBytes: result.reclaimedBytes,
        warnings: result.warnings,
      };
    }).pipe(Effect.mapError(toStorageMaintenanceError("StorageMaintenance.purgeThreads")));

  const reclaimDatabaseSpace: StorageMaintenanceShape["reclaimDatabaseSpace"] = (input) =>
    Effect.gen(function* () {
      const pages = yield* readPages;
      if (pages.autoVacuum === AUTO_VACUUM_INCREMENTAL) {
        const before = yield* Effect.promise(() => databaseFileBytes(config.dbPath));
        const released = yield* withSql(incrementalVacuum(input));
        const after = yield* Effect.promise(() => databaseFileBytes(config.dbPath));
        if (released > 0) yield* noteStorageMutated;
        return {
          action: released > 0 ? "incremental" : "none",
          reclaimedBytes: Math.max(0, before - after),
        } satisfies DatabaseSpaceResult;
      }
      const freeBytes = freeDatabaseBytes(pages);
      if (
        pages.autoVacuum !== 0 ||
        freeBytes < AUTO_CONVERT_MIN_FREE_BYTES ||
        freeBytes < pages.pageCount * pages.pageSize * AUTO_CONVERT_MIN_FREE_FRACTION
      ) {
        return { action: "none", reclaimedBytes: 0 } satisfies DatabaseSpaceResult;
      }
      const skipped = (skippedReason: string): DatabaseSpaceResult => ({
        action: "none",
        reclaimedBytes: 0,
        skippedReason,
      });
      const quietSince = new Date(Date.now() - AUTO_CONVERT_QUIET_MS).toISOString();
      const recent = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads
        WHERE deleted_at IS NULL AND last_interaction_at >= ${quietSince}
      `;
      if ((recent[0]?.count ?? 0) > 0) return skipped("a thread was used recently");
      const busy = yield* readBusyThreadSegments(yield* queryThreadRows());
      if (busy.size > 0) return skipped("an agent is working");
      const statfs = yield* Effect.tryPromise({
        try: () => loadStatfs(),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.reclaimDatabaseSpace.loadStatfs",
            message: "Failed to load filesystem free-space inspection.",
            cause,
          }),
      });
      if (!statfs) return skipped("free disk space cannot be inspected");
      const shortfall = yield* Effect.tryPromise({
        try: () =>
          vacuumFreeSpaceShortfall({
            dbPath: config.dbPath,
            liveBytes: liveDatabaseBytes(pages),
            statfs,
          }),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.reclaimDatabaseSpace.statfs",
            message: "Failed to inspect free disk space.",
            cause,
          }),
      });
      if (shortfall !== null) return skipped(shortfall);
      const beforeBytes = yield* Effect.promise(() => databaseFileBytes(config.dbPath));
      yield* compactDatabase();
      const afterBytes = yield* Effect.promise(() => databaseFileBytes(config.dbPath));
      yield* noteStorageMutated;
      return {
        action: "converted",
        reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
      } satisfies DatabaseSpaceResult;
    }).pipe(Effect.mapError(toStorageMaintenanceError("StorageMaintenance.reclaimDatabaseSpace")));

  const terminalThreadLogs = (input: {
    readonly modifiedBefore: string;
    readonly includeArchived: boolean;
  }) =>
    Effect.gen(function* () {
      const cutoffMs = Date.parse(input.modifiedBefore);
      const candidates = yield* computeProviderLogCandidates(yield* queryThreadRows(), {
        archivedAlive: !input.includeArchived,
      });
      return candidates.files.filter((file) => file.mtimeMs < cutoffMs);
    });

  const listTerminalThreadLogs: StorageMaintenanceShape["listTerminalThreadLogs"] = (input) =>
    terminalThreadLogs(input).pipe(
      Effect.mapError(toStorageMaintenanceError("StorageMaintenance.listTerminalThreadLogs")),
    );

  const cleanInactiveWorktreesAutomatically: StorageMaintenanceShape["cleanInactiveWorktreesAutomatically"] =
    (input) =>
      Effect.gen(function* () {
        // A Storage settings cleanup owns the profile while it runs.
        if (cleanupStatus && activeStates.has(cleanupStatus.state)) return null;
        // Fetch only repositories that own an F5 worktree.
        const owners = new Set<string>();
        for (const { entry, projectRoot } of (yield* listProjectRegistrations()).registrations) {
          if (!(yield* isManagedWorktreePath(entry.canonicalPath))) continue;
          const commonDir = yield* commonDirOf(projectRoot);
          if (commonDir !== null) owners.add(commonDir);
        }
        const fetchWarnings = owners.size > 0 ? yield* refreshProjectRemotes(owners) : [];
        const removed = yield* cleanF5Worktrees(
          { operationId: input.operationId },
          undefined,
          undefined,
          fetchWarnings,
          { eligibleOnly: true },
        );
        const pruned = yield* clearStaleRegistrations(
          { operationId: input.operationId },
          undefined,
          undefined,
          { managedOnly: true },
        );
        return [removed, pruned];
      }).pipe(
        Effect.ensuring(finishStorageMutation(input.operationId)),
        Effect.mapError(
          toStorageMaintenanceError("StorageMaintenance.cleanInactiveWorktreesAutomatically"),
        ),
      );

  const previewInactiveWorktrees: StorageMaintenanceShape["previewInactiveWorktrees"] = Effect.gen(
    function* () {
      const previews: InactiveWorktreePreview[] = [];
      const worktrees = yield* computeF5WorktreeTargets(undefined, { skipSizing: true });
      for (const target of worktrees.targets) {
        previews.push({
          path: target.path ?? target.id,
          kind: "worktree",
          action: target.safeToDelete ? "remove" : "skip",
          reason: target.safeToDelete
            ? ["inactive worktree", target.detail].filter(Boolean).join(" · ")
            : (target.disabledReason ?? "Target is not safe."),
        });
      }
      for (const target of (yield* computeStaleRegistrationTargets()).targets) {
        if (!(yield* isManagedWorktreePath(target.id))) continue;
        previews.push({
          path: target.id,
          kind: "missingRegistration",
          action: target.safeToDelete ? "remove" : "skip",
          reason: target.safeToDelete
            ? "the worktree folder is missing; its registration would be pruned"
            : (target.disabledReason ?? "Target is not safe."),
        });
      }
      return previews;
    },
  ).pipe(Effect.mapError(toStorageMaintenanceError("StorageMaintenance.previewInactiveWorktrees")));

  const pruneTerminalThreadLogs: StorageMaintenanceShape["pruneTerminalThreadLogs"] = (input) =>
    Effect.gen(function* () {
      // Enumerate outside the engine gate; each unlink revalidates eligibility
      // under provider access and a short maintenance lock.
      const result = yield* Effect.gen(function* () {
        const files = yield* terminalThreadLogs(input);
        const deleted = yield* deleteProviderLogFiles(
          { operationId: input.operationId },
          undefined,
          "providerLogsForTerminalThreads",
          files,
          !input.includeArchived,
        );
        return deleted;
      });
      return result;
    }).pipe(
      Effect.ensuring(finishStorageMutation(input.operationId)),
      Effect.mapError(toStorageMaintenanceError("StorageMaintenance.pruneTerminalThreadLogs")),
    );

  const operations = new Map<
    string,
    {
      hash: string;
      acceptedAt: number;
      status: StorageCleanupStatus;
      results: ReadonlyArray<StorageCleanupCategoryResult>;
    }
  >();
  const activeStates = new Set(["queued", "running", "cancelling"]);
  const pruneOperations = () => {
    let retainedBytes = 0;
    let completed = 0;
    for (const [id, operation] of [...operations].reverse()) {
      if (activeStates.has(operation.status.state)) continue;
      retainedBytes += JSON.stringify(operation).length * 2;
      completed++;
      if (Date.now() - Date.parse(operation.status.completedAt!) > NONCE_TTL_MS) {
        operations.delete(id);
        continue;
      }
      if (completed > 50 || retainedBytes > 8 * 1024 * 1024) {
        const omitted = operation.results.reduce(
          (total, result) => total + result.perTargetReclaimed.length + result.warnings.length,
          0,
        );
        operation.results = [];
        operation.status = {
          ...operation.status,
          result: null,
          omittedCount: operation.status.omittedCount + omitted,
        };
        if (cleanupStatus?.operationId === id) cleanupStatus = operation.status;
      }
    }
  };
  const acceptanceGate = Semaphore.makeUnsafe(1);
  const acceptCleanup: StorageMaintenanceShape["acceptCleanup"] = (request) =>
    Effect.gen(function* () {
      pruneOperations();
      if (request.backendEpoch !== backendEpoch)
        return yield* new StorageMaintenanceError({
          operation: "operation_unknown",
          message: "operation_unknown: F5 restarted. Rescan and confirm cleanup again.",
        });
      const hash = canonicalJsonHash(request);
      const existing = operations.get(request.operationId);
      if (existing) {
        if (existing.hash !== hash)
          return yield* new StorageMaintenanceError({
            operation: "cleanup",
            message: "Operation id conflicts with a different cleanup request.",
          });
        return existing.status;
      }
      if (cleanupStatus && activeStates.has(cleanupStatus.state))
        return yield* new StorageMaintenanceError({
          operation: "cleanup",
          message: "A cleanup is already running for this profile.",
        });
      const prepared = yield* validateCleanupRequest(request);
      const targetCounts = new Map(
        prepared.requestedCategories.map((category) => [
          category.id,
          Math.max(1, category.targets.length),
        ]),
      );
      if (
        !targetCounts.has("databaseVacuum") &&
        request.options?.vacuumAfterDeletes !== false &&
        prepared.requestedCategories.some(
          (category) => category.id.startsWith("purge") || category.id === "orphanAttachments",
        )
      )
        targetCounts.set("databaseVacuum", 1);
      const totalTargets = [...targetCounts.values()].reduce((total, count) => total + count, 0);
      let currentCategory: StorageCleanupCategoryId | undefined;
      let completedBeforeCategory = 0;
      const status: StorageCleanupStatus = {
        operationId: request.operationId,
        state: "queued",
        startedAt: nowIso(),
        completedAt: null,
        progress: {
          operationId: request.operationId,
          phase: "starting",
          message: "Starting…",
          completedTargets: 0,
          totalTargets,
        },
        result: null,
        error: null,
        omittedCount: 0,
      };
      const record = {
        hash,
        acceptedAt: Date.now(),
        status,
        results: [] as ReadonlyArray<StorageCleanupCategoryResult>,
      };
      operations.set(request.operationId, record);
      cleanupStatus = status;
      operationRevision++;
      cancellableOperations.add(request.operationId);
      const update = (patch: Partial<StorageCleanupStatus>) => {
        record.status = { ...record.status, ...patch };
        cleanupStatus = record.status;
        operationRevision++;
      };
      yield* Effect.gen(function* () {
        update({ state: "running" });
        const result = yield* Effect.exit(
          cleanup(
            request,
            {
              publishProgress: (progress) =>
                Effect.sync(() => {
                  if (progress.categoryId && progress.categoryId !== currentCategory) {
                    if (currentCategory)
                      completedBeforeCategory += targetCounts.get(currentCategory) ?? 0;
                    currentCategory = progress.categoryId;
                  }
                  update({
                    progress: {
                      ...progress,
                      totalTargets,
                      completedTargets: Math.min(
                        totalTargets,
                        completedBeforeCategory + progress.completedTargets,
                      ),
                    },
                  });
                }),
            },
            prepared,
          ),
        );
        if (Exit.isFailure(result)) {
          yield* Effect.logWarning("Storage cleanup failed", result.cause);
          update({
            state: "failed",
            completedAt: nowIso(),
            error: storageCauseMessage(result.cause),
          });
        } else {
          let omittedDetails = 0,
            remainingDetailBytes = 4 * 1024 * 1024;
          record.results = result.value.results.map((entry) => {
            const fileOnly = [
              "orphanAttachments",
              "providerLogRotations",
              "providerLogsForTerminalThreads",
              "codexMarketplaceStaging",
            ].includes(entry.categoryId);
            const candidates = fileOnly
              ? entry.perTargetReclaimed.slice(0, 5)
              : entry.perTargetReclaimed;
            const targets = candidates.filter((target) => {
              const bytes = Buffer.byteLength(JSON.stringify(target)) * 2;
              if (bytes > remainingDetailBytes) return false;
              remainingDetailBytes -= bytes;
              return true;
            });
            omittedDetails +=
              entry.perTargetReclaimed.length -
              targets.length +
              Math.max(0, entry.warnings.length - 200);
            return {
              ...entry,
              perTargetReclaimed: targets,
              warnings: entry.warnings.slice(0, 200),
            };
          });
          // Keep status frames bounded. Detailed target outcomes are read in pages.
          let omittedCount = omittedDetails;
          const summary = {
            ...result.value,
            warnings: result.value.warnings.slice(0, 5),
            results: result.value.results.map((entry) => {
              omittedCount +=
                Math.max(0, entry.perTargetReclaimed.length - 5) +
                Math.max(0, entry.warnings.length - 2);
              return {
                ...entry,
                warnings: entry.warnings.slice(0, 2),
                perTargetReclaimed: entry.perTargetReclaimed.slice(0, 5),
              };
            }),
          };
          update({
            state: result.value.cancelled
              ? "cancelled"
              : result.value.results.length > 0 &&
                  result.value.results.every((entry) => entry.status === "Failed")
                ? "failed"
                : result.value.warnings.length
                  ? "partial"
                  : "succeeded",
            completedAt: nowIso(),
            result:
              Buffer.byteLength(JSON.stringify(summary)) <= 24 * 1024
                ? summary
                : {
                    ...summary,
                    warnings: summary.warnings.slice(0, 2),
                    results: summary.results.map((entry) => ({
                      ...entry,
                      warnings: [],
                      perTargetReclaimed: [],
                    })),
                  },
            omittedCount,
            progress: record.status.progress
              ? {
                  ...record.status.progress,
                  phase: "finished",
                  message: result.value.cancelled ? "Cancelled" : "Cleanup finished",
                  completedTargets: result.value.cancelled
                    ? record.status.progress.completedTargets
                    : totalTargets,
                }
              : null,
          });
        }
        pruneOperations();
      }).pipe(Effect.forkIn(scope));
      return status;
    }).pipe(acceptanceGate.withPermit);
  const getTargets: StorageMaintenanceShape["getTargets"] = (request) =>
    Effect.gen(function* () {
      const issued = issuedConfirmations.get(request.scanId);
      if (!issued || issued.expiresAtMs <= Date.now())
        return yield* new StorageMaintenanceError({
          operation: "getTargets",
          message: "Storage scan expired. Rescan to review targets.",
        });
      const targets = [...(issued.categories.get(request.categoryId)?.targets ?? [])].sort(
        (a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id),
      );
      const start = request.cursor ?? 0;
      const end = start + Math.min(request.limit ?? 100, 100);
      return {
        targets: targets.slice(start, end),
        targetCount: targets.length,
        nextCursor: end < targets.length ? end : null,
      };
    });
  const getOperation: StorageMaintenanceShape["getOperation"] = (request) =>
    Effect.gen(function* () {
      pruneOperations();
      const operation = operations.get(request.operationId);
      if (!operation)
        return yield* new StorageMaintenanceError({
          operation: "operation_unknown",
          message:
            "operation_unknown: Cleanup details are no longer retained. Rescan to review remaining work.",
        });
      const details = operation.results.flatMap((result) => {
        const targets = result.perTargetReclaimed.map((target) => ({
          ...result,
          perTargetReclaimed: [target],
          warnings: [],
        }));
        const failures = result.warnings.map((warning) => ({
          ...result,
          perTargetReclaimed: [],
          warnings: [warning],
        }));
        return targets.length || failures.length ? [...targets, ...failures] : [result];
      });
      const start = request.cursor ?? 0,
        end = start + Math.min(request.limit ?? 50, 50);
      return {
        status: operation.status,
        results: details.slice(start, end),
        nextCursor: end < details.length ? end : null,
      };
    });

  return {
    inspect,
    getUsage,
    getStatus,
    getTargets,
    getOperation,
    acceptCleanup,
    noteStorageMutated,
    summarizeReclaimable,
    cleanup,
    cancel,
    purgeThreads,
    reclaimDatabaseSpace,
    listTerminalThreadLogs,
    pruneTerminalThreadLogs,
    cleanInactiveWorktreesAutomatically,
    previewInactiveWorktrees,
  } satisfies StorageMaintenanceShape;
});

export const StorageMaintenanceLive = Layer.effect(StorageMaintenance, makeStorageMaintenance);
