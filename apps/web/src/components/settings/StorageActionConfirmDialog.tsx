import { cleanupRequiresTypedDelete, selectedCategoryBytes } from "@t3tools/shared/storageCleanup";
import type {
  StorageCleanupCategoryUsage,
  StorageCleanupResult,
  StorageCleanupTargetSelection,
  StorageCleanupProgressPayload,
  StorageConfirmation,
} from "@t3tools/contracts";
import { formatByteSize } from "@t3tools/shared/byteSize";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";

export interface StorageConfirmAction {
  readonly confirmation?: StorageConfirmation | undefined;
  readonly backendEpoch?: string | undefined;
  readonly description?: string | undefined;
  readonly categories: ReadonlyArray<StorageCleanupCategoryUsage>;
  readonly targetSelections?: ReadonlyArray<StorageCleanupTargetSelection> | undefined;
  readonly title: string;
}

export function StorageActionConfirmDialog({
  action,
  open,
  pending,
  actionable = true,
  onExpired,
  progress,
  onCancelCleanup,
  onOpenChange,
  onConfirm,
}: {
  readonly action: StorageConfirmAction | null;
  readonly open: boolean;
  readonly pending: boolean;
  readonly actionable?: boolean;
  readonly onExpired?: () => void;
  readonly progress?: StorageCleanupProgressPayload | null;
  readonly onCancelCleanup?: () => void;
  readonly lastResult: StorageCleanupResult | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (confirmationText: string | undefined, archiveIdleThreads?: boolean) => void;
}) {
  const [confirmationText, setConfirmationText] = useState("");
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const requiresArchive =
    action?.categories.some((category) =>
      category.targets.some((target) => target.action === "archiveAndRemove"),
    ) ?? false;
  const expiredNonce = useRef<string | null>(null);
  const selections = useMemo(
    () =>
      new Map(
        action?.targetSelections?.map((selection) => [
          selection.categoryId,
          new Set(selection.targetIds),
        ]),
      ),
    [action],
  );
  const totalBytes =
    action?.categories.reduce(
      (total, category) =>
        total +
        (category.id === "databaseVacuum"
          ? category.reclaimableBytes
          : selectedCategoryBytes({ category, selectedTargetIds: selections.get(category.id) })),
      0,
    ) ?? 0;
  const requiresDelete = action
    ? cleanupRequiresTypedDelete({ categories: action.categories, targetSelections: selections })
    : false;
  const canSubmit =
    actionable &&
    !pending &&
    action?.confirmation !== undefined &&
    (!requiresArchive || archiveConfirmed) &&
    (!requiresDelete || confirmationText === "DELETE");
  useEffect(() => {
    setConfirmationText("");
    setArchiveConfirmed(false);
  }, [
    JSON.stringify(
      action?.categories.map((category) => ({
        id: category.id,
        bytes: category.bytes,
        reclaimableBytes: category.reclaimableBytes,
        impact: category.impact,
        targets: category.targets.map((target) => ({ id: target.id, bytes: target.bytes })),
      })),
    ),
  ]);
  useEffect(() => {
    if (!action?.confirmation || expiredNonce.current === action.confirmation.nonce) return;
    const nonce = action.confirmation.nonce;
    const timer = setTimeout(
      () => {
        expiredNonce.current = nonce;
        onExpired?.();
      },
      Math.max(0, Date.parse(action.confirmation.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [action?.confirmation, onExpired]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setConfirmationText("");
          setArchiveConfirmed(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{action?.title ?? "Confirm cleanup"}</DialogTitle>
          <DialogDescription>
            {action?.description ??
              `The selected targets contain an estimated ${formatByteSize(totalBytes)}. Actual recovered disk space may differ.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {action?.categories.some((category) =>
            category.targets.some((target) => target.action === "archiveAndRemove"),
          ) ? (
            <div className="space-y-2 rounded border border-border p-3 text-xs">
              <p>
                These idle conversations will be archived before their checkout is removed.
                Conversations and Git branches are preserved. If removal fails or is cancelled,
                these conversations remain archived and the checkout stays on disk. You can reopen
                the conversations from Archive.
              </p>
              <ul>
                {action.categories
                  .flatMap((category) =>
                    category.targets.flatMap((target) => target.affectedThreads ?? []),
                  )
                  .filter(
                    (thread, index, all) =>
                      all.findIndex((t) => t.threadId === thread.threadId) === index,
                  )
                  .map((thread) => (
                    <li key={thread.threadId}>{thread.title}</li>
                  ))}
              </ul>
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={archiveConfirmed}
                  onCheckedChange={(checked) => setArchiveConfirmed(checked === true)}
                  disabled={pending}
                  aria-label="Archive the listed conversations"
                />
                <span>
                  I agree to archive every listed conversation, including recently used
                  conversations.
                </span>
              </label>
            </div>
          ) : null}
          {pending ? (
            <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {progress?.message ?? "Starting…"}
              <progress
                className="ml-2"
                value={progress?.completedTargets ?? 0}
                max={Math.max(1, progress?.totalTargets ?? 0)}
                aria-label="Cleanup progress"
              />
            </div>
          ) : null}
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background">
            {action?.categories.map((category) => (
              <div key={category.id} className="border-b border-border px-3 py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">
                    {category.title}{" "}
                    <span className="rounded border px-1.5 py-0.5 text-2xs text-muted-foreground">
                      {category.id.startsWith("purge") || category.impact === "high"
                        ? "Permanent"
                        : category.impact === "none"
                          ? "Safe"
                          : "Low"}
                    </span>
                  </p>
                  <p className="shrink-0 text-xs font-medium text-muted-foreground">
                    {formatByteSize(category.reclaimableBytes)}
                  </p>
                </div>
                {category.targets.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {category.targets.slice(0, 12).map((target) => (
                      <li
                        key={target.id}
                        className="truncate font-mono text-2xs text-muted-foreground"
                      >
                        {target.label}
                        {target.threadTitle && target.threadTitle !== target.label
                          ? ` · ${target.threadTitle}`
                          : ""}
                        {target.path ? <span className="block truncate">{target.path}</span> : null}
                        {category.id === "f5Backups" && target.detail ? (
                          <span className="block whitespace-normal">{target.detail}</span>
                        ) : null}
                      </li>
                    ))}
                    {category.targets.length > 12 ? (
                      <li className="text-2xs text-muted-foreground">
                        {category.targets.length - 12} more targets
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>

          {requiresDelete ? (
            <label className="block space-y-2">
              <span className="text-xs font-medium text-foreground">Type DELETE to confirm</span>
              <Input
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.target.value)}
                placeholder="DELETE"
                nativeInput
              />
            </label>
          ) : null}

          {action?.categories.some((category) => category.id === "databaseVacuum") ? (
            <p className="text-xs text-muted-foreground">
              Compacting a{" "}
              {formatByteSize(
                action.categories.find((category) => category.id === "databaseVacuum")!.bytes,
              )}{" "}
              database: F5 stays responsive; conversations wait until compaction finishes.
            </p>
          ) : null}
          {action?.categories.some((category) => category.id.startsWith("purge")) ? (
            <p className="text-xs text-destructive">
              Threads purged here cannot be restored from Archive.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => (pending ? onCancelCleanup?.() : onOpenChange(false))}
            disabled={pending && !onCancelCleanup}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canSubmit}
            onClick={() =>
              requiresArchive
                ? onConfirm(requiresDelete ? confirmationText : undefined, archiveConfirmed)
                : onConfirm(requiresDelete ? confirmationText : undefined)
            }
          >
            {pending ? "Cleaning..." : "Reclaim"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
