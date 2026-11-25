import { MACHINE_CATEGORY_IDS, type CleanupFileReview } from "./cleanupProviders.ts";
import { userFacingCauseMessage } from "../causeMessage.ts";
import { type DiscardableChanges, type WorktreeRemovalPolicy } from "../project/worktreeClaims.ts";
import * as OS from "node:os";
import * as Path from "node:path";

import type {
  ProjectId,
  ProjectKind,
  StorageCleanupCategoryId,
  StorageAutomationJob,
  StorageCleanupCategoryResult,
  StorageCleanupCategoryUsage,
  StorageCleanupTargetSelection,
  StorageCleanupTarget,
  StoragePathWarning,
  ThreadId,
} from "@t3tools/contracts";
import { defaultF5BaseDir, legacyT3BaseDir } from "@t3tools/shared/appStatePaths";
import type { Cause } from "effect";

import type { FileIdentity, EnumeratedFile } from "./diskUsage.ts";

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

export function legacyAllowedRootForCategory(categoryId: LegacyCleanupCategoryId): string {
  const homeDir = OS.homedir();
  return categoryId === "f5UserdataEmpty" ? defaultF5BaseDir(homeDir) : legacyT3BaseDir(homeDir);
}
