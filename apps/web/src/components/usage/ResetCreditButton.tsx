import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { usageQueryKeys } from "../../lib/usageReactQuery";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogDescription,
} from "../ui/alert-dialog";

export function ResetCreditButton(props: {
  instanceId: ProviderInstanceId;
  accountName: string;
  windowName: string;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storageKey = `f5:reset-credit:${props.instanceId}`;
  const key = useRef<string | null>(localStorage.getItem(storageKey));
  const client = useQueryClient();
  const redeem = async () => {
    if (pending) return;
    key.current ??= crypto.randomUUID();
    localStorage.setItem(storageKey, key.current);
    setPending(true);
    setError(null);
    try {
      const result = await ensureNativeApi().usage.consumeResetCredit({
        providerInstanceId: props.instanceId,
        idempotencyKey: key.current,
      });
      localStorage.removeItem(storageKey);
      key.current = null;
      if (result.outcome !== "reset" && result.outcome !== "alreadyRedeemed")
        setError(
          result.outcome === "noCredit"
            ? "No reset credits remain."
            : "This account has no exhausted window to reset.",
        );
      else setOpen(false);
      await client.invalidateQueries({ queryKey: usageQueryKeys.accounts });
    } catch {
      setError("The outcome could not be confirmed. Retry to check the same redemption.");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" disabled={props.count <= 0} onClick={() => setOpen(true)}>
        Use reset credit ({props.count})
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogTitle>Use a reset credit?</AlertDialogTitle>
          <AlertDialogDescription>
            This redeems one credit for {props.accountName} to reset {props.windowName}.
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="my-2 text-sm">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void redeem()}>
              {pending ? "Redeeming…" : "Confirm redemption"}
            </Button>
          </div>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
