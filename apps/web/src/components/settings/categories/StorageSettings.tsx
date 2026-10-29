import { acceptStorageCleanup } from "../../../storageCleanupAcceptance";
import { StorageOperationDetails } from "../StorageOperationDetails";
import { CopyPathButton } from "../../CopyPathButton";
import {
  useStorageStatus,
  storageStatusKey,
  newerStorageStatus,
  newerStorageUsage,
} from "../../../hooks/useStorageStatus";
import { useDiskSpaceStatus, diskSpaceQueryKey } from "../../../hooks/useDiskSpaceStatus";
import { Link } from "@tanstack/react-router";
import { beginProtocolUpload, protocolFetch } from "../../../protocolState";
import {
  type StorageCleanupCategoryId,
  type StorageCleanupCategoryUsage,
  type StorageCleanupProgressPayload,
  type StorageCleanupResult,
  type StorageCleanupTarget,
  type StorageCleanupTargetSelection,
  type StorageUsageReport,
} from "@t3tools/contracts";
import { formatByteSize } from "@t3tools/shared/byteSize";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DatabaseIcon,
  DownloadIcon,
  HardDriveIcon,
  KeyRoundIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { toastManager } from "../../ui/toast";

export { STORAGE_SETTINGS_DESCRIPTORS } from "./StorageSettings.descriptors";
import { getServerHttpOrigin } from "../../../lib/serverHttpOrigin";
import { StorageAutomationSettings } from "../StorageAutomationSettings";
import { StorageDiscoverySettings } from "../StorageDiscoverySettings";
import { WorktreeLocationSettings } from "../WorktreeLocationSettings";
import {
  StorageActionConfirmDialog,
  type StorageConfirmAction,
} from "../StorageActionConfirmDialog";

const storageQueryKey = ["storage", "usage"] as const;

const SECTION_TITLES = {
  database: "Database",
  worktrees: "Worktrees",
  logs: "Logs",
  attachments: "Attachments",
  providers: "Provider homes",
  legacy: "Legacy T3/F5 data",
  machine: "Machine caches and logs",
} as const;

function isTargetLevelCategoryId(categoryId: StorageCleanupCategoryId): boolean {
  return [
    "legacyT3Worktrees",
    "inactiveF5Worktrees",
    "externalWorktrees",
    "staleWorktreeRegistrations",
    "purgeDeletedThreads",
    "purgeArchivedThreads",
    "orphanAttachments",
    "providerLogsForTerminalThreads",
    "providerLogRotations",
    "f5Backups",
    "f5ApplicationLogs",
    "bunDownloadCache",
    "npmDownloadCache",
    "uvDiscardedCaches",
    "chromeCaches",
    "bambuStudioLogs",
  ].includes(categoryId);
}

function isSelectableCleanupTarget(target: StorageCleanupTarget): boolean {
  return target.safeToDelete;
}

function selectedTargetSet(
  selections: ReadonlyMap<StorageCleanupCategoryId, ReadonlySet<string>>,
  categoryId: StorageCleanupCategoryId,
): ReadonlySet<string> {
  return selections.get(categoryId) ?? new Set<string>();
}

function summarizeCategoryTargets(
  category: StorageCleanupCategoryUsage,
  targets: ReadonlyArray<StorageCleanupTarget>,
): StorageCleanupCategoryUsage {
  const bytes = targets.reduce((total, target) => total + target.bytes, 0);
  return {
    ...category,
    bytes,
    reclaimableBytes: bytes,
    targetCount: targets.length,
    targets: [...targets],
  };
}

function operationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `storage-${Date.now()}-${Math.random()}`;
}

function usageBySection(
  report: StorageUsageReport,
): Map<StorageCleanupCategoryUsage["section"], StorageCleanupCategoryUsage[]> {
  const sections = new Map<StorageCleanupCategoryUsage["section"], StorageCleanupCategoryUsage[]>();
  for (const category of report.categories) {
    sections.set(category.section, [...(sections.get(category.section) ?? []), category]);
  }
  return sections;
}

function CategoryRow({
  category,
  selected,
  indeterminate,
  disabled,
  disableCategoryAction,
  disableSelection,
  onSelectedChange,
  onOpenAction,
}: {
  readonly category: StorageCleanupCategoryUsage;
  readonly selected: boolean;
  readonly indeterminate?: boolean;
  readonly disabled: boolean;
  readonly disableCategoryAction?: boolean;
  readonly disableSelection?: boolean;
  readonly onSelectedChange: (selected: boolean) => void;
  readonly onOpenAction: () => void;
}) {
  const hasRunnableTarget =
    category.id === "databaseVacuum"
      ? category.bytes > 0
      : category.reclaimableBytes > 0 || category.targetCount > 0;
  const isDisabled = disabled || category.availability === "disabled" || !hasRunnableTarget;
  const isSelectionDisabled = isDisabled || disableSelection === true;
  const isActionDisabled = isDisabled || disableCategoryAction === true;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3">
      <label className="flex min-w-0 flex-1 items-start gap-3">
        <Checkbox
          checked={selected}
          indeterminate={indeterminate}
          disabled={isSelectionDisabled}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={category.title}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            {category.title}{" "}
            <span className="rounded border px-1.5 py-0.5 text-2xs text-muted-foreground">
              {category.id.startsWith("purge") || category.impact === "high"
                ? "Permanent"
                : category.impact === "none"
                  ? "Safe"
                  : "Low"}
            </span>
          </span>
          <span className="block text-2xs text-muted-foreground">
            {category.targetCount.toLocaleString()} targets
            {category.eligibleThreadCount
              ? ` · ${category.eligibleThreadCount} eligible threads`
              : ""}
            {category.measurement !== "complete" ? ` · Measurement ${category.measurement}` : ""}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{category.description}</span>
          {category.disabledReason ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {category.disabledReason}
            </span>
          ) : null}
        </span>
      </label>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {category.measurement === "unavailable"
            ? "Unavailable"
            : formatByteSize(category.reclaimableBytes)}
        </span>
        <Button size="xs" variant="outline" disabled={isActionDisabled} onClick={onOpenAction}>
          <Trash2Icon />
          Reclaim
        </Button>
      </div>
    </div>
  );
}

function TargetRow({
  category,
  target,
  selected,
  disabled,
  onSelectedChange,
  onOpenAction,
}: {
  readonly category: StorageCleanupCategoryUsage;
  readonly target: StorageCleanupTarget;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelectedChange: (selected: boolean) => void;
  readonly onOpenAction: () => void;
}) {
  const isDisabled =
    disabled || category.availability === "disabled" || !isSelectableCleanupTarget(target);
  return (
    <div className="ml-8 flex items-center justify-between gap-3 rounded-lg border border-border bg-background/70 px-3 py-2">
      <label className="flex min-w-0 flex-1 items-center gap-3">
        <Checkbox
          checked={selected}
          disabled={isDisabled}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`Select ${target.label}`}
        />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-foreground">{target.label}</span>
          <span className="block truncate text-2xs text-muted-foreground">
            {target.disabledReason ??
              (target.projectName || target.threadTitle
                ? [
                    target.projectName,
                    target.threadTitle,
                    target.latestMtime
                      ? `changed ${Math.floor((Date.now() - Date.parse(target.latestMtime)) / 86_400_000)} days ago`
                      : null,
                    target.detail,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : (target.detail ?? target.path ?? category.title))}
          </span>
        </span>
      </label>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {formatByteSize(target.bytes)}
        </span>
        {target.path ? <CopyPathButton path={target.path} /> : null}
        <Button size="xs" variant="outline" disabled={isDisabled} onClick={onOpenAction}>
          <Trash2Icon />
          {target.action === "archiveAndRemove" ? "Archive and remove" : "Reclaim"}
        </Button>
      </div>
    </div>
  );
}

function CleanupCategoryList({
  collapsed,
  children,
}: {
  readonly collapsed: boolean;
  readonly children: React.ReactNode;
}) {
  return collapsed ? (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Advanced legacy cleanup
      </summary>
      <div className="mt-3 space-y-2">{children}</div>
    </details>
  ) : (
    <div className="space-y-2">{children}</div>
  );
}

function ResultSummary({
  result,
  report,
}: {
  readonly result: StorageCleanupResult;
  readonly report: StorageUsageReport | null;
}) {
  const visibleWarnings = result.warnings.slice(0, 5);
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-foreground">Last cleanup result</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Estimated storage removed: {formatByteSize(result.reclaimedBytes)}.
          {result.warnings.length > 0 ? ` ${result.warnings.length} warning(s).` : ""}
        </p>
        {result.volumeChanges?.map((volume) => (
          <p key={volume.path} className="mt-1 text-xs text-muted-foreground">
            Observed net free-space change: {volume.netFreeBytes < 0 ? "−" : "+"}
            {formatByteSize(Math.abs(volume.netFreeBytes))}. Available:{" "}
            {formatByteSize(volume.freeAfterBytes)}. Concurrent writes and shared filesystem blocks
            can affect this measurement. <CopyPathButton path={volume.path} />
          </p>
        ))}
      </div>
      <div className="space-y-2">
        {result.results.map((entry) => (
          <div
            key={entry.categoryId}
            className="rounded-lg border border-border bg-background px-3 py-2"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">
                {report?.categories.find((category) => category.id === entry.categoryId)?.title ??
                  entry.categoryId.replace(/([A-Z])/g, " $1")}
              </span>
              <span className="text-xs text-muted-foreground">
                {entry.status} · {formatByteSize(entry.reclaimedBytes)}
              </span>
            </div>
            {entry.perTargetReclaimed.length ? (
              <ul className="mt-2 space-y-1 text-2xs text-muted-foreground">
                {entry.perTargetReclaimed.slice(0, 5).map((target) => (
                  <li key={target.id}>
                    {report?.categories
                      .find((category) => category.id === entry.categoryId)
                      ?.targets.find((candidate) => candidate.id === target.id)?.label ??
                      target.path ??
                      target.id}{" "}
                    <span className="rounded border px-1">
                      {target.status ?? "Removed"}
                      {target.branch ? ` · branch ${target.branch}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {entry.message ? (
              <p className="mt-1 text-xs text-muted-foreground">{entry.message}</p>
            ) : null}
            {entry.warnings.length > 0 ? (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">Show {entry.warnings.length} warnings</summary>
                <ul className="mt-1 space-y-1">
                  {entry.warnings.map((warning, index) => (
                    <li key={index}>{warning.reason}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ))}
      </div>
      {visibleWarnings.length > 0 ? (
        <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2">
          <p className="text-xs font-medium text-foreground">Warnings</p>
          <ul className="mt-1 space-y-1">
            {visibleWarnings.map((warning, index) => (
              <li
                key={`${warning.path}:${warning.reason}:${index}`}
                className="truncate text-xs text-muted-foreground"
                title={`${warning.path}: ${warning.reason}`}
              >
                {warning.path}: {warning.reason}
              </li>
            ))}
          </ul>
          {result.warnings.length > visibleWarnings.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {result.warnings.length - visibleWarnings.length} more warning(s)
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function StorageSettings() {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<StorageCleanupCategoryId>>(
    () => new Set(),
  );
  const [selectedTargetIdsByCategory, setSelectedTargetIdsByCategory] = useState<
    ReadonlyMap<StorageCleanupCategoryId, ReadonlySet<string>>
  >(() => new Map());
  const [confirmAction, setConfirmActionState] = useState<StorageConfirmAction | null>(null);
  const status = useStorageStatus();
  const diskSpace = useDiskSpaceStatus();
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null);
  const pendingOperationEpoch = useRef<string | null>(null);
  const currentSubmissionId = useRef<string | null>(null);
  const [acceptedOperation, setAcceptedOperation] = useState<{
    operationId: string;
    backendEpoch: string;
  } | null>(null);
  const cancellationRequested = useRef<string | null>(null);
  const progress: StorageCleanupProgressPayload | null =
    pendingOperationId && pendingOperationId !== status?.cleanup?.operationId
      ? {
          operationId: pendingOperationId,
          phase: "starting",
          message: acceptedOperation ? "Checking status…" : "Starting…",
          completedTargets: 0,
          totalTargets: 0,
        }
      : (status?.cleanup?.progress ?? null);
  const initializedSelection = useRef(false);
  const reportedFailure = useRef<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const reviewAfterScan = useRef<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now);
  const [loadingTargets, setLoadingTargets] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<StorageCleanupResult | null>(null);
  const [includeSecretsInBackup, setIncludeSecretsInBackup] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupBusy, setBackupBusy] = useState<"export" | "restore" | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const usageQuery = useQuery({
    queryKey: storageQueryKey,
    queryFn: async () =>
      newerStorageUsage(
        queryClient.getQueryData(storageQueryKey),
        await ensureNativeApi().storage.getUsage(),
      ),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const report = usageQuery.data?.report ?? null;
  const confirmation = usageQuery.data?.confirmation ?? null;
  const setConfirmAction = (action: StorageConfirmAction | null) =>
    setConfirmActionState(
      action && confirmation
        ? {
            ...action,
            confirmation,
            backendEpoch: status?.backendEpoch ?? usageQuery.data?.status.backendEpoch,
          }
        : null,
    );
  const sections = useMemo(
    () =>
      report
        ? usageBySection(report)
        : new Map<StorageCleanupCategoryUsage["section"], StorageCleanupCategoryUsage[]>(),
    [report],
  );
  useEffect(() => {
    if (!status || !pendingOperationId) return;
    const forgetOperation = (message: string) => {
      setPendingOperationId(null);
      setAcceptedOperation(null);
      pendingOperationEpoch.current = null;
      currentSubmissionId.current = null;
      cancellationRequested.current = null;
      setConfirmActionState(null);
      toastManager.add({
        title: message,
        description: "Rescan and review the remaining work before confirming another cleanup.",
      });
      void queryClient.invalidateQueries({ queryKey: storageQueryKey });
      void queryClient.invalidateQueries({ queryKey: diskSpaceQueryKey });
    };
    if (pendingOperationEpoch.current && status.backendEpoch !== pendingOperationEpoch.current) {
      forgetOperation("F5 restarted. The previous cleanup status is unavailable.");
      return;
    }
    if (!acceptedOperation || status.cleanup?.operationId === pendingOperationId) return;
    let current = true;
    void ensureNativeApi()
      .storage.getOperation({ operationId: pendingOperationId })
      .then((operation) => {
        if (!current) return;
        // Another window may already own the profile's next operation. Resolve
        // our retained completion locally without replacing its live status.
        if (operation.status.completedAt) {
          if (
            operation.status.result &&
            queryClient.getQueryData(["storage", "dismissed-result"]) !== pendingOperationId
          )
            setLastResult(operation.status.result);
          if (operation.status.error)
            toastManager.add({
              type: "error",
              title: "Cleanup failed",
              description: operation.status.error,
            });
          setPendingOperationId(null);
          setAcceptedOperation(null);
          pendingOperationEpoch.current = null;
          currentSubmissionId.current = null;
          setConfirmActionState(null);
          void queryClient.invalidateQueries({ queryKey: diskSpaceQueryKey });
          return;
        }
        queryClient.setQueryData(storageStatusKey, (latest: typeof status | undefined) =>
          latest?.backendEpoch === acceptedOperation.backendEpoch &&
          (!latest.cleanup || latest.cleanup.operationId === pendingOperationId)
            ? { ...latest, cleanup: operation.status }
            : latest,
        );
        void queryClient.invalidateQueries({ queryKey: storageStatusKey });
      })
      .catch((error: unknown) => {
        if (current && error instanceof Error && error.message.includes("operation_unknown"))
          forgetOperation("The previous cleanup is no longer available.");
      });
    return () => {
      current = false;
    };
  }, [status, pendingOperationId, acceptedOperation, queryClient]);

  useEffect(() => {
    if (status?.scan.state !== "scanning") return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status?.scan.state]);
  const elapsedSeconds = status?.scan.startedAt
    ? Math.max(0, Math.floor((nowMs - Date.parse(status.scan.startedAt)) / 1000))
    : 0;
  const selectedAction = useMemo(() => {
    const categories: StorageCleanupCategoryUsage[] = [];
    const targetSelections: StorageCleanupTargetSelection[] = [];
    if (!report) return { categories, targetSelections };

    for (const category of report.categories) {
      if (isTargetLevelCategoryId(category.id)) {
        const selectedTargets = category.targets.filter(
          (target) =>
            selectedTargetSet(selectedTargetIdsByCategory, category.id).has(target.id) &&
            isSelectableCleanupTarget(target),
        );
        if (selectedTargets.length === 0) {
          continue;
        }
        categories.push(summarizeCategoryTargets(category, selectedTargets));
        targetSelections.push({
          categoryId: category.id,
          targetIds: selectedTargets.map((target) => target.id),
        });
        continue;
      }

      if (selectedIds.has(category.id)) {
        categories.push(category);
      }
    }

    return { categories, targetSelections };
  }, [report, selectedIds, selectedTargetIdsByCategory]);
  const selectedCategories = selectedAction.categories;

  useEffect(() => {
    if (!report) return;
    const firstReport = !initializedSelection.current;
    initializedSelection.current = true;
    setSelectedIds(
      new Set(
        report.categories
          .filter(
            (category) =>
              !isTargetLevelCategoryId(category.id) &&
              (firstReport ? category.defaultSelected : selectedIds.has(category.id)) &&
              category.availability === "ready" &&
              (category.reclaimableBytes > 0 || category.targetCount > 0),
          )
          .map((category) => category.id),
      ),
    );
    const nextTargetSelections = new Map<StorageCleanupCategoryId, ReadonlySet<string>>();
    for (const category of report.categories) {
      if (
        !isTargetLevelCategoryId(category.id) ||
        !(firstReport ? category.defaultSelected : selectedTargetIdsByCategory.has(category.id)) ||
        category.availability !== "ready"
      ) {
        continue;
      }
      const targetIds = category.targets
        .filter(
          (target) =>
            isSelectableCleanupTarget(target) &&
            (firstReport || selectedTargetIdsByCategory.get(category.id)?.has(target.id)),
        )
        .map((target) => target.id);
      if (targetIds.length > 0) {
        nextTargetSelections.set(category.id, new Set(targetIds));
      }
    }
    setSelectedTargetIdsByCategory(nextTargetSelections);
  }, [report?.scanId]);

  useEffect(() => {
    const api = ensureNativeApi();
    const unsubscribeInvalidated = api.storage.onInvalidated(() => {
      void queryClient.invalidateQueries({ queryKey: storageQueryKey });
    });

    return () => {
      unsubscribeInvalidated();
    };
  }, [queryClient]);

  useEffect(() => {
    if (status?.cleanup?.completedAt) {
      if (
        status.cleanup.result &&
        queryClient.getQueryData(["storage", "dismissed-result"]) !== status.cleanup.operationId
      )
        setLastResult(status.cleanup.result);
      setPendingOperationId((pending) =>
        pending === status.cleanup?.operationId ? null : pending,
      );
      if (currentSubmissionId.current === status.cleanup.operationId) {
        currentSubmissionId.current = null;
        pendingOperationEpoch.current = null;
        setAcceptedOperation(null);
        setConfirmActionState(null);
      }
      if (status.cleanup.error && reportedFailure.current !== status.cleanup.operationId) {
        reportedFailure.current = status.cleanup.operationId;
        toastManager.add({
          type: "error",
          title: "Cleanup failed",
          description: status.cleanup.error,
        });
      }
      void queryClient.invalidateQueries({ queryKey: diskSpaceQueryKey });
    }
  }, [status?.cleanup, queryClient]);

  const refreshUsage = async () => {
    try {
      const next = await ensureNativeApi().storage.getUsage({ force: true });
      queryClient.setQueryData(
        storageQueryKey,
        (current: import("@t3tools/contracts").StorageGetUsageResult | undefined) =>
          newerStorageUsage(current, next),
      );
      queryClient.setQueryData(storageStatusKey, (current: typeof next.status | undefined) =>
        newerStorageStatus(current, next.status),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Storage scan failed",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  useEffect(() => {
    if (!confirmAction || !report || confirmAction.confirmation?.scanId === report.scanId) return;
    const categories = confirmAction.categories.flatMap((previous) => {
      const current = report.categories.find(
        (category) => category.id === previous.id && category.availability === "ready",
      );
      if (!current) return [];
      const ids = new Set(previous.targets.map((target) => target.id));
      if (!previous.targets.length) return [current];
      const targets = current.targets.filter((target) => ids.has(target.id) && target.safeToDelete);
      if (!targets.length) return [];
      return [summarizeCategoryTargets(current, targets)];
    });
    if (
      !categories.length ||
      categories.every((category) => category.targetCount > 0 && category.targets.length === 0)
    ) {
      setConfirmActionState(null);
      toastManager.add({ title: "Nothing left to reclaim in this selection." });
      return;
    }
    const changed = JSON.stringify(categories) !== JSON.stringify(confirmAction.categories);
    setConfirmActionState({
      ...confirmAction,
      categories,
      targetSelections: categories
        .filter((category) => category.targets.length > 0)
        .map((category) => ({
          categoryId: category.id,
          targetIds: category.targets.map((target) => target.id),
        })),
      confirmation: confirmation ?? undefined,
      backendEpoch: usageQuery.data?.status.backendEpoch,
      description: changed
        ? "The report changed after a rescan. Review the updated selection."
        : confirmAction.description,
    });
  }, [report, confirmation]);
  const cancelOperation = (id: string) => {
    cancellationRequested.current = id;
    void ensureNativeApi()
      .storage.cancelCleanup({ operationId: id })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not cancel cleanup",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
  };
  const cleanupMutation = useMutation({
    mutationFn: async ({
      action,
      confirmationText,
      id,
    }: {
      readonly action: StorageConfirmAction;
      readonly confirmationText: string | undefined;
      readonly id: string;
    }) => {
      if (
        !action.confirmation ||
        !action.backendEpoch ||
        Date.parse(action.confirmation.expiresAt) <= Date.now()
      ) {
        void refreshUsage();
        throw new Error("Storage confirmation expired. Review the refreshed report.");
      }
      return acceptStorageCleanup(ensureNativeApi().storage, {
        operationId: id,
        backendEpoch: action.backendEpoch,
        scanId: action.confirmation.scanId,
        nonce: action.confirmation.nonce,
        categoryIds: action.categories.map((category) => category.id),
        ...(action.targetSelections ? { targetSelections: action.targetSelections } : {}),
        ...(action.categories.some((category) =>
          category.targets.some((target) => target.action === "archiveAndRemove"),
        )
          ? { options: { archiveIdleThreads: true } }
          : {}),
        ...(confirmationText ? { confirmationText } : {}),
      });
    },
    onSuccess: (operation, variables) => {
      if (currentSubmissionId.current !== variables.id) return;
      setConfirmActionState(null);
      const latest = queryClient.getQueryData<NonNullable<typeof status>>(storageStatusKey);
      if (latest && latest.backendEpoch !== variables.action.backendEpoch) return;
      if (latest?.cleanup?.operationId === operation.operationId && latest.cleanup.completedAt) {
        setPendingOperationId(null);
        setAcceptedOperation(null);
        currentSubmissionId.current = null;
        pendingOperationEpoch.current = null;
        return;
      }
      setPendingOperationId(operation.operationId);
      setAcceptedOperation({
        operationId: operation.operationId,
        backendEpoch: variables.action.backendEpoch!,
      });
      // A stop-lane request can arrive before the acceptance RPC has registered
      // the operation. Preserve the user's intent across that acknowledgement.
      if (cancellationRequested.current === operation.operationId)
        cancelOperation(operation.operationId);
      queryClient.setQueryData(storageStatusKey, (current: typeof status) =>
        current && current.cleanup?.operationId !== operation.operationId
          ? { ...current, cleanup: operation }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: storageStatusKey });
    },
    onError: (error, variables) => {
      if (currentSubmissionId.current !== variables.id) return;
      toastManager.add({ type: "error", title: "Cleanup failed", description: error.message });
      setConfirmActionState(null);
      setPendingOperationId(null);
      setAcceptedOperation(null);
      pendingOperationEpoch.current = null;
      currentSubmissionId.current = null;
      void queryClient.invalidateQueries({ queryKey: storageQueryKey });
      void queryClient.invalidateQueries({ queryKey: diskSpaceQueryKey });
    },
  });

  const openAction = (categories: ReadonlyArray<StorageCleanupCategoryUsage>, title: string) => {
    if (categories.length === 0) return;
    setConfirmAction({ categories, title });
  };

  const openSelectedAction = () => {
    if (selectedAction.categories.length === 0) return;
    setConfirmAction({
      categories: selectedAction.categories,
      title: "Reclaim selected storage",
      ...(selectedAction.targetSelections.length > 0
        ? { targetSelections: selectedAction.targetSelections }
        : {}),
    });
  };

  useEffect(() => {
    if (
      reviewAfterScan.current !== null &&
      report &&
      confirmation &&
      report.scanId !== reviewAfterScan.current
    ) {
      reviewAfterScan.current = null;
      if (selectedAction.categories.length)
        setConfirmAction({ ...selectedAction, title: "Review remaining work" });
      else toastManager.add({ title: "Nothing left to reclaim in this selection." });
    }
  }, [report?.scanId, confirmation, selectedAction]);

  const openCategoryAction = (category: StorageCleanupCategoryUsage) => {
    openAction([category], category.title);
  };

  const openTargetGroupAction = (
    category: StorageCleanupCategoryUsage,
    targets: ReadonlyArray<StorageCleanupTarget>,
    title: string,
  ) => {
    if (targets.length === 0) return;
    setConfirmAction({
      title,
      categories: [summarizeCategoryTargets(category, targets)],
      targetSelections: [
        { categoryId: category.id, targetIds: targets.map((target) => target.id) },
      ],
    });
  };

  const openTargetAction = (
    category: StorageCleanupCategoryUsage,
    target: StorageCleanupTarget,
  ) => {
    setConfirmAction({
      title: `Reclaim ${target.label}`,
      categories: [
        {
          ...category,
          bytes: target.bytes,
          reclaimableBytes: target.bytes,
          targetCount: 1,
          targets: [target],
        },
      ],
      targetSelections: [{ categoryId: category.id, targetIds: [target.id] }],
    });
  };

  const running =
    (cleanupMutation.isPending && pendingOperationId !== null) ||
    pendingOperationId !== null ||
    !!(status?.cleanup && ["queued", "running", "cancelling"].includes(status.cleanup.state));
  const hasRunnableSelection = selectedCategories.some((category) =>
    category.id === "databaseVacuum"
      ? category.bytes > 0
      : category.reclaimableBytes > 0 || category.targetCount > 0,
  );

  const parseHttpError = async (response: Response): Promise<string> => {
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") return body.error;
    } catch {
      // Fall through to status text.
    }
    return response.statusText || `Request failed with status ${response.status}.`;
  };

  const exportBackup = async () => {
    if (includeSecretsInBackup && backupPassword.length < 12) {
      toastManager.add({
        type: "error",
        title: "Use at least 12 characters to encrypt exported credentials.",
      });
      return;
    }
    setBackupBusy("export");
    try {
      const response = await fetch(
        `${getServerHttpOrigin()}/api/storage/backup${includeSecretsInBackup ? "?includeSecrets=1" : ""}`,
        {
          credentials: "include",
          headers:
            includeSecretsInBackup && backupPassword
              ? { "X-F5-Backup-Password": backupPassword }
              : {},
        },
      );
      if (!response.ok) throw new Error(await parseHttpError(response));
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/u)?.[1] ??
        `f5-backup-${new Date().toISOString().slice(0, 10)}.f5backup`;
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      toastManager.add({ type: "success", title: "Backup archive created." });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Backup export failed",
        description: error instanceof Error ? error.message : "Unable to export F5 state.",
      });
    } finally {
      setBackupBusy(null);
    }
  };

  const restoreBackup = async (file: File) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(
      "Validate and stage this backup? F5 will replace local state on the next restart and retain a rollback copy.",
    );
    if (!confirmed) return;
    setBackupBusy("restore");
    let finishUpload: (() => void) | undefined;
    try {
      finishUpload = beginProtocolUpload();
      const response = await protocolFetch(`${getServerHttpOrigin()}/api/storage/restore`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-f5-backup",
          ...(backupPassword ? { "X-F5-Backup-Password": backupPassword } : {}),
        },
        body: file,
      });
      if (!response.ok) throw new Error(await parseHttpError(response));
      const result = (await response.json()) as {
        fileCount: number;
        includesEncryptedSecrets: boolean;
        crossProfile?: boolean;
        sourceProfileId?: string;
      };
      toastManager.add({
        type: "success",
        title: "Restore validated and staged. Restart F5 to apply it.",
        description: `${result.fileCount} files validated${result.includesEncryptedSecrets ? ", including encrypted secrets" : ""}. ${result.crossProfile ? `This archive comes from another profile (${result.sourceProfileId}). ` : ""}Provider credential homes are not included; sign in again after restoring.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Backup restore failed",
        description:
          error instanceof Error ? error.message : "Unable to validate the backup archive.",
      });
    } finally {
      setBackupBusy(null);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      finishUpload?.();
    }
  };

  const segments = report
    ? [
        { name: "Worktrees", bytes: report.worktreesBytes, color: "bg-muted-foreground/80" },
        { name: "Provider homes", bytes: report.providerHomesBytes, color: "bg-info/60" },
        { name: "Database", bytes: report.databaseBytes, color: "bg-primary/60" },
        { name: "Logs", bytes: report.logsBytes, color: "bg-warning/60" },
        { name: "Attachments", bytes: report.attachmentsBytes, color: "bg-success/60" },
        { name: "Legacy", bytes: report.legacyBytes, color: "bg-destructive/50" },
        { name: "Other", bytes: report.otherBytes, color: "bg-muted-foreground/35" },
        {
          name: "Machine storage",
          bytes: report.machineBytes ?? 0,
          color: "bg-muted-foreground/50",
        },
      ]
    : [];
  const loadTargets = async (category: StorageCleanupCategoryUsage) => {
    if (!report) return;
    setLoadingTargets(category.id);
    try {
      const page = await ensureNativeApi().storage.getTargets({
        scanId: report.scanId,
        categoryId: category.id,
        cursor: category.targets.length,
        limit: 100,
      });
      queryClient.setQueryData<import("@t3tools/contracts").StorageGetUsageResult>(
        storageQueryKey,
        (current) =>
          current?.report?.scanId === report.scanId
            ? {
                ...current,
                report: {
                  ...current.report,
                  categories: current.report.categories.map((entry) =>
                    entry.id === category.id
                      ? { ...entry, targets: [...entry.targets, ...page.targets] }
                      : entry,
                  ),
                },
              }
            : current,
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not inspect storage targets",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingTargets(null);
    }
  };
  const dismissResult = () => {
    queryClient.setQueryData(["storage", "dismissed-result"], lastResult?.operationId);
    setLastResult(null);
  };

  return (
    <>
      <section
        className="rounded-xl border border-border bg-card p-5"
        data-settings-search-target="storage.overview"
      >
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Storage</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Inspect local F5 state and reclaim data by explicit action.
              {report?.serverName ? " Server: " + report.serverName + "." : ""}
              {report?.scannedAt
                ? " Last scan: " + new Date(report.scannedAt).toLocaleString() + "."
                : ""}
            </p>
            {report?.discoveryRoots ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Repository search coverage:{" "}
                {report.discoveryRoots.length
                  ? report.discoveryRoots.join(", ")
                  : "registered projects only"}
                . Machine cache scanning: {report.machineCleanupScanned ? "enabled" : "off"}. Any
                incomplete or inaccessible locations are listed in scan warnings.
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={usageQuery.isFetching || running}
              onClick={() => void refreshUsage()}
            >
              <RefreshCwIcon />
              Rescan
            </Button>
            <Button
              size="xs"
              disabled={
                !confirmation || running || selectedCategories.length === 0 || !hasRunnableSelection
              }
              onClick={openSelectedAction}
            >
              <Trash2Icon />
              Reclaim selected
            </Button>
          </div>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {selectedCategories.length} selected · up to{" "}
          {formatByteSize(
            selectedCategories.reduce((total, category) => total + category.reclaimableBytes, 0),
          )}
        </p>

        {usageQuery.isLoading || (!report && status?.scan.state === "scanning") ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Scanning {status?.scan.phase ?? "storage"}…{" "}
            {status?.scan.entriesVisited.toLocaleString() ?? 0} items · {elapsedSeconds}s
          </div>
        ) : usageQuery.isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {usageQuery.error instanceof Error ? usageQuery.error.message : "Storage scan failed."}
          </div>
        ) : report ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-background px-3 py-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <HardDriveIcon className="size-3.5" />
                Total used
              </div>
              <p className="mt-1 text-lg font-semibold text-foreground">
                {formatByteSize(report.totalUsedBytes)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Trash2Icon className="size-3.5" />
                Reclaimable
              </div>
              <p className="mt-1 text-lg font-semibold text-foreground">
                {formatByteSize(report.reclaimableBytes)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <DatabaseIcon className="size-3.5" />
                Database
              </div>
              <p className="mt-1 text-lg font-semibold text-foreground">
                {formatByteSize(report.databaseBytes)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-3">
              <p className="text-xs text-muted-foreground">Threads</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{report.threadCount}</p>
              <p className="text-xs text-muted-foreground">
                {report.archivedThreadCount} archived · {report.deletedThreadCount} deleted
              </p>
            </div>
          </div>
        ) : null}

        {report ? (
          <div className="mt-4 space-y-2">
            <div
              className="flex h-3 overflow-hidden rounded-full"
              role="img"
              aria-label="Storage usage by category"
            >
              {segments
                .filter((segment) => segment.bytes > 0)
                .map((segment) => (
                  <div
                    key={segment.name}
                    className={segment.color}
                    style={{
                      width: `${report.totalUsedBytes ? (segment.bytes / report.totalUsedBytes) * 100 : 0}%`,
                    }}
                    title={`${segment.name}: ${formatByteSize(segment.bytes)}`}
                  />
                ))}
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
              {segments.map((segment) => (
                <li key={segment.name}>
                  <span className={`mr-1 inline-block size-2 rounded-full ${segment.color}`} />
                  {segment.name}{" "}
                  {segment.name === "Provider homes" &&
                  report.providerHomesMeasurement === "unavailable"
                    ? "Unavailable"
                    : formatByteSize(segment.bytes)}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Scanned{" "}
              {Math.max(0, Math.floor((Date.now() - Date.parse(report.scannedAt)) / 60_000))} min
              ago · Reclaimable {formatByteSize(report.reclaimableBytes)} (each file counted once).
              Category estimates may overlap.
            </p>
          </div>
        ) : null}
        {status?.scan.state === "scanning" && report ? (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            Updating… {status.scan.phase} · {status.scan.entriesVisited.toLocaleString()} items ·{" "}
            {elapsedSeconds}s
          </p>
        ) : null}
        {report?.warnings.length ? (
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {report.warnings.length} measurement warnings
              {report.warningsTruncated ? " (additional warnings omitted)" : ""}
            </summary>
            <ul className="mt-2 space-y-1">
              {report.warnings.map((warning, index) => (
                <li key={index}>{warning.reason}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {status?.scan.state === "failed" ? (
          <div role="alert" className="mt-3 text-xs text-destructive">
            {status.scan.error}
            <Button size="xs" variant="outline" onClick={() => void refreshUsage()}>
              Retry
            </Button>
          </div>
        ) : null}
        {report && !confirmation ? (
          <p className="mt-3 text-xs text-muted-foreground">
            This report is out of date. Rescan to reclaim space.
          </p>
        ) : null}
        {diskSpace?.volumes[0] ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {formatByteSize(diskSpace.volumes[0].freeBytes)} free of{" "}
            {formatByteSize(diskSpace.volumes[0].totalBytes)}
          </p>
        ) : null}
        {running && progress ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
              <span role="status" aria-live="polite" className="truncate">
                {progress.message}
                <progress
                  className="ml-2"
                  value={progress.completedTargets}
                  max={Math.max(1, progress.totalTargets)}
                  aria-label="Cleanup progress"
                />
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                cancelOperation(progress.operationId);
              }}
            >
              <XIcon />
              Cancel
            </Button>
          </div>
        ) : null}
      </section>

      {status?.cleanup?.error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 p-4 text-xs text-destructive"
        >
          Cleanup failed: {status.cleanup.error}
          <Button size="xs" variant="outline" onClick={() => void refreshUsage()}>
            Review remaining work
          </Button>
        </div>
      ) : null}
      {report ? (
        <>
          {(
            [
              "database",
              "worktrees",
              "logs",
              "attachments",
              "providers",
              "machine",
              "legacy",
            ] as const
          ).map((sectionId) => {
            const categories = sections.get(sectionId) ?? [];
            if (categories.length === 0 && sectionId !== "providers") return null;
            const sectionBytes =
              sectionId === "database"
                ? report.databaseBytes
                : sectionId === "worktrees"
                  ? report.worktreesBytes
                  : sectionId === "logs"
                    ? report.logsBytes
                    : sectionId === "attachments"
                      ? report.attachmentsBytes
                      : sectionId === "providers"
                        ? report.providerHomesBytes
                        : sectionId === "machine"
                          ? (report.machineBytes ??
                            categories.reduce((sum, category) => sum + category.bytes, 0))
                          : report.legacyBytes;
            return (
              <section
                key={sectionId}
                data-settings-search-target={`storage.${sectionId}`}
                className="rounded-xl border border-border bg-card p-5"
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">
                      {SECTION_TITLES[sectionId]} (
                      {(
                        sectionId === "providers"
                          ? report.providerHomesMeasurement === "unavailable"
                          : categories.some((category) => category.measurement === "unavailable")
                      )
                        ? "Unavailable"
                        : formatByteSize(sectionBytes)}
                      )
                    </h2>
                    {sectionId === "logs" ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Provider event logs across {report.providerLogSegmentCount} thread segments.
                        Current application logs, observability, and terminal logs are retained.
                      </p>
                    ) : sectionId === "providers" ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Data that agent CLIs launched by F5 leave in their home directories.
                      </p>
                    ) : sectionId === "legacy" && report.legacyCleanupDisabledReason ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {report.legacyCleanupDisabledReason}
                      </p>
                    ) : null}
                  </div>
                </div>
                {sectionId === "providers" ? (
                  <div className="mb-3 space-y-2 text-xs text-muted-foreground">
                    <p>
                      Agent CLI data for this profile (sessions, transcripts, caches). F5 does not
                      delete it. Manage it from the provider’s CLI.
                    </p>
                    {report.providerHomesMeasurement &&
                    report.providerHomesMeasurement !== "complete" ? (
                      <p role="status">
                        Provider home usage is {report.providerHomesMeasurement}. Accessible cleanup
                        categories remain available.
                      </p>
                    ) : null}
                    {report.providerHomes.map((home) => (
                      <div key={home.path} className="flex justify-between gap-2">
                        <span className="flex items-center gap-2">
                          {home.name}
                          <CopyPathButton path={home.path} />
                        </span>
                        <span>{formatByteSize(home.bytes)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <CleanupCategoryList collapsed={sectionId === "legacy"}>
                  {categories.map((category) => {
                    const targetLevelOnly = isTargetLevelCategoryId(category.id);
                    const selectableTargets = targetLevelOnly
                      ? category.targets.filter(isSelectableCleanupTarget)
                      : [];
                    const selectedTargets = selectedTargetSet(
                      selectedTargetIdsByCategory,
                      category.id,
                    );
                    const selectedTargetCount = selectableTargets.filter((target) =>
                      selectedTargets.has(target.id),
                    ).length;
                    const selectedSelectableTargets = selectableTargets.filter((target) =>
                      selectedTargets.has(target.id),
                    );
                    const categorySelected = targetLevelOnly
                      ? selectedTargetCount > 0 && selectedTargetCount === selectableTargets.length
                      : selectedIds.has(category.id);
                    const categoryIndeterminate =
                      targetLevelOnly &&
                      selectedTargetCount > 0 &&
                      selectedTargetCount < selectableTargets.length;
                    return (
                      <div key={category.id} className="space-y-2">
                        {category.id === "inactiveF5Worktrees" && (
                          <Link to="/worktrees" className="text-sm text-primary underline">
                            Manage worktrees
                          </Link>
                        )}
                        <CategoryRow
                          category={category}
                          selected={categorySelected}
                          indeterminate={categoryIndeterminate}
                          disabled={running || !confirmation}
                          disableCategoryAction={
                            targetLevelOnly && selectedSelectableTargets.length === 0
                          }
                          disableSelection={targetLevelOnly && selectableTargets.length === 0}
                          onSelectedChange={(selected) => {
                            if (targetLevelOnly) {
                              setSelectedTargetIdsByCategory((current) => {
                                const next = new Map(current);
                                if (selected) {
                                  next.set(
                                    category.id,
                                    new Set(selectableTargets.map((target) => target.id)),
                                  );
                                } else {
                                  next.delete(category.id);
                                }
                                return next;
                              });
                              return;
                            }
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (selected) {
                                next.add(category.id);
                              } else {
                                next.delete(category.id);
                              }
                              return next;
                            });
                          }}
                          onOpenAction={() => {
                            if (targetLevelOnly) {
                              openTargetGroupAction(
                                category,
                                selectedSelectableTargets,
                                category.title,
                              );
                              return;
                            }
                            openCategoryAction(category);
                          }}
                        />
                        {targetLevelOnly && category.targets.length > 0
                          ? category.targets
                              .toSorted((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))
                              .slice(0, expandedCategories.has(category.id) ? undefined : 5)
                              .map((target) => (
                                <TargetRow
                                  key={target.id}
                                  category={category}
                                  target={target}
                                  selected={
                                    selectedTargets.has(target.id) &&
                                    isSelectableCleanupTarget(target)
                                  }
                                  disabled={running || !confirmation}
                                  onSelectedChange={(selected) => {
                                    setSelectedTargetIdsByCategory((current) => {
                                      const next = new Map(current);
                                      const targetIds = new Set(current.get(category.id) ?? []);
                                      if (selected) {
                                        targetIds.add(target.id);
                                      } else {
                                        targetIds.delete(target.id);
                                      }
                                      if (targetIds.size > 0) {
                                        next.set(category.id, targetIds);
                                      } else {
                                        next.delete(category.id);
                                      }
                                      return next;
                                    });
                                  }}
                                  onOpenAction={() => openTargetAction(category, target)}
                                />
                              ))
                          : null}
                        {targetLevelOnly && category.targetCount > 5 ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setExpandedCategories((current) => {
                                const next = new Set(current);
                                if (next.has(category.id)) next.delete(category.id);
                                else next.add(category.id);
                                return next;
                              })
                            }
                          >
                            {expandedCategories.has(category.id)
                              ? "Show fewer targets"
                              : `Inspect ${category.targetCount} targets`}
                          </Button>
                        ) : null}
                        {expandedCategories.has(category.id) &&
                        category.targets.length < category.targetCount ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={loadingTargets === category.id}
                            onClick={() => void loadTargets(category)}
                          >
                            Load 100 more targets
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </CleanupCategoryList>
              </section>
            );
          })}
        </>
      ) : null}

      {lastResult ? (
        <>
          <ResultSummary result={lastResult} report={report} />
          <StorageOperationDetails
            key={lastResult.operationId}
            operationId={lastResult.operationId}
            report={report}
          />
          <Button
            variant="outline"
            onClick={() => {
              reviewAfterScan.current = report?.scanId ?? "";
              dismissResult();
              void refreshUsage();
            }}
          >
            Review remaining work
          </Button>
          <Button variant="ghost" onClick={dismissResult}>
            Dismiss
          </Button>
        </>
      ) : null}

      <WorktreeLocationSettings />
      <StorageDiscoverySettings />
      <StorageAutomationSettings />
      <section
        className="rounded-xl border border-border bg-card p-5"
        data-settings-search-target="storage.backup"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Backup and restore</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Export a versioned, checksummed archive of the database, settings, and attachments.
              Credentials are excluded unless encrypted export is enabled.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={restoreInputRef}
              type="file"
              accept=".f5backup,application/x-f5-backup"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void restoreBackup(file);
              }}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={backupBusy !== null}
              onClick={() => restoreInputRef.current?.click()}
            >
              {backupBusy === "restore" ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
              Restore
            </Button>
            <Button size="xs" disabled={backupBusy !== null} onClick={() => void exportBackup()}>
              {backupBusy === "export" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <DownloadIcon />
              )}
              Export backup
            </Button>
          </div>
        </div>
        <label className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-3">
          <Checkbox
            checked={includeSecretsInBackup}
            onCheckedChange={(value) => setIncludeSecretsInBackup(value === true)}
            aria-label="Include encrypted credentials"
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <KeyRoundIcon className="size-3.5" />
              Include credentials using AES-256-GCM encryption
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              The password is never stored. It is required to restore encrypted credentials.
            </span>
          </span>
        </label>
        {includeSecretsInBackup ? (
          <div className="mt-3 max-w-md">
            <Input
              type="password"
              value={backupPassword}
              onChange={(event) => setBackupPassword(event.currentTarget.value)}
              placeholder="Encryption password (12+ characters)"
              autoComplete="new-password"
              aria-label="Backup encryption password"
            />
          </div>
        ) : (
          <div className="mt-3 max-w-md">
            <Input
              type="password"
              value={backupPassword}
              onChange={(event) => setBackupPassword(event.currentTarget.value)}
              placeholder="Restore password, if the archive is encrypted"
              autoComplete="current-password"
              aria-label="Backup restore password"
            />
          </div>
        )}
      </section>

      <StorageActionConfirmDialog
        action={confirmAction}
        open={confirmAction !== null}
        pending={running}
        progress={progress}
        onCancelCleanup={() => {
          if (progress) cancelOperation(progress.operationId);
        }}
        actionable={confirmation !== null}
        onExpired={() => void refreshUsage()}
        lastResult={lastResult}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        onConfirm={(confirmationText) => {
          if (confirmAction) {
            const id = operationId();
            cancellationRequested.current = null;
            pendingOperationEpoch.current = confirmAction.backendEpoch ?? null;
            currentSubmissionId.current = id;
            setAcceptedOperation(null);
            setPendingOperationId(id);
            cleanupMutation.mutate({ action: confirmAction, confirmationText, id });
          }
        }}
      />
    </>
  );
}
