import { useState, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { invalidateUsageAccounts } from "../../lib/usageReactQuery";
import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
} from "../ui/alert-dialog";

export function resetCreditStorageKey(instanceId: ProviderInstanceId, grantId?: string): string {
  return `f5:reset-credit:${instanceId}${grantId ? `:${grantId}` : ""}`;
}

function readStoredKey(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function ResetCreditButton(props: {
  instanceId: ProviderInstanceId;
  accountName: string;
  count: number;
  /** Codex: the windows the credit resets, for the default dialog text. */
  windowName?: string;
  /** Claude: the limit-reset grant this button claims. */
  grantId?: string;
  /** What one use is called on the button ("Full reset"); defaults to "reset credit". */
  label?: string;
  title?: string;
  description?: ReactNode;
  /** Why the reset can't be used now. Disables the button unless a claim is pending. */
  disabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storageKey = resetCreditStorageKey(props.instanceId, props.grantId);
  const key = useRef<string | null>(readStoredKey(storageKey));
  const client = useQueryClient();
  const redeem = async () => {
    if (pending) return;
    key.current ??= crypto.randomUUID();
    try {
      localStorage.setItem(storageKey, key.current);
    } catch {
      // The server still deduplicates the in-flight key.
    }
    setPending(true);
    setError(null);
    try {
      const result = await ensureNativeApi().usage.consumeResetCredit({
        providerInstanceId: props.instanceId,
        idempotencyKey: key.current,
        ...(props.grantId ? { grantId: props.grantId } : {}),
      });
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Nothing to clear.
      }
      key.current = null;
      if (result.outcome !== "reset" && result.outcome !== "alreadyRedeemed") {
        const message =
          result.message ??
          (result.outcome === "noCredit"
            ? "No reset credits remain."
            : result.outcome === "unavailable"
              ? "This reset can't be used right now."
              : "This account has no exhausted window to reset.");
        // The server sends the time; format it in the viewer's locale and zone.
        setError(
          result.retryAt
            ? `${message} Try again after ${formatAbsoluteTimeLabel(result.retryAt)}.`
            : message,
        );
      } else setOpen(false);
      await invalidateUsageAccounts(client);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The outcome could not be confirmed. Retry to check the same redemption.",
      );
    } finally {
      setPending(false);
    }
  };
  const checking = props.count <= 0 || key.current !== null;
  const disabledReason = checking ? null : (props.disabledReason ?? null);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabledReason !== null}
        {...(disabledReason ? { title: disabledReason } : {})}
        onClick={() => setOpen(true)}
      >
        {checking ? "Check" : "Use"} {props.label ?? "reset credit"} ({props.count})
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{props.title ?? "Use a reset credit?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {props.description ??
                `This redeems one credit for ${props.accountName} to reset ${props.windowName ?? "its limits"}.`}
            </AlertDialogDescription>
            {error && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void redeem()}>
              {pending ? "Redeeming…" : "Confirm redemption"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
