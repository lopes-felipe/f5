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
  operationId: Schema.String,
  job: StorageAutomationJob,
  policyVersion: NonNegativeInt,
  target: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  beforeRef: Schema.NullOr(Schema.String),
  afterRef: Schema.NullOr(Schema.String),
  result: Schema.Literals(["removed", "pulled", "skipped", "failed"]),
  reason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type StorageAutomationAuditEntry = typeof StorageAutomationAuditEntry.Type;

export const StorageAutomationAuditInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type StorageAutomationAuditInput = typeof StorageAutomationAuditInput.Type;

export const StorageAutomationAuditResult = Schema.Struct({
  entries: Schema.Array(StorageAutomationAuditEntry),
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
  "legacyT3Userdata",
  "legacyT3Diverged",
  "legacyT3Worktrees",
  "legacyT3Dev",
  "legacyT3Caches",
  "legacyT3Root",
  "f5UserdataEmpty",
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
});
export type StorageCleanupTarget = typeof StorageCleanupTarget.Type;

export const StorageCleanupCategoryUsage = Schema.Struct({
  id: StorageCleanupCategoryId,
  section: StorageCleanupSectionId,
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
  reclaimableBytes: NonNegativeInt,
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
  scanId: TrimmedNonEmptyString,
  confirmationNonce: TrimmedNonEmptyString,
  nonceExpiresAt: IsoDateTime,
  scannedAt: IsoDateTime,
  stateDir: TrimmedNonEmptyString,
  totalUsedBytes: NonNegativeInt,
  reclaimableBytes: NonNegativeInt,
  databaseBytes: NonNegativeInt,
  worktreesBytes: NonNegativeInt,
  logsBytes: NonNegativeInt,
  attachmentsBytes: NonNegativeInt,
  legacyBytes: NonNegativeInt,
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
});
export type StorageCleanupOptions = typeof StorageCleanupOptions.Type;

export const StorageCleanupTargetSelection = Schema.Struct({
  categoryId: StorageCleanupCategoryId,
  targetIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type StorageCleanupTargetSelection = typeof StorageCleanupTargetSelection.Type;

export const StorageCleanupRequest = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  scanId: TrimmedNonEmptyString,
  confirmationNonce: TrimmedNonEmptyString,
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
});
export type StorageCleanupResult = typeof StorageCleanupResult.Type;
