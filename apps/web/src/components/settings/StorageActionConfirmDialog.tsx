import type {
  StorageCleanupCategoryUsage,
  StorageCleanupResult,
  StorageCleanupTargetSelection,
} from "@t3tools/contracts";
import { formatByteSize } from "@t3tools/shared/byteSize";
import { useEffect, useMemo, useState } from "react";

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

const TYPED_CONFIRM_THRESHOLD_BYTES = 1024 * 1024 * 1024;

export interface StorageConfirmAction {
  readonly categories: ReadonlyArray<StorageCleanupCategoryUsage>;
  readonly targetSelections?: ReadonlyArray<StorageCleanupTargetSelection>;
  readonly title: string;
}

export function StorageActionConfirmDialog({
  action,
  open,
  pending,
  lastResult,
  onOpenChange,
  onConfirm,
}: {
  readonly action: StorageConfirmAction | null;
  readonly open: boolean;
  readonly pending: boolean;
  readonly lastResult: StorageCleanupResult | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (confirmationText: string | undefined) => void;
}) {
  const [confirmationText, setConfirmationText] = useState("");
  const totalBytes = useMemo(
    () => action?.categories.reduce((total, category) => total + category.reclaimableBytes, 0) ?? 0,
    [action],
  );
  const requiresDelete =
    totalBytes > TYPED_CONFIRM_THRESHOLD_BYTES ||
    action?.categories.some((category) => category.impact === "high") === true;
  const canSubmit = !pending && (!requiresDelete || confirmationText === "DELETE");
  useEffect(() => {
    setConfirmationText("");
  }, [action]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setConfirmationText("");
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{action?.title ?? "Confirm cleanup"}</DialogTitle>
          <DialogDescription>
            This will reclaim up to {formatByteSize(totalBytes)} from the selected storage targets.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background">
            {action?.categories.map((category) => (
              <div key={category.id} className="border-b border-border px-3 py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{category.title}</p>
                  <p className="shrink-0 text-xs font-medium text-muted-foreground">
                    {formatByteSize(category.reclaimableBytes)}
                  </p>
                </div>
                {category.targets.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {category.targets.slice(0, 12).map((target) => (
                      <li
                        key={target.id}
                        className="truncate font-mono text-[11px] text-muted-foreground"
                      >
                        {target.path ?? target.label}
                      </li>
                    ))}
                    {category.targets.length > 12 ? (
                      <li className="text-[11px] text-muted-foreground">
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

          {lastResult ? (
            <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              Last cleanup reclaimed {formatByteSize(lastResult.reclaimedBytes)}.
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canSubmit}
            onClick={() => onConfirm(requiresDelete ? confirmationText : undefined)}
          >
            {pending ? "Cleaning..." : "Reclaim"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
