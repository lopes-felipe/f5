import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectButton, SelectItem, SelectPopup } from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { PrActionDialogProps } from "./usePrActions";

/**
 * The action dialog (approve / comment / request-changes / merge / mark-ready /
 * re-request / snooze) and the local-clone picker dialog. Fully driven by the
 * state returned from {@link usePrActions}, so a single instance is mounted per
 * visible detail surface (never once per list row).
 */
export function PrActionDialogs({
  pr,
  pendingAction,
  setPendingAction,
  dialogTitle,
  body,
  setBody,
  reviewers,
  setReviewers,
  mergeMethod,
  setMergeMethod,
  snoozeUntil,
  setSnoozeUntil,
  isRunning,
  runAction,
  candidatePicker,
  setCandidatePicker,
  openInF5,
}: PrActionDialogProps) {
  return (
    <>
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {pr.repository.nameWithOwner}#{pr.number} · {pr.title}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {pendingAction === "approve" ||
            pendingAction === "comment" ||
            pendingAction === "requestChanges" ? (
              <Textarea
                value={body}
                onChange={(event) => setBody(event.currentTarget.value)}
                placeholder={pendingAction === "approve" ? "Optional review note" : "Comment"}
              />
            ) : null}
            {pendingAction === "merge" ? (
              <Select
                value={mergeMethod}
                onValueChange={(value) => setMergeMethod(value as typeof mergeMethod)}
              >
                <SelectButton size="sm">{mergeMethod}</SelectButton>
                <SelectPopup>
                  <SelectItem value="squash">squash</SelectItem>
                  <SelectItem value="merge">merge</SelectItem>
                  <SelectItem value="rebase">rebase</SelectItem>
                </SelectPopup>
              </Select>
            ) : null}
            {pendingAction === "reRequestReview" ? (
              <Textarea
                value={reviewers}
                onChange={(event) => setReviewers(event.currentTarget.value)}
                placeholder="reviewer1, reviewer2"
              />
            ) : null}
            {pendingAction === "snooze" ? (
              <input
                className="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm"
                type="datetime-local"
                value={snoozeUntil.slice(0, 16)}
                onChange={(event) => {
                  // Clearing or partially editing the field yields "" / an
                  // invalid date; ignore those so the dialog never crashes on
                  // `new Date("").toISOString()`.
                  const date = new Date(event.currentTarget.value);
                  if (Number.isFinite(date.getTime())) setSnoozeUntil(date.toISOString());
                }}
              />
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              onClick={() => void runAction()}
              disabled={
                isRunning || (pendingAction === "reRequestReview" && reviewers.trim().length === 0)
              }
            >
              {isRunning ? "Working..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={candidatePicker !== null}
        onOpenChange={(open) => !open && setCandidatePicker(null)}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Choose local clone</DialogTitle>
            <DialogDescription>{pr.repository.nameWithOwner}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            {(candidatePicker ?? []).map((candidate) => (
              <button
                key={`${candidate.projectId}:${candidate.cwd}`}
                type="button"
                className="flex w-full min-w-0 flex-col rounded-lg border border-border px-3 py-2 text-left hover:bg-accent"
                onClick={() => void openInF5(candidate)}
              >
                <span className="truncate text-sm font-medium">{candidate.projectTitle}</span>
                <span className="truncate text-xs text-muted-foreground">{candidate.cwd}</span>
              </button>
            ))}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
