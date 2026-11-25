import { storageLstat, storageReadDir } from "./diskUsage.ts";
import { MACHINE_CATEGORY_IDS, type CleanupFileReview } from "./cleanupProviders.ts";
import { userFacingCauseMessage } from "../causeMessage.ts";
import { type DiscardableChanges, type WorktreeRemovalPolicy } from "../project/worktreeClaims.ts";
import { stripPathTerminator } from "../git/worktreeList.ts";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  type ProjectId,
  type ProjectKind,
  type DiskSpaceReclaimableItem,
  type PendingDatabaseCompaction,
  type StorageScheduleCompactionRequest,
  type StorageScheduleCompactionResult,
  type StorageCleanupCategoryId,
  type StorageAutomationJob,
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
  type StorageUsageReport,
  ThreadId,
} from "@t3tools/contracts";
import { defaultF5BaseDir, legacyT3BaseDir } from "@t3tools/shared/appStatePaths";
import { Cause, Effect, Schema, Scope } from "effect";

import { getDatabaseDamage } from "../persistence/databaseHealth.ts";
import {
  enumerateFiles,
  allocatedBytes,
  type FileIdentity,
  type EnumeratedFile,
} from "./diskUsage.ts";
import { safeLstat } from "./storagePathSafety.ts";

export const USAGE_CACHE_TTL_MS = 10 * 60_000;
/** Total time a scan may spend refreshing `origin/<default>` across repositories. */
export const REMOTE_REFRESH_BUDGET = "60 seconds";
export const NONCE_TTL_MS = 15 * 60_000;
export const EVENTS_ROTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ARCHIVED_THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Free pages worth one full VACUUM to switch to incremental auto-vacuum. */
export const AUTO_CONVERT_MIN_FREE_BYTES = 256 * 1024 * 1024;
export const AUTO_CONVERT_MIN_FREE_FRACTION = 0.2;
/** Conversion reserves the database, so automatic runs wait for this quiet interval. */
export const AUTO_CONVERT_QUIET_MS = 30 * 60 * 1_000;
/** Automatic conversion skipped this long is offered to run now or at the next start. */
export const PENDING_COMPACTION_AFTER_MS = 3 * 24 * 60 * 60 * 1_000;
export const AUTO_CONVERT_SKIP_PREFIX = "switching to incremental auto-vacuum waits: ";
/** A compaction scheduled for the next start is skipped if the server is not ready by then. */
export const SCHEDULED_COMPACTION_READY_WAIT = "2 minutes";
export const PURGE_FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1_000;

export const WORKTREE_SCAN_MAX_DEPTH = 4;
export const DOCKER_IMAGES_TARGET_ID = "docker:unused-images";
/** Dependency folders of a checkout a thread used this recently are kept. */
export const CHECKOUT_RECENT_USE_MS = 24 * 60 * 60 * 1_000;
export const CHECKOUT_SIZE_BUDGET_MS = 60_000;
/** Searching checkouts, including each candidate's nested-Git check; within the worker's 120 s. */
export const CHECKOUT_DISCOVERY_BUDGET_MS = 40_000;
export const GIT_WORKTREE_METADATA_UNRESOLVED = "Git worktree metadata could not be resolved.";

export class StorageMaintenanceError extends Schema.TaggedErrorClass<StorageMaintenanceError>()(
  "StorageMaintenanceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * Deleting files or rewriting the database while it is damaged can destroy
 * what recovery still needs, so every mutating entry point stands down.
 */
export const refuseWhileDatabaseDamaged = (operation: string) =>
  Effect.suspend(() =>
    getDatabaseDamage() === null
      ? Effect.void
      : Effect.fail(
          new StorageMaintenanceError({
            operation,
            message:
              "The F5 database is damaged. Storage maintenance is paused until it is recovered.",
          }),
        ),
  );

export interface StorageCleanupContext {
  readonly publishProgress?: (
    event: StorageCleanupProgressPayload,
  ) => Effect.Effect<void, never, never>;
}

/** What the cleanup helpers need from a request: progress and cancellation key on it. */
export type CleanupOperation = Pick<StorageCleanupRequest, "operationId">;
export type CleanupInput = Omit<StorageCleanupRequest, "backendEpoch"> & {
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
   * The one-time conversion the automatic job has skipped for
   * {@link PENDING_COMPACTION_AFTER_MS} or longer, or null. Never fails.
   */
  readonly getPendingCompaction: Effect.Effect<PendingDatabaseCompaction | null>;
  /** Requests the full compaction for the next server start, or withdraws the request. */
  readonly scheduleCompaction: (
    when: StorageScheduleCompactionRequest["when"],
  ) => Effect.Effect<StorageScheduleCompactionResult, StorageMaintenanceError>;
  /**
   * Startup, before the queue dispatcher starts: when a compaction was
   * scheduled, removes the request first (a crash cannot loop), takes the
   * maintenance lock at once so no turn starts or resumes before it, and
   * compacts once `ready` completes or after a short wait. Free space is
   * still checked; quiet-time and busy-agent checks are not.
   */
  readonly startScheduledCompaction: (
    ready: Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
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

export interface ThreadRow {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly lastInteractionAt: string;
  readonly projectName: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly workspaceRoot: string | null;
  readonly projectKind: ProjectKind | null;
  readonly scratchPath: string | null;
}

export interface OrphanAttachmentRow {
  readonly attachmentId: string;
  readonly name: string;
  readonly finalPath: string;
  readonly lifecycle?: string;
  readonly lastError?: string | null;
}

export type LegacyCleanupCategoryId = Extract<
  StorageCleanupCategoryId,
  | "legacyT3Userdata"
  | "legacyT3Diverged"
  | "legacyT3Worktrees"
  | "legacyT3Dev"
  | "legacyT3Caches"
  | "legacyT3Root"
  | "f5UserdataEmpty"
>;

export type PerTargetReclaimed = Array<StorageCleanupCategoryResult["perTargetReclaimed"][number]>;

export interface WorktreeReview {
  readonly archiveThreads?: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    readonly lastInteractionAt: string;
    readonly sessionUpdatedAt: string | null;
  }>;
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
export interface DependencyFolderReview {
  readonly checkoutRoot: string;
  readonly identity: FileIdentity;
}
export interface TemporaryPackReview {
  readonly repositoryRoot: string;
  readonly packDirectory: string;
  readonly identity: FileIdentity;
}
export interface StorageReview {
  readonly files?: ReadonlyMap<string, CleanupFileReview>;
  readonly dependencyFolders?: ReadonlyMap<string, DependencyFolderReview>;
  readonly temporaryPacks?: ReadonlyMap<string, TemporaryPackReview>;
  readonly worktrees: ReadonlyMap<string, WorktreeReview>;
  readonly identities: ReadonlyMap<string, FileIdentity | null>;
  readonly threads: ReadonlyMap<string, ThreadRow>;
}
export interface UsageNonceState {
  readonly scanId: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
  readonly generation: number;
  readonly review: StorageReview;
  readonly categories: ReadonlyMap<StorageCleanupCategoryId, StorageCleanupCategoryUsage>;
  used: boolean;
}

export interface WorktreeRemovalReadiness {
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
export function isArchivePolicy(policy: WorktreeRemovalPolicy): boolean {
  return (
    (policy.kind === "storageMaintenance" || policy.kind === "externalCleanup") &&
    policy.archiveIdleThreads === true
  );
}
export function manualAuditJob(category: StorageCleanupCategoryId): StorageAutomationJob {
  if (MACHINE_CATEGORY_IDS.has(category) || category === "dockerUnusedImages")
    return "machine-cleanup";
  if (category.startsWith("purge")) return "thread-purge";
  if (category === "databaseVacuum") return "database-vacuum";
  if (category === "codexMarketplaceStaging") return "codex-marketplace-staging";
  if (category.startsWith("providerLog")) return "provider-logs";
  return "worktree-cleanup";
}
export function blockingReasons(reason: string | undefined) {
  if (!reason) return {};
  const code = /uncommitted/.test(reason)
    ? "local_changes"
    : /ignored files/.test(reason)
      ? "protected_ignored_files"
      : /queued/.test(reason)
        ? "queued_work"
        : /active|session|terminal|using/.test(reason)
          ? "workspace_in_use"
          : /commits|pushed/.test(reason)
            ? "merge_unverified"
            : "verification_unavailable";
  return { blockingReasons: [{ code, message: reason }] };
}

export function storageCauseMessage(cause: Cause.Cause<unknown>): string {
  return userFacingCauseMessage(cause, "Storage operation failed.", { maxLength: 300 });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clampBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function uniqueCategoryIds(
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

export function normalizeTargetSelections(
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

export async function exists(path: string): Promise<boolean> {
  try {
    await storageLstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function databaseFileBytes(dbPath: string): Promise<number> {
  const stats = await Promise.all(
    ["", "-wal", "-shm", "-journal"].map((suffix) => safeLstat(`${dbPath}${suffix}`)),
  );
  return stats.reduce((total, stat) => total + (stat ? allocatedBytes(stat) : 0), 0);
}

export function providerLogSegmentFromName(name: string): string | null {
  const match = /^(.+)\.log(?:\.\d+)?$/.exec(name);
  const segment = match?.[1];
  if (!segment || segment === "events" || segment === "_global") {
    return null;
  }
  return segment;
}

export function isEventsLogRotation(file: EnumeratedFile): boolean {
  return /^events\.log\.\d+$/.test(file.name);
}

export function isActiveStorageThread(thread: ThreadRow): boolean {
  return thread.deletedAt === null && thread.archivedAt === null;
}

export function normalizePathForCompare(path: string): string {
  return Path.resolve(path);
}

export function pathContainsOrEquals(rootPath: string, targetPath: string): boolean {
  const root = normalizePathForCompare(rootPath);
  const target = normalizePathForCompare(targetPath);
  const relative = Path.relative(root, target);
  return (
    relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
}

export function pathsOverlap(leftPath: string, rightPath: string): boolean {
  return pathContainsOrEquals(leftPath, rightPath) || pathContainsOrEquals(rightPath, leftPath);
}

export function sumNonOverlappingPathUsages(
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

export function categoryUsage(input: {
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

export function resultFor(input: {
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

export function warningFor(path: string, reason: string): StoragePathWarning {
  return { path, reason: reason.replace(/\s+/g, " ").trim().slice(0, 300) };
}

export function toStorageMaintenanceError(operation: string) {
  return (cause: unknown) =>
    Schema.is(StorageMaintenanceError)(cause)
      ? cause
      : new StorageMaintenanceError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
}

export function parseActiveTurnId(runtimePayloadJson: string | null): string | null {
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

export async function listProviderLogFiles(providerLogsDir: string): Promise<{
  readonly files: ReadonlyArray<EnumeratedFile>;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
}> {
  if (!(await exists(providerLogsDir))) {
    return { files: [], warnings: [] };
  }
  const result = await enumerateFiles(providerLogsDir, { maxDepth: 1 });
  return { files: result.files, warnings: result.errors };
}

export async function listGitWorktreeDirectories(input: {
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

export function legacyAllowedRootForCategory(categoryId: LegacyCleanupCategoryId): string {
  const homeDir = OS.homedir();
  return categoryId === "f5UserdataEmpty" ? defaultF5BaseDir(homeDir) : legacyT3BaseDir(homeDir);
}

export async function resolveWorktreeRemoveCwd(targetPath: string): Promise<string | null> {
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

export async function loadStatfs(): Promise<
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
