import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  type CheckpointRef,
  CommandId,
  type StorageCleanupCategoryId,
  type StorageCleanupCategoryResult,
  type StorageCleanupCategoryUsage,
  type StorageCleanupProgressPayload,
  type StorageCleanupRequest,
  type StorageCleanupTargetSelection,
  type StorageCleanupResult,
  type StorageCleanupTarget,
  type StorageGetUsageRequest,
  type StoragePathWarning,
  type StorageUsageReport,
  ThreadId,
} from "@t3tools/contracts";
import { defaultF5BaseDir, legacyT3BaseDir } from "@t3tools/shared/appStatePaths";
import { Cause, Effect, Exit, Layer, Schema, Scope, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { enumerateFiles, recursiveSize, sizeIfExists, type EnumeratedFile } from "./diskUsage.ts";
import { probeLegacyState, type LegacyProbeResult } from "./legacyStateProbe.ts";
import {
  isPathWithinRoot,
  removeFileIfSafe,
  removeTreeIfSafe,
  safeLstat,
} from "./storagePathSafety.ts";

const USAGE_CACHE_TTL_MS = 30_000;
const NONCE_TTL_MS = 5 * 60_000;
const EVENTS_ROTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ARCHIVED_THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const TYPED_CONFIRM_THRESHOLD_BYTES = 1024 * 1024 * 1024;
const WORKTREE_SCAN_MAX_DEPTH = 4;
const GIT_WORKTREE_METADATA_UNRESOLVED = "Git worktree metadata could not be resolved.";
const LEGACY_WORKTREE_DIRECT_DELETE_DETAIL =
  "Git metadata is missing; directory will be deleted directly.";

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

export interface StorageMaintenanceShape {
  readonly inspect: (
    request?: StorageGetUsageRequest,
  ) => Effect.Effect<StorageUsageReport, StorageMaintenanceError>;
  readonly cleanup: (
    request: StorageCleanupRequest,
    context?: StorageCleanupContext,
  ) => Effect.Effect<StorageCleanupResult, StorageMaintenanceError>;
  readonly cancel: (operationId: string) => Effect.Effect<void>;
}

export class StorageMaintenance extends ServiceMap.Service<
  StorageMaintenance,
  StorageMaintenanceShape
>()("t3/storage/StorageMaintenance") {}

interface ThreadRow {
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly workspaceRoot: string | null;
}

interface OrphanAttachmentRow {
  readonly attachmentId: string;
  readonly name: string;
  readonly finalPath: string;
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

interface UsageNonceState {
  readonly scanId: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
  readonly categories: ReadonlyMap<StorageCleanupCategoryId, StorageCleanupCategoryUsage>;
  used: boolean;
}

interface WorktreeRemovalReadiness {
  readonly commandCwd: string | null;
  readonly disabledReason?: string;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
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
): ReadonlyMap<StorageCleanupCategoryId, ReadonlySet<string>> {
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

function selectedCategoryBytes(input: {
  readonly category: StorageCleanupCategoryUsage;
  readonly selectedTargetIds?: ReadonlySet<string> | undefined;
}): number {
  if (input.selectedTargetIds && input.selectedTargetIds.size > 0) {
    return input.category.targets
      .filter((target) => input.selectedTargetIds?.has(target.id))
      .reduce((total, target) => total + target.bytes, 0);
  }
  return input.category.id === "databaseVacuum"
    ? input.category.bytes
    : input.category.reclaimableBytes;
}

function cleanupRequestRequiresTypedDelete(input: {
  readonly categories: ReadonlyArray<StorageCleanupCategoryUsage>;
  readonly targetSelections: ReadonlyMap<StorageCleanupCategoryId, ReadonlySet<string>>;
}): boolean {
  const totalBytes = input.categories.reduce(
    (total, category) =>
      total +
      selectedCategoryBytes({
        category,
        selectedTargetIds: input.targetSelections.get(category.id),
      }),
    0,
  );
  return (
    totalBytes > TYPED_CONFIRM_THRESHOLD_BYTES ||
    input.categories.some((category) => category.impact === "high")
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await FS.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileSizeIfExists(path: string): Promise<number> {
  const stat = await safeLstat(path);
  return stat?.isFile() ? stat.size : 0;
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
  return relative.length === 0 || (!relative.startsWith("..") && !Path.isAbsolute(relative));
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
    defaultSelected: input.defaultSelected,
    impact: input.impact,
    availability: disabledReason ? "disabled" : "ready",
    ...(disabledReason ? { disabledReason } : {}),
    targetCount,
    targets: [...(input.targets ?? [])],
    warnings: [...(input.warnings ?? [])],
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
    warnings: [...(input.warnings ?? [])],
    ...(input.message ? { message: input.message } : {}),
  };
}

function warningFor(path: string, reason: string): StoragePathWarning {
  return { path, reason };
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

async function listFilesWithPrefix(input: {
  readonly directory: string;
  readonly prefix: string;
}): Promise<ReadonlyArray<EnumeratedFile>> {
  if (!(await exists(input.directory))) {
    return [];
  }
  const { files } = await enumerateFiles(input.directory, { maxDepth: 1 });
  return files.filter((file) => file.name.startsWith(input.prefix));
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
      entries = await FS.readdir(directory, { withFileTypes: true });
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
  const match = /^gitdir:\s*(.+)\s*$/m.exec(gitFile);
  if (!match) {
    return null;
  }

  const gitDir = Path.resolve(targetPath, match[1]!);
  const commonDirFile = Path.join(gitDir, "commondir");
  const commonDir = (await safeLstat(commonDirFile))?.isFile()
    ? Path.resolve(gitDir, (await FS.readFile(commonDirFile, "utf8")).trim())
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
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const git = yield* GitCore;
  const eventStore = yield* OrchestrationEventStore;

  let cachedReport: {
    readonly stateDir: string;
    readonly createdAtMs: number;
    readonly report: StorageUsageReport;
  } | null = null;
  let activeNonce: UsageNonceState | null = null;
  const cancelledOperations = new Set<string>();
  let activeOperationId: string | null = null;

  const queryThreadRows = () =>
    sql<ThreadRow>`
      SELECT
        thread.thread_id AS "threadId",
        thread.project_id AS "projectId",
        thread.title AS "title",
        thread.worktree_path AS "worktreePath",
        thread.archived_at AS "archivedAt",
        thread.deleted_at AS "deletedAt",
        project.workspace_root AS "workspaceRoot"
      FROM projection_threads AS thread
      LEFT JOIN projection_projects AS project
        ON project.project_id = thread.project_id
      ORDER BY thread.thread_id ASC
    `;

  const inspectWorktreeRemovalReadiness = (input: {
    readonly targetPath: string;
    readonly metadataOperation: string;
    readonly metadataDisabledReason: string;
  }): Effect.Effect<WorktreeRemovalReadiness, never> =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const commandCwdExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => resolveWorktreeRemoveCwd(input.targetPath),
          catch: (cause) =>
            new StorageMaintenanceError({
              operation: input.metadataOperation,
              message: "Failed to resolve Git worktree metadata.",
              cause,
            }),
        }),
      );
      if (Exit.isFailure(commandCwdExit)) {
        warnings.push(warningFor(input.targetPath, Cause.pretty(commandCwdExit.cause)));
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

      const statusExit = yield* Effect.exit(git.status({ cwd: input.targetPath }));
      if (Exit.isFailure(statusExit)) {
        warnings.push(warningFor(input.targetPath, Cause.pretty(statusExit.cause)));
        return {
          commandCwd,
          disabledReason: "Git status could not be read.",
          warnings,
        };
      }
      if (statusExit.value.hasWorkingTreeChanges) {
        return {
          commandCwd,
          disabledReason: "Worktree has uncommitted changes.",
          warnings,
        };
      }
      if (statusExit.value.aheadCount > 0) {
        return {
          commandCwd,
          disabledReason: "Worktree has unpushed commits.",
          warnings,
        };
      }

      return {
        commandCwd,
        warnings,
      };
    });

  const estimateDeletedThreadDbBytes = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly bytes: number | null }>`
        WITH deleted_threads AS (
          SELECT thread_id
          FROM projection_threads
          WHERE deleted_at IS NOT NULL
        )
        SELECT
          (
            SELECT COALESCE(SUM(
              LENGTH(event_id) + LENGTH(aggregate_kind) + LENGTH(stream_id) +
              LENGTH(event_type) + LENGTH(occurred_at) +
              COALESCE(LENGTH(command_id), 0) +
              COALESCE(LENGTH(causation_event_id), 0) +
              COALESCE(LENGTH(correlation_id), 0) +
              LENGTH(actor_kind) + LENGTH(payload_json) + LENGTH(metadata_json)
            ), 0)
            FROM orchestration_events
            WHERE aggregate_kind = 'thread'
              AND stream_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(command_id) + LENGTH(aggregate_kind) + LENGTH(aggregate_id) +
              LENGTH(accepted_at) + LENGTH(status) + COALESCE(LENGTH(error), 0)), 0)
            FROM orchestration_command_receipts
            WHERE command_id IN (
              SELECT command_id
              FROM orchestration_events
              WHERE aggregate_kind = 'thread'
                AND stream_id IN (SELECT thread_id FROM deleted_threads)
                AND command_id IS NOT NULL
            )
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(diff) + LENGTH(created_at)), 0)
            FROM checkpoint_diff_blobs
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(message_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(role) + LENGTH(text) + COALESCE(LENGTH(reasoning_text), 0) +
              LENGTH(created_at) + LENGTH(updated_at)), 0)
            FROM projection_thread_messages
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(activity_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(tone) + LENGTH(kind) + LENGTH(summary) + LENGTH(payload_json) + LENGTH(created_at)), 0)
            FROM projection_thread_activities
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(command_execution_id) + LENGTH(thread_id) + LENGTH(turn_id) +
              COALESCE(LENGTH(provider_item_id), 0) + LENGTH(command) + COALESCE(LENGTH(title), 0) +
              LENGTH(status) + COALESCE(LENGTH(detail), 0) + LENGTH(output) +
              LENGTH(started_at) + COALESCE(LENGTH(completed_at), 0) + LENGTH(updated_at)), 0)
            FROM projection_thread_command_executions
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(file_change_id) + LENGTH(thread_id) + LENGTH(turn_id) +
              COALESCE(LENGTH(provider_item_id), 0) + COALESCE(LENGTH(title), 0) +
              COALESCE(LENGTH(detail), 0) + LENGTH(status) + LENGTH(changed_files) +
              LENGTH(patch) + LENGTH(started_at) + COALESCE(LENGTH(completed_at), 0) +
              LENGTH(updated_at)), 0)
            FROM projection_thread_file_changes
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(plan_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(plan_markdown) + LENGTH(created_at) + LENGTH(updated_at)), 0)
            FROM projection_thread_proposed_plans
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(status) + COALESCE(LENGTH(provider_name), 0) +
              COALESCE(LENGTH(provider_session_id), 0) + COALESCE(LENGTH(provider_thread_id), 0) +
              COALESCE(LENGTH(active_turn_id), 0) + COALESCE(LENGTH(last_error), 0) + LENGTH(updated_at)), 0)
            FROM projection_thread_sessions
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(state) + LENGTH(requested_at) +
              COALESCE(LENGTH(started_at), 0) + COALESCE(LENGTH(completed_at), 0) +
              COALESCE(LENGTH(checkpoint_ref), 0) + LENGTH(checkpoint_files_json)), 0)
            FROM projection_turns
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(
              LENGTH(turn_id) + LENGTH(thread_id) + LENGTH(project_id) + LENGTH(provider_name) +
              COALESCE(LENGTH(provider_instance_id), 0) + COALESCE(LENGTH(model), 0) +
              LENGTH(token_provenance) + LENGTH(cost_provenance) + LENGTH(completed_at) +
              LENGTH(source_event_id)
            ), 0)
            FROM projection_turn_usage_facts
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(request_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(status) + COALESCE(LENGTH(decision), 0) + LENGTH(created_at) +
              COALESCE(LENGTH(resolved_at), 0)), 0)
            FROM projection_pending_approvals
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(project_id) + LENGTH(title) + LENGTH(model) +
              COALESCE(LENGTH(branch), 0) + COALESCE(LENGTH(worktree_path), 0) +
              COALESCE(LENGTH(latest_turn_id), 0) + COALESCE(LENGTH(archived_at), 0) +
              LENGTH(created_at) + LENGTH(last_interaction_at) + LENGTH(updated_at) +
              COALESCE(LENGTH(deleted_at), 0)), 0)
            FROM projection_threads
            WHERE thread_id IN (SELECT thread_id FROM deleted_threads)
          ) AS bytes
      `;
      return clampBytes(rows[0]?.bytes ?? 0);
    });

  const estimateArchivedThreadDbBytes = (cutoffIso: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly bytes: number | null }>`
        WITH archived_threads AS (
          SELECT thread_id
          FROM projection_threads
          WHERE archived_at IS NOT NULL
            AND archived_at <= ${cutoffIso}
            AND deleted_at IS NULL
        )
        SELECT
          (
            SELECT COALESCE(SUM(
              LENGTH(event_id) + LENGTH(aggregate_kind) + LENGTH(stream_id) +
              LENGTH(event_type) + LENGTH(occurred_at) +
              COALESCE(LENGTH(command_id), 0) +
              COALESCE(LENGTH(causation_event_id), 0) +
              COALESCE(LENGTH(correlation_id), 0) +
              LENGTH(actor_kind) + LENGTH(payload_json) + LENGTH(metadata_json)
            ), 0)
            FROM orchestration_events
            WHERE aggregate_kind = 'thread'
              AND stream_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(command_id) + LENGTH(aggregate_kind) + LENGTH(aggregate_id) +
              LENGTH(accepted_at) + LENGTH(status) + COALESCE(LENGTH(error), 0)), 0)
            FROM orchestration_command_receipts
            WHERE command_id IN (
              SELECT command_id
              FROM orchestration_events
              WHERE aggregate_kind = 'thread'
                AND stream_id IN (SELECT thread_id FROM archived_threads)
                AND command_id IS NOT NULL
            )
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(diff) + LENGTH(created_at)), 0)
            FROM checkpoint_diff_blobs
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(message_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(role) + LENGTH(text) + COALESCE(LENGTH(reasoning_text), 0) +
              LENGTH(created_at) + LENGTH(updated_at)), 0)
            FROM projection_thread_messages
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(activity_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(tone) + LENGTH(kind) + LENGTH(summary) + LENGTH(payload_json) + LENGTH(created_at)), 0)
            FROM projection_thread_activities
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(command_execution_id) + LENGTH(thread_id) + LENGTH(turn_id) +
              COALESCE(LENGTH(provider_item_id), 0) + LENGTH(command) + COALESCE(LENGTH(title), 0) +
              LENGTH(status) + COALESCE(LENGTH(detail), 0) + LENGTH(output) +
              LENGTH(started_at) + COALESCE(LENGTH(completed_at), 0) + LENGTH(updated_at)), 0)
            FROM projection_thread_command_executions
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(file_change_id) + LENGTH(thread_id) + LENGTH(turn_id) +
              COALESCE(LENGTH(provider_item_id), 0) + COALESCE(LENGTH(title), 0) +
              COALESCE(LENGTH(detail), 0) + LENGTH(status) + LENGTH(changed_files) +
              LENGTH(patch) + LENGTH(started_at) + COALESCE(LENGTH(completed_at), 0) +
              LENGTH(updated_at)), 0)
            FROM projection_thread_file_changes
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(plan_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(plan_markdown) + LENGTH(created_at) + LENGTH(updated_at)), 0)
            FROM projection_thread_proposed_plans
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(status) + COALESCE(LENGTH(provider_name), 0) +
              COALESCE(LENGTH(provider_session_id), 0) + COALESCE(LENGTH(provider_thread_id), 0) +
              COALESCE(LENGTH(active_turn_id), 0) + COALESCE(LENGTH(last_error), 0) + LENGTH(updated_at)), 0)
            FROM projection_thread_sessions
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(state) + LENGTH(requested_at) +
              COALESCE(LENGTH(started_at), 0) + COALESCE(LENGTH(completed_at), 0) +
              COALESCE(LENGTH(checkpoint_ref), 0) + LENGTH(checkpoint_files_json)), 0)
            FROM projection_turns
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(
              LENGTH(turn_id) + LENGTH(thread_id) + LENGTH(project_id) + LENGTH(provider_name) +
              COALESCE(LENGTH(provider_instance_id), 0) + COALESCE(LENGTH(model), 0) +
              LENGTH(token_provenance) + LENGTH(cost_provenance) + LENGTH(completed_at) +
              LENGTH(source_event_id)
            ), 0)
            FROM projection_turn_usage_facts
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(request_id) + LENGTH(thread_id) + COALESCE(LENGTH(turn_id), 0) +
              LENGTH(status) + COALESCE(LENGTH(decision), 0) + LENGTH(created_at) +
              COALESCE(LENGTH(resolved_at), 0)), 0)
            FROM projection_pending_approvals
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) +
          (
            SELECT COALESCE(SUM(LENGTH(thread_id) + LENGTH(project_id) + LENGTH(title) + LENGTH(model) +
              COALESCE(LENGTH(branch), 0) + COALESCE(LENGTH(worktree_path), 0) +
              COALESCE(LENGTH(latest_turn_id), 0) + COALESCE(LENGTH(archived_at), 0) +
              LENGTH(created_at) + LENGTH(last_interaction_at) + LENGTH(updated_at) +
              COALESCE(LENGTH(deleted_at), 0)), 0)
            FROM projection_threads
            WHERE thread_id IN (SELECT thread_id FROM archived_threads)
          ) AS bytes
      `;
      return clampBytes(rows[0]?.bytes ?? 0);
    });

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
        const segment = threadToSegment.get(threadId);
        if (segment) {
          busySegments.add(segment);
        }
      }
      return busySegments;
    });

  const computeProviderLogCandidates = (allThreads: ReadonlyArray<ThreadRow>) =>
    Effect.gen(function* () {
      const aliveSegments = new Set(
        allThreads
          .filter(isActiveStorageThread)
          .map((thread) => toSafeThreadAttachmentSegment(thread.threadId))
          .filter((segment): segment is string => segment !== null),
      );
      const busySegments = yield* readBusyThreadSegments(allThreads);
      const { files, warnings } = yield* Effect.tryPromise({
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

  const computeEventsLogRotationCandidates = () =>
    Effect.tryPromise({
      try: async () => {
        const { files, warnings } = await listProviderLogFiles(config.providerLogsDir);
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

  const computeVacuumReclaimableBytes = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly pageSize: number }>`PRAGMA page_size`;
      const freeRows = yield* sql<{ readonly freelistCount: number }>`PRAGMA freelist_count`;
      return clampBytes((rows[0]?.pageSize ?? 0) * (freeRows[0]?.freelistCount ?? 0));
    }).pipe(Effect.catch(() => Effect.succeed(0)));

  const computeF5WorktreeTargets = () =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const allThreads = yield* queryThreadRows();
      const listed = yield* Effect.tryPromise({
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

      const targets: StorageCleanupTarget[] = [];
      for (const targetPath of listed.paths) {
        const usageExit = yield* Effect.exit(
          Effect.tryPromise({
            try: () => recursiveSize(targetPath),
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
          warnings.push(warningFor(targetPath, Cause.pretty(usageExit.cause)));
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
          });
          warnings.push(...readiness.warnings);
          disabledReason = readiness.disabledReason;
        }

        const relativeLabel = Path.relative(config.worktreesDir, targetPath);
        targets.push({
          id: targetPath,
          label: relativeLabel.length > 0 ? relativeLabel : Path.basename(targetPath),
          path: targetPath,
          bytes,
          safeToDelete: disabledReason === undefined,
          ...(disabledReason ? { disabledReason } : {}),
          detail:
            archivedReferences.length > 0
              ? `Referenced by ${archivedReferences.length} archived thread${
                  archivedReferences.length === 1 ? "" : "s"
                }.`
              : "Orphaned F5 worktree.",
        });
      }

      return { targets, warnings };
    });

  const enrichLegacyWorktreeTargets = (
    probe: LegacyProbeResult,
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
        if (readiness.disabledReason === GIT_WORKTREE_METADATA_UNRESOLVED) {
          enrichedTargets.push({
            ...target,
            detail: LEGACY_WORKTREE_DIRECT_DELETE_DETAIL,
          });
          continue;
        }
        warnings.push(...readiness.warnings);
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

  const buildReport = (force: boolean) =>
    Effect.gen(function* () {
      const nowMs = Date.now();
      if (
        !force &&
        cachedReport &&
        cachedReport.stateDir === config.stateDir &&
        nowMs - cachedReport.createdAtMs < USAGE_CACHE_TTL_MS &&
        activeNonce &&
        !activeNonce.used &&
        activeNonce.expiresAtMs > nowMs
      ) {
        return cachedReport.report;
      }

      const warnings: StoragePathWarning[] = [];
      const allThreads = yield* queryThreadRows();
      const archivedThreadCutoffIso = new Date(nowMs - ARCHIVED_THREAD_RETENTION_MS).toISOString();
      const deletedThreads = allThreads.filter((thread) => thread.deletedAt !== null);
      const busySegments = yield* readBusyThreadSegments(allThreads);
      const purgeDeletedThreadCandidates = deletedThreads.filter((thread) => {
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        return segment === null || !busySegments.has(segment);
      });
      const purgeArchivedThreadCandidates = allThreads.filter((thread) => {
        if (
          thread.deletedAt !== null ||
          thread.archivedAt === null ||
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

      const stateUsage = yield* Effect.tryPromise({
        try: () => sizeIfExists(config.stateDir),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.stateDir",
            message: "Failed to inspect F5 state directory.",
            cause,
          }),
      });
      warnings.push(...stateUsage.errors);

      const databaseBytes = yield* Effect.tryPromise({
        try: async () =>
          (await fileSizeIfExists(config.dbPath)) +
          (await fileSizeIfExists(`${config.dbPath}-wal`)) +
          (await fileSizeIfExists(`${config.dbPath}-shm`)) +
          (await fileSizeIfExists(`${config.dbPath}-journal`)),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.database",
            message: "Failed to inspect database files.",
            cause,
          }),
      });
      const logsUsage = yield* Effect.tryPromise({
        try: () => sizeIfExists(config.logsDir),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.logs",
            message: "Failed to inspect logs directory.",
            cause,
          }),
      });
      warnings.push(...logsUsage.errors);
      const attachmentsUsage = yield* Effect.tryPromise({
        try: () => sizeIfExists(config.attachmentsDir),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.attachments",
            message: "Failed to inspect attachments directory.",
            cause,
          }),
      });
      warnings.push(...attachmentsUsage.errors);
      const orphanAttachmentRows = yield* sql<OrphanAttachmentRow>`
        SELECT
          attachment.attachment_id AS "attachmentId",
          attachment.name AS "name",
          attachment.final_path AS "finalPath"
        FROM attachments AS attachment
        WHERE NOT EXISTS (
          SELECT 1
          FROM attachment_owners AS owner
          WHERE owner.attachment_id = attachment.attachment_id
        )
        ORDER BY attachment.created_at ASC
      `;
      const orphanAttachmentTargets = yield* Effect.forEach(
        orphanAttachmentRows,
        (attachment) =>
          Effect.tryPromise({
            try: () => fileSizeIfExists(attachment.finalPath),
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
      const worktreesUsage = yield* Effect.tryPromise({
        try: () => sizeIfExists(config.worktreesDir),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.worktrees",
            message: "Failed to inspect F5 worktrees directory.",
            cause,
          }),
      });
      warnings.push(...worktreesUsage.errors);

      const liveWorktreePaths = new Set(
        allThreads
          .filter((thread) => isActiveStorageThread(thread) && thread.worktreePath !== null)
          .map((thread) => Path.resolve(thread.worktreePath!)),
      );
      const legacyProbe = yield* Effect.tryPromise({
        try: () => probeLegacyState({ config, liveWorktreePaths }),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.legacy",
            message: "Failed to inspect legacy T3/F5 state.",
            cause,
          }),
      }).pipe(Effect.flatMap(enrichLegacyWorktreeTargets));
      warnings.push(...legacyProbe.warnings);

      const deletedDbBytes = yield* estimateDeletedThreadDbBytes();
      const deletedSegments = new Set(
        purgeDeletedThreadCandidates
          .map((thread) => toSafeThreadAttachmentSegment(thread.threadId))
          .filter((segment): segment is string => segment !== null),
      );
      const deletedThreadAttachmentFiles = yield* Effect.tryPromise({
        try: async () => {
          const files: EnumeratedFile[] = [];
          for (const segment of deletedSegments) {
            files.push(
              ...(await listFilesWithPrefix({
                directory: config.attachmentsDir,
                prefix: `${segment}-`,
              })),
            );
          }
          return files;
        },
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.deletedThreadAttachments",
            message: "Failed to inspect deleted-thread attachments.",
            cause,
          }),
      });
      const archivedSegments = new Set(
        purgeArchivedThreadCandidates
          .map((thread) => toSafeThreadAttachmentSegment(thread.threadId))
          .filter((segment): segment is string => segment !== null),
      );
      const archivedThreadAttachmentFiles = yield* Effect.tryPromise({
        try: async () => {
          const files: EnumeratedFile[] = [];
          for (const segment of archivedSegments) {
            files.push(
              ...(await listFilesWithPrefix({
                directory: config.attachmentsDir,
                prefix: `${segment}-`,
              })),
            );
          }
          return files;
        },
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.inspect.archivedThreadAttachments",
            message: "Failed to inspect archived-thread attachments.",
            cause,
          }),
      });
      const providerLogCandidates = yield* computeProviderLogCandidates(allThreads);
      warnings.push(...providerLogCandidates.warnings);
      const eventsRotationCandidates = yield* computeEventsLogRotationCandidates();
      warnings.push(...eventsRotationCandidates.warnings);
      const f5WorktreeCandidates = yield* computeF5WorktreeTargets();
      warnings.push(...f5WorktreeCandidates.warnings);
      const vacuumBytes = yield* computeVacuumReclaimableBytes();
      const archivedDbBytes = yield* estimateArchivedThreadDbBytes(archivedThreadCutoffIso);

      const deletedProviderLogBytes = providerLogCandidates.files
        .filter((file) => deletedSegments.has(file.segment))
        .reduce((total, file) => total + file.bytes, 0);
      const archivedProviderLogBytes = providerLogCandidates.files
        .filter((file) => archivedSegments.has(file.segment))
        .reduce((total, file) => total + file.bytes, 0);
      const purgeDeletedBytes =
        deletedDbBytes +
        deletedThreadAttachmentFiles.reduce((total, file) => total + file.bytes, 0) +
        deletedProviderLogBytes;
      const purgeArchivedBytes =
        archivedDbBytes +
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
            label: thread.threadId,
            bytes: 0,
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
            bytes: 0,
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
            "Removes clean F5 worktrees that are orphaned or referenced only by archived threads.",
          bytes: worktreesUsage.bytes,
          reclaimableBytes: f5WorktreeReclaimableBytes,
          defaultSelected: false,
          impact: "high",
          targets: f5WorktreeCandidates.targets,
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
          defaultSelected: true,
          impact: "none",
          targets: orphanAttachmentTargets,
        }),
      ];

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

      const readyCategoryIds = categories
        .filter((category) => category.availability === "ready")
        .map((category) => category.id);
      const scanId = Crypto.randomUUID();
      const confirmationNonce = Crypto.randomUUID();
      const nonceExpiresAtMs = nowMs + NONCE_TTL_MS;
      activeNonce = {
        scanId,
        nonce: confirmationNonce,
        expiresAtMs: nonceExpiresAtMs,
        categories: new Map(
          categories
            .filter((category) => readyCategoryIds.includes(category.id))
            .map((category) => [category.id, category]),
        ),
        used: false,
      };

      const report: StorageUsageReport = {
        scanId,
        confirmationNonce,
        nonceExpiresAt: new Date(nonceExpiresAtMs).toISOString(),
        scannedAt: nowIso(),
        stateDir: config.stateDir,
        totalUsedBytes: sumNonOverlappingPathUsages([
          { path: config.stateDir, bytes: stateUsage.bytes },
          { path: config.worktreesDir, bytes: worktreesUsage.bytes },
          { path: legacyT3BaseDir(), bytes: legacyProbe.bytes },
        ]),
        reclaimableBytes: categories.reduce(
          (total, category) => total + category.reclaimableBytes,
          0,
        ),
        databaseBytes,
        worktreesBytes: worktreesUsage.bytes,
        logsBytes: logsUsage.bytes,
        attachmentsBytes: attachmentsUsage.bytes,
        legacyBytes: legacyProbe.bytes,
        threadCount: allThreads.length,
        archivedThreadCount,
        deletedThreadCount: deletedThreads.length,
        providerLogSegmentCount: providerLogCandidates.segmentCount,
        envOverrideActive: legacyProbe.envOverrideActive,
        ...(legacyProbe.disabledReason
          ? { legacyCleanupDisabledReason: legacyProbe.disabledReason }
          : {}),
        categories,
        warnings,
      };
      cachedReport = { stateDir: config.stateDir, createdAtMs: nowMs, report };
      return report;
    });

  const inspect: StorageMaintenanceShape["inspect"] = (request = {}) =>
    buildReport(request.force ?? false).pipe(
      Effect.mapError(toStorageMaintenanceError("StorageMaintenance.inspect")),
    );

  const validateCleanupRequest = (request: StorageCleanupRequest) =>
    Effect.gen(function* () {
      const nonce = activeNonce;
      if (!nonce) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: "Run storage.getUsage before starting cleanup.",
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
      if (nonce.scanId !== request.scanId || nonce.nonce !== request.confirmationNonce) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: "The storage cleanup confirmation nonce does not match the current scan.",
        });
      }
      const requested = uniqueCategoryIds(request.categoryIds);
      const rejected = requested.find((categoryId) => !nonce.categories.has(categoryId));
      if (rejected) {
        return yield* new StorageMaintenanceError({
          operation: "StorageMaintenance.cleanup.validate",
          message: `Storage cleanup category '${rejected}' is not available for this scan.`,
        });
      }
      const targetSelections = normalizeTargetSelections(request.targetSelections);
      for (const [categoryId, selectedTargetIds] of targetSelections) {
        if (categoryId !== "legacyT3Worktrees" && categoryId !== "inactiveF5Worktrees") {
          return yield* new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.validate",
            message: `Storage cleanup target selection is not supported for '${categoryId}'.`,
          });
        }
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
          (categoryId === "legacyT3Worktrees" || categoryId === "inactiveF5Worktrees") &&
          !targetSelections.has(categoryId)
        ) {
          return yield* new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.validate",
            message: `${categoryId} cleanup requires explicit target selection.`,
          });
        }
      }
      const requestedCategories = requested.map((categoryId) => nonce.categories.get(categoryId)!);
      if (
        cleanupRequestRequiresTypedDelete({
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
      nonce.used = true;
      cachedReport = null;
      return {
        categoryIds: requested,
        requestedCategories,
        targetSelections,
      };
    });

  const publishProgress = (
    request: StorageCleanupRequest,
    context: StorageCleanupContext | undefined,
    event: Omit<StorageCleanupProgressPayload, "operationId">,
  ) =>
    (context?.publishProgress ?? (() => Effect.void))({
      operationId: request.operationId,
      ...event,
    });

  const checkCancelled = (operationId: string) => cancelledOperations.has(operationId);

  const deleteProviderLogFiles = (
    request: StorageCleanupRequest,
    context: StorageCleanupContext | undefined,
    categoryId: StorageCleanupCategoryId,
    files: ReadonlyArray<EnumeratedFile>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const warnings: StoragePathWarning[] = [];
        const perTargetReclaimed: PerTargetReclaimed = [];
        let completedTargets = 0;
        for (const file of files) {
          if (checkCancelled(request.operationId)) {
            break;
          }
          await Effect.runPromise(
            publishProgress(request, context, {
              categoryId,
              phase: "deleting",
              message: `Deleting ${file.name}`,
              completedTargets,
              totalTargets: files.length,
            }),
          );
          const deletion = await removeFileIfSafe({
            path: file.path,
            allowedRoot: config.providerLogsDir,
          });
          if (deletion.warning) {
            warnings.push(deletion.warning);
          }
          if (deletion.reclaimedBytes > 0) {
            perTargetReclaimed.push({
              id: file.path,
              path: file.path,
              reclaimedBytes: deletion.reclaimedBytes,
            });
          }
          completedTargets += 1;
        }
        return resultFor({
          categoryId,
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
          operation: `StorageMaintenance.cleanup.${categoryId}`,
          message: "Failed to prune provider logs.",
          cause,
        }),
    });

  const purgeDeletedThreads = (
    request: StorageCleanupRequest,
    context?: StorageCleanupContext,
    input?: {
      readonly categoryId?: StorageCleanupCategoryId;
      readonly threadIds?: ReadonlyArray<ThreadId>;
      readonly warnings?: ReadonlyArray<StoragePathWarning>;
    },
  ) =>
    Effect.gen(function* () {
      const categoryId = input?.categoryId ?? "purgeDeletedThreads";
      const selectedThreadIds =
        input?.threadIds !== undefined ? new Set<ThreadId>(input.threadIds) : null;
      if (selectedThreadIds !== null && selectedThreadIds.size === 0) {
        return resultFor({
          categoryId,
          status: "Skipped",
          ...(input?.warnings ? { warnings: input.warnings } : {}),
          message: "No threads were eligible for purge.",
        });
      }
      const warnings: StoragePathWarning[] = [...(input?.warnings ?? [])];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const allThreads = yield* queryThreadRows();
      const busySegments = yield* readBusyThreadSegments(allThreads);
      const allDeletedThreads = allThreads.filter(
        (thread) =>
          thread.deletedAt !== null &&
          (selectedThreadIds === null || selectedThreadIds.has(thread.threadId)),
      );
      const deletedThreads = allDeletedThreads.filter((thread) => {
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        return segment === null || !busySegments.has(segment);
      });
      for (const thread of allDeletedThreads) {
        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        if (segment !== null && busySegments.has(segment)) {
          warnings.push(
            warningFor(
              thread.threadId,
              "Skipped thread because its provider session is currently busy.",
            ),
          );
        }
      }
      const survivingSegments = new Set(
        allThreads
          .filter(isActiveStorageThread)
          .map((thread) => toSafeThreadAttachmentSegment(thread.threadId))
          .filter((segment): segment is string => segment !== null),
      );
      const deletedDbBytes = yield* estimateDeletedThreadDbBytes();
      const estimatedDbBytesPerThread =
        deletedThreads.length > 0 ? Math.floor(deletedDbBytes / deletedThreads.length) : 0;
      let completedTargets = 0;

      for (const thread of deletedThreads) {
        if (checkCancelled(request.operationId)) {
          break;
        }
        yield* publishProgress(request, context, {
          categoryId,
          phase: "purging",
          message: `Purging deleted thread ${thread.threadId}`,
          completedTargets,
          totalTargets: deletedThreads.length,
        });

        const stopExit = yield* Effect.exit(
          providerService.stopSession({ threadId: thread.threadId }),
        );
        if (Exit.isFailure(stopExit)) {
          warnings.push(
            warningFor(
              thread.threadId,
              `Skipped thread because its provider session could not be stopped: ${Cause.pretty(
                stopExit.cause,
              )}`,
            ),
          );
          completedTargets += 1;
          continue;
        }

        const checkpointRows = yield* sql<{ readonly checkpointRef: CheckpointRef }>`
          SELECT DISTINCT checkpoint_ref AS "checkpointRef"
          FROM projection_turns
          WHERE thread_id = ${thread.threadId}
            AND checkpoint_ref IS NOT NULL
        `;
        const cwd = thread.worktreePath ?? thread.workspaceRoot ?? undefined;
        if (checkpointRows.length > 0 && !cwd) {
          warnings.push(
            warningFor(
              thread.threadId,
              "Skipped thread because checkpoint refs exist but no workspace path is available.",
            ),
          );
          completedTargets += 1;
          continue;
        }
        if (checkpointRows.length > 0 && cwd) {
          const checkpointExit = yield* Effect.exit(
            checkpointStore.deleteCheckpointRefs({
              cwd,
              checkpointRefs: checkpointRows.map((row) => row.checkpointRef),
            }),
          );
          if (Exit.isFailure(checkpointExit)) {
            warnings.push(
              warningFor(
                thread.threadId,
                `Skipped thread because checkpoint refs could not be deleted: ${String(
                  Cause.pretty(checkpointExit.cause),
                )}`,
              ),
            );
            completedTargets += 1;
            continue;
          }
        }

        const usageCoverageResumesAt = nowIso();
        const transactionExit = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              const commandIds: ReadonlyArray<CommandId> =
                yield* eventStore.collectCommandIdsForThread(thread.threadId);
              yield* sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_thread_command_executions WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_thread_file_changes WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_pending_approvals WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_turns WHERE thread_id = ${thread.threadId}`;
              yield* sql`DELETE FROM projection_turn_usage_facts WHERE thread_id = ${thread.threadId}`;
              yield* sql`
                UPDATE projection_usage_metadata
                SET coverage_started_at = CASE
                  WHEN coverage_started_at < ${usageCoverageResumesAt}
                    THEN ${usageCoverageResumesAt}
                  ELSE coverage_started_at
                END
                WHERE singleton_id = 1
              `;
              yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${thread.threadId}`;
              for (const commandId of commandIds) {
                yield* sql`
                  DELETE FROM orchestration_command_receipts
                  WHERE command_id = ${commandId}
                `;
              }
              yield* eventStore.deleteForThreadStream(thread.threadId);
              yield* sql`DELETE FROM projection_threads WHERE thread_id = ${thread.threadId}`;
            }),
          ),
        );
        if (Exit.isFailure(transactionExit)) {
          warnings.push(
            warningFor(
              thread.threadId,
              `Skipped thread because SQL cleanup failed: ${Cause.pretty(transactionExit.cause)}`,
            ),
          );
          completedTargets += 1;
          continue;
        }

        const segment = toSafeThreadAttachmentSegment(thread.threadId);
        let fsReclaimed = 0;
        if (segment && !survivingSegments.has(segment)) {
          const attachmentFiles = yield* Effect.tryPromise({
            try: () =>
              listFilesWithPrefix({
                directory: config.attachmentsDir,
                prefix: `${segment}-`,
              }),
            catch: (cause) =>
              new StorageMaintenanceError({
                operation: "StorageMaintenance.cleanup.purgeDeletedThreads.attachments",
                message: "Failed to list deleted-thread attachments.",
                cause,
              }),
          });
          for (const file of attachmentFiles) {
            const deletion = yield* Effect.tryPromise({
              try: () => removeFileIfSafe({ path: file.path, allowedRoot: config.attachmentsDir }),
              catch: (cause) =>
                new StorageMaintenanceError({
                  operation: "StorageMaintenance.cleanup.purgeDeletedThreads.attachment",
                  message: "Failed to delete a deleted-thread attachment.",
                  cause,
                }),
            });
            if (deletion.warning) {
              warnings.push(deletion.warning);
            }
            fsReclaimed += deletion.reclaimedBytes;
          }

          if (!survivingSegments.has(segment)) {
            const providerLogs = yield* Effect.tryPromise({
              try: () =>
                listFilesWithPrefix({
                  directory: config.providerLogsDir,
                  prefix: `${segment}.log`,
                }),
              catch: (cause) =>
                new StorageMaintenanceError({
                  operation: "StorageMaintenance.cleanup.purgeDeletedThreads.providerLogs",
                  message: "Failed to list deleted-thread provider logs.",
                  cause,
                }),
            });
            for (const file of providerLogs) {
              const deletion = yield* Effect.tryPromise({
                try: () =>
                  removeFileIfSafe({ path: file.path, allowedRoot: config.providerLogsDir }),
                catch: (cause) =>
                  new StorageMaintenanceError({
                    operation: "StorageMaintenance.cleanup.purgeDeletedThreads.providerLog",
                    message: "Failed to delete a deleted-thread provider log.",
                    cause,
                  }),
              });
              if (deletion.warning) {
                warnings.push(deletion.warning);
              }
              fsReclaimed += deletion.reclaimedBytes;
            }
          }
        }

        perTargetReclaimed.push({
          id: thread.threadId,
          reclaimedBytes: fsReclaimed + estimatedDbBytesPerThread,
        });
        completedTargets += 1;
      }

      const reclaimedBytes = perTargetReclaimed.reduce(
        (total, target) => total + target.reclaimedBytes,
        0,
      );
      return resultFor({
        categoryId,
        status: reclaimedBytes > 0 ? "Cleaned" : "Skipped",
        reclaimedBytes,
        perTargetReclaimed,
        warnings,
      });
    });

  const pruneProviderLogsForTerminalThreads = (
    request: StorageCleanupRequest,
    context?: StorageCleanupContext,
  ) =>
    Effect.gen(function* () {
      const allThreads = yield* queryThreadRows();
      const candidates = yield* computeProviderLogCandidates(allThreads);
      return yield* deleteProviderLogFiles(
        request,
        context,
        "providerLogsForTerminalThreads",
        candidates.files,
      );
    });

  const pruneEventsLogRotations = (
    request: StorageCleanupRequest,
    context?: StorageCleanupContext,
  ) =>
    Effect.gen(function* () {
      const candidates = yield* computeEventsLogRotationCandidates();
      return yield* deleteProviderLogFiles(
        request,
        context,
        "providerLogRotations",
        candidates.files,
      );
    });

  const dispatchArchivedThreadDeletes = (
    request: StorageCleanupRequest,
    context: StorageCleanupContext | undefined,
    category: StorageCleanupCategoryUsage | undefined,
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const deletedThreadIds: ThreadId[] = [];
      if (!category) {
        return { deletedThreadIds, warnings };
      }

      const cutoffIso = new Date(Date.now() - ARCHIVED_THREAD_RETENTION_MS).toISOString();
      let completedTargets = 0;
      for (const target of category.targets) {
        if (checkCancelled(request.operationId)) {
          break;
        }
        yield* publishProgress(request, context, {
          categoryId: "purgeArchivedThreads",
          phase: "deleting",
          message: `Deleting archived thread ${target.label}`,
          completedTargets,
          totalTargets: category.targets.length,
        });

        const threadId = ThreadId.makeUnsafe(target.id);
        const rows = yield* sql<{
          readonly threadId: ThreadId;
          readonly archivedAt: string | null;
          readonly deletedAt: string | null;
        }>`
          SELECT
            thread_id AS "threadId",
            archived_at AS "archivedAt",
            deleted_at AS "deletedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        const row = rows[0];
        if (!row) {
          warnings.push(
            warningFor(target.id, "Skipped because the archived thread no longer exists."),
          );
          completedTargets += 1;
          continue;
        }
        if (row.deletedAt !== null) {
          deletedThreadIds.push(row.threadId);
          completedTargets += 1;
          continue;
        }
        if (row.archivedAt === null || row.archivedAt > cutoffIso) {
          warnings.push(
            warningFor(
              row.threadId,
              "Skipped because the thread is no longer an old archived thread.",
            ),
          );
          completedTargets += 1;
          continue;
        }

        const deleteExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.makeUnsafe(
              `server:storage-archived-delete:${Crypto.randomUUID()}`,
            ),
            threadId: row.threadId,
            expectedArchivedAt: row.archivedAt,
          }),
        );
        if (Exit.isFailure(deleteExit)) {
          warnings.push(
            warningFor(
              row.threadId,
              `Skipped because guarded thread delete failed: ${Cause.pretty(deleteExit.cause)}`,
            ),
          );
          completedTargets += 1;
          continue;
        }

        deletedThreadIds.push(row.threadId);
        completedTargets += 1;
      }

      return { deletedThreadIds, warnings };
    });

  const clearArchivedWorktreeReferences = (
    request: StorageCleanupRequest,
    context: StorageCleanupContext | undefined,
    category: StorageCleanupCategoryUsage | undefined,
    selectedTargetIds: ReadonlySet<string> | undefined,
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      if (!category || !selectedTargetIds || selectedTargetIds.size === 0) {
        return warnings;
      }

      const selectedTargets = category.targets.filter(
        (target) => selectedTargetIds.has(target.id) && target.safeToDelete && target.path,
      );
      const allThreads = yield* queryThreadRows();
      let completedTargets = 0;
      for (const target of selectedTargets) {
        const targetPath = target.path;
        if (!targetPath || checkCancelled(request.operationId)) {
          break;
        }
        yield* publishProgress(request, context, {
          categoryId: "inactiveF5Worktrees",
          phase: "unlinking",
          message: `Clearing archived references for ${target.label}`,
          completedTargets,
          totalTargets: selectedTargets.length,
        });

        const archivedReferences = allThreads.filter(
          (thread) =>
            thread.deletedAt === null &&
            thread.archivedAt !== null &&
            thread.worktreePath !== null &&
            pathsOverlap(targetPath, thread.worktreePath),
        );
        for (const thread of archivedReferences) {
          const clearExit = yield* Effect.exit(
            engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe(
                `server:storage-worktree-clear:${Crypto.randomUUID()}`,
              ),
              threadId: thread.threadId,
              worktreePath: null,
              expectedArchivedAt: thread.archivedAt!,
              expectedWorktreePath: thread.worktreePath,
            }),
          );
          if (Exit.isFailure(clearExit)) {
            warnings.push(
              warningFor(
                targetPath,
                `Skipped reference clear for ${thread.threadId}: ${Cause.pretty(clearExit.cause)}`,
              ),
            );
          }
        }
        completedTargets += 1;
      }

      return warnings;
    });

  const cleanF5Worktrees = (
    request: StorageCleanupRequest,
    context: StorageCleanupContext | undefined,
    selectedTargetIds: ReadonlySet<string> | undefined,
    preflightWarnings: ReadonlyArray<StoragePathWarning>,
  ) =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [...preflightWarnings];
      const perTargetReclaimed: PerTargetReclaimed = [];
      const candidates = yield* computeF5WorktreeTargets();
      warnings.push(...candidates.warnings);
      const targets =
        selectedTargetIds && selectedTargetIds.size > 0
          ? candidates.targets.filter((target) => selectedTargetIds.has(target.id))
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

        const allThreads = yield* queryThreadRows();
        const remainingReferences = allThreads.filter(
          (thread) =>
            thread.deletedAt === null &&
            thread.worktreePath !== null &&
            pathsOverlap(targetPath, thread.worktreePath),
        );
        if (remainingReferences.length > 0) {
          warnings.push(
            warningFor(targetPath, "Skipped because a thread still references this worktree."),
          );
          completedTargets += 1;
          continue;
        }

        const readiness = yield* inspectWorktreeRemovalReadiness({
          targetPath,
          metadataOperation: "StorageMaintenance.cleanup.inactiveF5Worktrees.cwd",
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

        const before = yield* Effect.tryPromise({
          try: () => recursiveSize(targetPath),
          catch: (cause) =>
            new StorageMaintenanceError({
              operation: "StorageMaintenance.cleanup.inactiveF5Worktrees.size",
              message: "Failed to size F5 worktree before deletion.",
              cause,
            }),
        });
        const removeExit = yield* Effect.exit(
          git.removeWorktree({
            cwd: readiness.commandCwd,
            path: targetPath,
            force: false,
          }),
        );
        if (Exit.isFailure(removeExit)) {
          warnings.push(
            warningFor(targetPath, `git worktree remove failed: ${Cause.pretty(removeExit.cause)}`),
          );
          completedTargets += 1;
          continue;
        }

        perTargetReclaimed.push({
          id: target.id,
          path: targetPath,
          reclaimedBytes: before.bytes,
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
    request: StorageCleanupRequest,
    context: StorageCleanupContext | undefined,
    selectedTargetIds: ReadonlySet<string> | undefined,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<OrphanAttachmentRow>`
        SELECT
          attachment.attachment_id AS "attachmentId",
          attachment.name AS "name",
          attachment.final_path AS "finalPath"
        FROM attachments AS attachment
        WHERE NOT EXISTS (
          SELECT 1
          FROM attachment_owners AS owner
          WHERE owner.attachment_id = attachment.attachment_id
        )
        ORDER BY attachment.created_at ASC
      `;
      const candidates =
        selectedTargetIds && selectedTargetIds.size > 0
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

        const bytes = yield* Effect.tryPromise({
          try: () => fileSizeIfExists(attachment.finalPath),
          catch: (cause) =>
            new StorageMaintenanceError({
              operation: "StorageMaintenance.cleanup.orphanAttachments.stat",
              message: "Failed to inspect an orphaned attachment.",
              cause,
            }),
        });
        const marked = yield* sql.withTransaction(
          Effect.gen(function* () {
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
          warnings.push(
            warningFor(
              attachment.finalPath,
              "Skipped attachment because it gained a live owner during cleanup.",
            ),
          );
          completedTargets += 1;
          continue;
        }

        const deletion = yield* Effect.exit(
          Effect.tryPromise({
            try: () =>
              removeFileIfSafe({
                path: attachment.finalPath,
                allowedRoot: config.attachmentsDir,
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
          warnings.push(warningFor(attachment.finalPath, Cause.pretty(deletion.cause)));
          yield* sql`
            UPDATE attachment_cleanup_jobs
            SET attempt = attempt + 1, last_error = ${Cause.pretty(deletion.cause)},
                updated_at = ${nowIso()}
            WHERE attachment_id = ${attachment.attachmentId}
          `;
          completedTargets += 1;
          continue;
        }
        if (deletion.value.warning) warnings.push(deletion.value.warning);
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
          reclaimedBytes: Math.max(bytes, deletion.value.reclaimedBytes),
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

  const vacuumDatabase = () =>
    Effect.gen(function* () {
      const warnings: StoragePathWarning[] = [];
      const beforeBytes = yield* Effect.tryPromise({
        try: () => fileSizeIfExists(config.dbPath),
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
      const freeSpace = yield* Effect.tryPromise({
        try: async () => {
          const stat = await statfs(Path.dirname(config.dbPath));
          return stat.bavail * stat.bsize;
        },
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.databaseVacuum.statfs",
            message: "Failed to inspect free disk space before database compaction.",
            cause,
          }),
      });
      if (freeSpace < beforeBytes * 1.2) {
        return resultFor({
          categoryId: "databaseVacuum",
          status: "Skipped",
          warnings: [
            warningFor(
              config.dbPath,
              "Skipped VACUUM because available disk space is below 1.2x database size.",
            ),
          ],
          message: "Not enough free disk space to compact the database.",
        });
      }
      yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
      yield* sql`VACUUM`;
      const afterBytes = yield* Effect.tryPromise({
        try: () => fileSizeIfExists(config.dbPath),
        catch: (cause) =>
          new StorageMaintenanceError({
            operation: "StorageMaintenance.cleanup.databaseVacuum.statAfter",
            message: "Failed to stat database after compaction.",
            cause,
          }),
      });
      const reclaimedBytes = Math.max(0, beforeBytes - afterBytes);
      if (reclaimedBytes === 0) {
        warnings.push(
          warningFor(config.dbPath, "Database compaction completed with no file-size reduction."),
        );
      }
      return resultFor({
        categoryId: "databaseVacuum",
        status: "Cleaned",
        reclaimedBytes,
        warnings,
      });
    });

  const cleanLegacyCategory = (
    request: StorageCleanupRequest,
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
        selectedTargetIds && selectedTargetIds.size > 0
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
          const removeDirectly = readiness.disabledReason === GIT_WORKTREE_METADATA_UNRESOLVED;
          if (!removeDirectly) {
            warnings.push(...readiness.warnings);
          }
          if (!removeDirectly && (readiness.disabledReason || !readiness.commandCwd)) {
            warnings.push(
              warningFor(targetPath, readiness.disabledReason ?? GIT_WORKTREE_METADATA_UNRESOLVED),
            );
            completedTargets += 1;
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
          if (removeDirectly) {
            const deletion = yield* Effect.tryPromise({
              try: () =>
                removeTreeIfSafe({
                  path: targetPath,
                  allowedRoot,
                  recursive: true,
                }),
              catch: (cause) =>
                new StorageMaintenanceError({
                  operation: "StorageMaintenance.cleanup.legacyT3Worktrees.directDelete",
                  message: "Failed to delete legacy worktree directory.",
                  cause,
                }),
            });
            if (deletion.warning) {
              warnings.push(deletion.warning);
            } else {
              perTargetReclaimed.push({
                id: target.id,
                path: targetPath,
                reclaimedBytes: before.bytes,
              });
            }
            completedTargets += 1;
            continue;
          }

          const commandCwd = readiness.commandCwd;
          if (!commandCwd) {
            warnings.push(warningFor(targetPath, GIT_WORKTREE_METADATA_UNRESOLVED));
            completedTargets += 1;
            continue;
          }
          const exit = yield* Effect.exit(
            git.removeWorktree({
              cwd: commandCwd,
              path: targetPath,
              force: false,
            }),
          );
          if (Exit.isFailure(exit)) {
            warnings.push(
              warningFor(targetPath, `git worktree remove failed: ${Cause.pretty(exit.cause)}`),
            );
            completedTargets += 1;
            continue;
          }
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
              allowRoot: Path.resolve(targetPath) === Path.resolve(allowedRoot),
              recursive: categoryId !== "legacyT3Root",
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
          perTargetReclaimed.push({
            id: target.id,
            path: targetPath,
            reclaimedBytes: target.bytes,
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

  const cleanup: StorageMaintenanceShape["cleanup"] = (request, context) =>
    Effect.gen(function* () {
      const { categoryIds, requestedCategories, targetSelections } =
        yield* validateCleanupRequest(request);
      cancelledOperations.delete(request.operationId);
      const startedAt = nowIso();
      const requestedCategoryById = new Map(
        requestedCategories.map((category) => [category.id, category] as const),
      );
      const archivedDeletePreparation = categoryIds.includes("purgeArchivedThreads")
        ? yield* dispatchArchivedThreadDeletes(
            request,
            context,
            requestedCategoryById.get("purgeArchivedThreads"),
          )
        : { deletedThreadIds: [] as ThreadId[], warnings: [] as StoragePathWarning[] };
      const f5WorktreeReferenceWarnings = categoryIds.includes("inactiveF5Worktrees")
        ? yield* clearArchivedWorktreeReferences(
            request,
            context,
            requestedCategoryById.get("inactiveF5Worktrees"),
            targetSelections.get("inactiveF5Worktrees"),
          )
        : [];
      const lockScope = yield* engine.acquireMaintenanceLock();
      activeOperationId = request.operationId;
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
                  threadIds: archivedDeletePreparation.deletedThreadIds,
                  warnings: archivedDeletePreparation.warnings,
                });
              case "purgeDeletedThreads":
                return purgeDeletedThreads(request, context);
              case "inactiveF5Worktrees":
                return cleanF5Worktrees(
                  request,
                  context,
                  targetSelections.get(categoryId),
                  f5WorktreeReferenceWarnings,
                );
              case "providerLogsForTerminalThreads":
                return pruneProviderLogsForTerminalThreads(request, context);
              case "providerLogRotations":
                return pruneEventsLogRotations(request, context);
              case "orphanAttachments":
                return cleanOrphanAttachments(request, context, targetSelections.get(categoryId));
              case "databaseVacuum":
                return vacuumDatabase();
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
          })();
          if (categoryId !== "databaseVacuum" && result.reclaimedBytes > 0) {
            performedDeletes = true;
          }
          results.push(result);
        }

        if (
          performedDeletes &&
          !categoryIds.includes("databaseVacuum") &&
          request.options?.vacuumAfterDeletes !== false
        ) {
          const vacuumResult = yield* vacuumDatabase();
          results.push(vacuumResult);
        }

        const warnings = results.flatMap((result) => result.warnings);
        const completedAt = nowIso();
        cachedReport = null;
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
        Effect.ensuring(Scope.close(lockScope, Exit.void).pipe(Effect.ignore)),
        Effect.ensuring(
          Effect.sync(() => {
            cancelledOperations.delete(request.operationId);
            if (activeOperationId === request.operationId) {
              activeOperationId = null;
            }
          }),
        ),
      );
    }).pipe(Effect.mapError(toStorageMaintenanceError("StorageMaintenance.cleanup")));

  const cancel: StorageMaintenanceShape["cancel"] = (operationId) =>
    Effect.sync(() => {
      if (activeOperationId === operationId) {
        cancelledOperations.add(operationId);
      }
    });

  return {
    inspect,
    cleanup,
    cancel,
  } satisfies StorageMaintenanceShape;
});

export const StorageMaintenanceLive = Layer.effect(StorageMaintenance, makeStorageMaintenance);
