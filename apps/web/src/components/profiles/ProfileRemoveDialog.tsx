import type { ProfileSummary } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useRef } from "react";

import { canStopProfile } from "../../profileActions";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * Confirms profile removal.
 *
 * This replaces a misuse of `StorageActionConfirmDialog`, which was passed an
 * empty category list and therefore rendered a confirm button labelled
 * "Reclaim" over a 0 B total.
 */
export function ProfileRemoveDialog({
  profile,
  pending,
  error,
  onOpenChange,
  onConfirm,
}: {
  readonly profile: ProfileSummary | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const willStopFirst = canStopProfile() && profile !== null && !profile.isActive;

  return (
    <AlertDialog
      open={profile !== null}
      onOpenChange={(open) => {
        if (!open && pending) return;
        onOpenChange(open);
      }}
    >
      <AlertDialogPopup className="sm:max-w-[460px]" initialFocus={cancelRef}>
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>Remove this profile?</AlertDialogTitle>
          <p className="mt-1 text-sm font-medium wrap-anywhere">{profile?.name}</p>
          <AlertDialogDescription>
            Its accounts, projects, and chat history move to{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px]">.trash</code> — nothing is
            deleted immediately. Git worktrees stay registered until you run{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px]">git worktree prune</code>.
            Port {profile?.port} is retired and will not be reused.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {willStopFirst ? (
          <div className="px-6 pb-2">
            <Alert variant="warning" className="text-xs">
              <TriangleAlertIcon />
              <AlertDescription>
                This profile is running. It will be stopped before it is removed.
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {error ? (
          <div className="px-6 pb-2">
            <Alert variant="error" className="text-xs">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        <AlertDialogFooter variant="bare">
          <AlertDialogClose
            render={<Button ref={cancelRef} variant="outline" disabled={pending} />}
          >
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? (
              <>
                <Spinner className="size-3" />
                Removing…
              </>
            ) : (
              "Remove profile"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
