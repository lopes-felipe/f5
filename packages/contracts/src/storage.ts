import { FilesystemPath } from "./baseSchemas";
import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

// ── Automatic storage cleanup and default-branch auto-pull ───────────────

export const StorageAutomationJob = Schema.Literals([
  "worktree-cleanup",
  "provider-logs",
  "auto-pull",
  "codex-marketplace-staging",
  "event-compaction",
  "thread-purge",
  "database-vacuum",
  "machine-cleanup",
]);
export type StorageAutomationJob = typeof StorageAutomationJob.Type;

/** One target an automatic job would act on, or skip with an exact reason. */
export const StorageAutomationTarget = Schema.Struct({
  job: StorageAutomationJob,
  /** Redacted: relative to the managed worktrees directory, or a project label. */
  target: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  action: Schema.Literals(["remove", "pull", "skip"]),
  reason: Schema.String,
});
export type StorageAutomationTarget = typeof StorageAutomationTarget.Type;

export const StorageAutomationDryRunInput = Schema.Struct({});
export type StorageAutomationDryRunInput = typeof StorageAutomationDryRunInput.Type;

export const StorageAutomationDryRunResult = Schema.Struct({
  storageCleanupEnabled: Schema.Boolean,
  generatedAt: IsoDateTime,
  targets: Schema.Array(StorageAutomationTarget),
});
export type StorageAutomationDryRunResult = typeof StorageAutomationDryRunResult.Type;

export const StorageAutomationAuditEntry = Schema.Struct({
  auditId: Schema.String,
  source: Schema.Literals(["automatic", "manual"]),
  category: Schema.NullOr(Schema.String),
  reasonCode: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(
    Schema.Struct({ targetCount: NonNegativeInt, reclaimedBytes: NonNegativeInt }),
  ),
  operationId: Schema.String,
  job: StorageAutomationJob,
  policyVersion: NonNegativeInt,
  target: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  beforeRef: Schema.NullOr(Schema.String),
  afterRef: Schema.NullOr(Schema.String),
  result: Schema.Literals(["removed", "pulled", "skipped", "failed", "archiving", "archived"]),
  reason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type StorageAutomationAuditEntry = typeof StorageAutomationAuditEntry.Type;

export const StorageAutomationAuditInput = Schema.Struct({
  source: Schema.optional(Schema.Literals(["automatic", "manual"])),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type StorageAutomationAuditInput = typeof StorageAutomationAuditInput.Type;

export const ScheduledBackupStatus = Schema.Struct({
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  lastSuccessAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type ScheduledBackupStatus = typeof ScheduledBackupStatus.Type;

export const StorageAutomationAuditResult = Schema.Struct({
  entries: Schema.Array(StorageAutomationAuditEntry),
  scheduledBackupStatus: Schema.optional(ScheduledBackupStatus),
});
export type StorageAutomationAuditResult = typeof StorageAutomationAuditResult.Type;

export const StorageCleanupCategoryId = Schema.Literals([
  "purgeDeletedThreads",
  "purgeArchivedThreads",
  "providerLogsForTerminalThreads",
  "providerLogRotations",
  "orphanAttachments",
  "codexMarketplaceStaging",
  "databaseVacuum",
  "inactiveF5Worktrees",
  "externalWorktrees",
  "staleWorktreeRegistrations",
  "legacyT3Userdata",
  "legacyT3Diverged",
  "legacyT3Worktrees",
  "legacyT3Dev",
  "legacyT3Caches",
  "legacyT3Root",
  "f5UserdataEmpty",
  "f5Backups",
  "f5ApplicationLogs",
  "bunDownloadCache",
  "npmDownloadCache",
  "uvDiscardedCaches",
  "chromeCaches",
  "bambuStudioLogs",
]);
export type StorageCleanupCategoryId = typeof StorageCleanupCategoryId.Type;

export const StorageCleanupImpact = Schema.Literals(["none", "low", "medium", "high"]);
export type StorageCleanupImpact = typeof StorageCleanupImpact.Type;

export const StorageCleanupAvailability = Schema.Literals(["ready", "disabled"]);
export type StorageCleanupAvailability = typeof StorageCleanupAvailability.Type;

export const StorageCleanupSectionId = Schema.Literals([
  "database",
  "worktrees",
  "logs",
  "attachments",
  "providers",
  "legacy",
  "machine",
]);
export type StorageCleanupSectionId = typeof StorageCleanupSectionId.Type;

export const StoragePathWarning = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
});
export type StoragePathWarning = typeof StoragePathWarning.Type;

export const StorageCleanupTarget = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  path: Schema.optional(Schema.String),
  bytes: NonNegativeInt,
  safeToDelete: Schema.Boolean,
  disabledReason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  threadTitle: Schema.optional(Schema.String),
  projectName: Schema.optional(Schema.String),
  latestMtime: Schema.optional(IsoDateTime),
  action: Schema.optional(Schema.Literals(["remove", "archiveAndRemove"])),
  affectedThreads: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
  ),
  blockingReasons: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String })),
  ),
});
export type StorageCleanupTarget = typeof StorageCleanupTarget.Type;

export const StorageCleanupCategoryUsage = Schema.Struct({
  id: StorageCleanupCategoryId,
  section: StorageCleanupSectionId,
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
  reclaimableBytes: NonNegativeInt,
  measurement: Schema.Literals(["complete", "partial", "unavailable"]),
  eligibleThreadCount: NonNegativeInt,
  defaultSelected: Schema.Boolean,
  impact: StorageCleanupImpact,
  availability: StorageCleanupAvailability,
  disabledReason: Schema.optional(Schema.String),
  targetCount: NonNegativeInt,
  targets: Schema.Array(StorageCleanupTarget),
  warnings: Schema.Array(StoragePathWarning),
});
export type StorageCleanupCategoryUsage = typeof StorageCleanupCategoryUsage.Type;

export const StorageUsageReport = Schema.Struct({
  serverName: Schema.optional(Schema.String),
  discoveryRoots: Schema.optional(Schema.Array(Schema.String)),
  machineCleanupScanned: Schema.optional(Schema.Boolean),
  scanId: TrimmedNonEmptyString,
  scannedAt: IsoDateTime,
  stateDir: TrimmedNonEmptyString,
  totalUsedBytes: NonNegativeInt,
  reclaimableBytes: NonNegativeInt,
  databaseBytes: NonNegativeInt,
  worktreesBytes: NonNegativeInt,
  logsBytes: NonNegativeInt,
  attachmentsBytes: NonNegativeInt,
  legacyBytes: NonNegativeInt,
  providerHomesBytes: NonNegativeInt,
  /** Optional so previously persisted reports can still be displayed. */
  providerHomesMeasurement: Schema.optional(
    Schema.Literals(["complete", "partial", "unavailable"]),
  ),
  otherBytes: NonNegativeInt,
  machineBytes: Schema.optional(NonNegativeInt),
  providerHomes: Schema.Array(
    Schema.Struct({ name: Schema.String, path: Schema.String, bytes: NonNegativeInt }),
  ),
  warningsTruncated: Schema.Boolean,
  threadCount: NonNegativeInt,
  archivedThreadCount: NonNegativeInt,
  deletedThreadCount: NonNegativeInt,
  providerLogSegmentCount: NonNegativeInt,
  envOverrideActive: Schema.Boolean,
  legacyCleanupDisabledReason: Schema.optional(Schema.String),
  categories: Schema.Array(StorageCleanupCategoryUsage),
  warnings: Schema.Array(StoragePathWarning),
});
export type StorageUsageReport = typeof StorageUsageReport.Type;

export const StorageGetUsageRequest = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
});
export type StorageGetUsageRequest = typeof StorageGetUsageRequest.Type;

export const StorageCleanupOptions = Schema.Struct({
  vacuumAfterDeletes: Schema.optional(Schema.Boolean),
  archiveIdleThreads: Schema.optional(Schema.Boolean),
});
export type StorageCleanupOptions = typeof StorageCleanupOptions.Type;

export const StorageCleanupTargetSelection = Schema.Struct({
  categoryId: StorageCleanupCategoryId,
  targetIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type StorageCleanupTargetSelection = typeof StorageCleanupTargetSelection.Type;

export const StorageCleanupRequest = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  backendEpoch: TrimmedNonEmptyString,
  scanId: TrimmedNonEmptyString,
  nonce: TrimmedNonEmptyString,
  categoryIds: Schema.Array(StorageCleanupCategoryId).check(Schema.isMinLength(1)),
  targetSelections: Schema.optional(Schema.Array(StorageCleanupTargetSelection)),
  confirmationText: Schema.optional(Schema.String),
  options: Schema.optional(StorageCleanupOptions),
});
export type StorageCleanupRequest = typeof StorageCleanupRequest.Type;

export const StorageCancelCleanupRequest = Schema.Struct({
  operationId: TrimmedNonEmptyString,
});
export type StorageCancelCleanupRequest = typeof StorageCancelCleanupRequest.Type;

export const StorageCleanupProgressPayload = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  categoryId: Schema.optional(StorageCleanupCategoryId),
  phase: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  completedTargets: NonNegativeInt,
  totalTargets: NonNegativeInt,
});
export type StorageCleanupProgressPayload = typeof StorageCleanupProgressPayload.Type;

export const StorageInvalidatedPayload = Schema.Struct({
  reason: TrimmedNonEmptyString,
  operationId: Schema.optional(TrimmedNonEmptyString),
});
export type StorageInvalidatedPayload = typeof StorageInvalidatedPayload.Type;

// ── Free disk space on the volumes F5 and its providers write to ─────────

/** `low`: warn. `critical`: new turns are held until space is freed. */
export const DiskSpaceLevel = Schema.Literals(["ok", "low", "critical"]);
export type DiskSpaceLevel = typeof DiskSpaceLevel.Type;

export const DiskSpaceVolumeRole = Schema.Literals(["userdata", "claudeHome", "codexHome"]);
export type DiskSpaceVolumeRole = typeof DiskSpaceVolumeRole.Type;

export const DiskSpaceVolume = Schema.Struct({
  /** One watched path on the volume; others on the same volume are folded in. */
  path: FilesystemPath,
  roles: Schema.Array(DiskSpaceVolumeRole),
  freeBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
  level: DiskSpaceLevel,
});
export type DiskSpaceVolume = typeof DiskSpaceVolume.Type;

export const DiskSpaceReclaimableItem = Schema.Struct({
  categoryId: StorageCleanupCategoryId,
  title: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
});
export type DiskSpaceReclaimableItem = typeof DiskSpaceReclaimableItem.Type;

export const DiskSpaceStatus = Schema.Struct({
  /** The lowest level across the watched volumes. */
  level: DiskSpaceLevel,
  checkedAt: IsoDateTime,
  lowThresholdBytes: NonNegativeInt,
  criticalThresholdBytes: NonNegativeInt,
  volumes: Schema.Array(DiskSpaceVolume),
  /** Largest reclaimable storage categories, biggest first. Empty while space is ok. */
  reclaimable: Schema.Array(DiskSpaceReclaimableItem),
});
export type DiskSpaceStatus = typeof DiskSpaceStatus.Type;

export const StorageGetDiskSpaceRequest = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
});
export type StorageGetDiskSpaceRequest = typeof StorageGetDiskSpaceRequest.Type;

export const StorageCleanupCategoryResultStatus = Schema.Literals([
  "Cleaned",
  "Skipped",
  "Failed",
  "Scheduled",
]);
export type StorageCleanupCategoryResultStatus = typeof StorageCleanupCategoryResultStatus.Type;

export const StorageCleanupCategoryResult = Schema.Struct({
  categoryId: StorageCleanupCategoryId,
  status: StorageCleanupCategoryResultStatus,
  reclaimedBytes: NonNegativeInt,
  perTargetReclaimed: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      path: Schema.optional(Schema.String),
      reclaimedBytes: NonNegativeInt,
      status: Schema.optional(
        Schema.Literals(["Removed", "Skipped", "Deleted, cleanup incomplete", "Failed"]),
      ),
      /** Worktree removals: whether the merged local branch was deleted or kept. */
      branch: Schema.optional(Schema.Literals(["deleted", "kept"])),
    }),
  ),
  warnings: Schema.Array(StoragePathWarning),
  message: Schema.optional(Schema.String),
});
export type StorageCleanupCategoryResult = typeof StorageCleanupCategoryResult.Type;

export const StorageCleanupResult = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
  reclaimedBytes: NonNegativeInt,
  results: Schema.Array(StorageCleanupCategoryResult),
  warnings: Schema.Array(StoragePathWarning),
  cancelled: Schema.Boolean,
  volumeChanges: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        freeBeforeBytes: NonNegativeInt,
        freeAfterBytes: NonNegativeInt,
        netFreeBytes: Schema.Int,
      }),
    ),
  ),
});
export type StorageCleanupResult = typeof StorageCleanupResult.Type;

export const StorageScanStatus = Schema.Struct({
  state: Schema.Literals(["idle", "scanning", "failed"]),
  phase: Schema.NullOr(
    Schema.Literals([
      "remotes",
      "database",
      "files",
      "worktrees",
      "legacy",
      "providers",
      "finalizing",
    ]),
  ),
  entriesVisited: NonNegativeInt,
  startedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type StorageScanStatus = typeof StorageScanStatus.Type;
export const StorageCleanupStatus = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  state: Schema.Literals([
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
  ]),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  progress: Schema.NullOr(StorageCleanupProgressPayload),
  result: Schema.NullOr(StorageCleanupResult),
  error: Schema.NullOr(Schema.String),
  omittedCount: NonNegativeInt,
});
export type StorageCleanupStatus = typeof StorageCleanupStatus.Type;
export const StorageStatus = Schema.Struct({
  backendEpoch: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
  scan: StorageScanStatus,
  cleanup: Schema.NullOr(StorageCleanupStatus),
});
export type StorageStatus = typeof StorageStatus.Type;
export const StorageConfirmation = Schema.Struct({
  scanId: TrimmedNonEmptyString,
  nonce: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type StorageConfirmation = typeof StorageConfirmation.Type;
export const StorageGetUsageResult = Schema.Struct({
  report: Schema.NullOr(StorageUsageReport),
  confirmation: Schema.NullOr(StorageConfirmation),
  status: StorageStatus,
});
export type StorageGetUsageResult = typeof StorageGetUsageResult.Type;
export const StorageGetStatusRequest = Schema.Struct({});
export const StorageGetTargetsRequest = Schema.Struct({
  scanId: TrimmedNonEmptyString,
  categoryId: StorageCleanupCategoryId,
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type StorageGetTargetsRequest = typeof StorageGetTargetsRequest.Type;
export const StorageGetTargetsResult = Schema.Struct({
  targets: Schema.Array(StorageCleanupTarget),
  targetCount: NonNegativeInt,
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type StorageGetTargetsResult = typeof StorageGetTargetsResult.Type;
export const StorageGetOperationRequest = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type StorageGetOperationRequest = typeof StorageGetOperationRequest.Type;
export const StorageGetOperationResult = Schema.Struct({
  status: StorageCleanupStatus,
  results: Schema.Array(StorageCleanupCategoryResult),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type StorageGetOperationResult = typeof StorageGetOperationResult.Type;
