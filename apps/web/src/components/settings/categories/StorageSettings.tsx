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
  HardDriveIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
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
  legacy: "Legacy T3/F5 data",
} as const;

function isTargetLevelCategoryId(categoryId: StorageCleanupCategoryId): boolean {
  return categoryId === "legacyT3Worktrees" || categoryId === "inactiveF5Worktrees";
}

function isSelectableCleanupTarget(target: StorageCleanupTarget): boolean {
  return target.safeToDelete && target.bytes > 0;
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
          <span className="block text-sm font-medium text-foreground">{category.title}</span>
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
          {formatByteSize(category.reclaimableBytes)}
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
          <span className="block truncate text-[11px] text-muted-foreground">
            {target.disabledReason ?? target.detail ?? target.path ?? category.title}
          </span>
        </span>
      </label>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {formatByteSize(target.bytes)}
        </span>
        <Button size="xs" variant="outline" disabled={isDisabled} onClick={onOpenAction}>
          <Trash2Icon />
          Reclaim
        </Button>
      </div>
    </div>
  );
}

function ResultSummary({ result }: { readonly result: StorageCleanupResult }) {
  const visibleWarnings = result.warnings.slice(0, 5);
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-foreground">Last cleanup result</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Reclaimed {formatByteSize(result.reclaimedBytes)}.
          {result.warnings.length > 0 ? ` ${result.warnings.length} warning(s).` : ""}
        </p>
      </div>
      <div className="space-y-2">
        {result.results.map((entry) => (
          <div
            key={entry.categoryId}
            className="rounded-lg border border-border bg-background px-3 py-2"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-foreground">{entry.categoryId}</span>
              <span className="text-xs text-muted-foreground">
                {entry.status} · {formatByteSize(entry.reclaimedBytes)}
              </span>
            </div>
            {entry.message ? (
              <p className="mt-1 text-xs text-muted-foreground">{entry.message}</p>
            ) : null}
            {entry.warnings.length > 0 ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {entry.warnings[0]?.reason}
              </p>
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
  const [confirmAction, setConfirmAction] = useState<StorageConfirmAction | null>(null);
  const [progress, setProgress] = useState<StorageCleanupProgressPayload | null>(null);
  const [lastResult, setLastResult] = useState<StorageCleanupResult | null>(null);
  const usageQuery = useQuery({
    queryKey: storageQueryKey,
    queryFn: () => ensureNativeApi().storage.getUsage(),
    retry: false,
  });
  const report = usageQuery.data ?? null;
  const sections = useMemo(
    () =>
      report
        ? usageBySection(report)
        : new Map<StorageCleanupCategoryUsage["section"], StorageCleanupCategoryUsage[]>(),
    [report],
  );
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
    setSelectedIds(
      new Set(
        report.categories
          .filter(
            (category) =>
              !isTargetLevelCategoryId(category.id) &&
              category.defaultSelected &&
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
        !category.defaultSelected ||
        category.availability !== "ready"
      ) {
        continue;
      }
      const targetIds = category.targets
        .filter(isSelectableCleanupTarget)
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
    const unsubscribeProgress = api.storage.onCleanupProgress(setProgress);
    return () => {
      unsubscribeInvalidated();
      unsubscribeProgress();
    };
  }, [queryClient]);

  const cleanupMutation = useMutation({
    mutationFn: async ({
      action,
      confirmationText,
    }: {
      readonly action: StorageConfirmAction;
      readonly confirmationText: string | undefined;
    }) => {
      if (!report) {
        throw new Error("Storage usage has not been scanned.");
      }
      const categoryIds = action.categories.map((category) => category.id);
      return ensureNativeApi().storage.cleanup({
        operationId: operationId(),
        scanId: report.scanId,
        confirmationNonce: report.confirmationNonce,
        categoryIds,
        ...(action.targetSelections ? { targetSelections: action.targetSelections } : {}),
        ...(confirmationText ? { confirmationText } : {}),
      });
    },
    onSuccess: (result) => {
      if (result) {
        setLastResult(result);
      }
      setConfirmAction(null);
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: storageQueryKey });
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

  const running = cleanupMutation.isPending;
  const hasRunnableSelection = selectedCategories.some((category) =>
    category.id === "databaseVacuum"
      ? category.bytes > 0
      : category.reclaimableBytes > 0 || category.targetCount > 0,
  );

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Storage</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Inspect local F5 state and reclaim data by explicit action.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={usageQuery.isFetching || running}
              onClick={() =>
                void queryClient.fetchQuery({
                  queryKey: storageQueryKey,
                  queryFn: () => ensureNativeApi().storage.getUsage({ force: true }),
                })
              }
            >
              <RefreshCwIcon />
              Refresh
            </Button>
            <Button
              size="xs"
              disabled={running || selectedCategories.length === 0 || !hasRunnableSelection}
              onClick={openSelectedAction}
            >
              <Trash2Icon />
              Reclaim selected
            </Button>
          </div>
        </div>

        {usageQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Scanning storage
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

        {running && progress ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
              <span className="truncate">{progress.message}</span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                if (progress.operationId) {
                  void ensureNativeApi().storage.cancelCleanup({
                    operationId: progress.operationId,
                  });
                }
              }}
            >
              <XIcon />
              Cancel
            </Button>
          </div>
        ) : null}
      </section>

      {lastResult ? <ResultSummary result={lastResult} /> : null}

      {report ? (
        <>
          {(["database", "worktrees", "logs", "legacy"] as const).map((sectionId) => {
            const categories = sections.get(sectionId) ?? [];
            if (categories.length === 0) return null;
            const sectionBytes =
              sectionId === "database"
                ? report.databaseBytes
                : sectionId === "worktrees"
                  ? report.worktreesBytes
                  : sectionId === "logs"
                    ? report.logsBytes
                    : report.legacyBytes;
            return (
              <section key={sectionId} className="rounded-2xl border border-border bg-card p-5">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">
                      {SECTION_TITLES[sectionId]} ({formatByteSize(sectionBytes)})
                    </h2>
                    {sectionId === "logs" ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Provider event logs across {report.providerLogSegmentCount} thread segments.
                        Server, observability, and terminal logs are kept.
                      </p>
                    ) : sectionId === "legacy" && report.legacyCleanupDisabledReason ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {report.legacyCleanupDisabledReason}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="space-y-2">
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
                        <CategoryRow
                          category={category}
                          selected={categorySelected}
                          indeterminate={categoryIndeterminate}
                          disabled={running}
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
                          ? category.targets.map((target) => (
                              <TargetRow
                                key={target.id}
                                category={category}
                                target={target}
                                selected={
                                  selectedTargets.has(target.id) &&
                                  isSelectableCleanupTarget(target)
                                }
                                disabled={running}
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
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <section className="rounded-2xl border border-border bg-card p-5">
            <div>
              <h2 className="text-sm font-medium text-foreground">
                Attachments ({formatByteSize(report.attachmentsBytes)})
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                No standalone attachment cleanup in this version. Purging deleted threads removes
                their attachments.
              </p>
            </div>
          </section>
        </>
      ) : null}

      <StorageActionConfirmDialog
        action={confirmAction}
        open={confirmAction !== null}
        pending={running}
        lastResult={lastResult}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        onConfirm={(confirmationText) => {
          if (confirmAction) {
            cleanupMutation.mutate({ action: confirmAction, confirmationText });
          }
        }}
      />
    </>
  );
}
