import { useState } from "react";
import { Input } from "../ui/input";
import { PrCommentSubmit } from "./PrCommentSubmit";
import { PrReviewSubmit } from "./PrReviewSubmit";
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
import { SnoozePresetPicker } from "../SnoozePresetPicker";

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
  reviewers,
  setReviewers,
  mergeMethod,
  mergeComparison,
  mergeComparisonError,
  reloadMergeComparison,
  setMergeMethod,
  snoozeUntil,
  setSnoozeUntil,
  isRunning,
  runAction,
  candidatePicker,
  setCandidatePicker,
  isOpeningInF5,
  openInF5,
  selectFolder,
}: PrActionDialogProps) {
  const [folderPath, setFolderPath] = useState("");
  const canPickFolder = typeof window !== "undefined" && Boolean(window.desktopBridge);
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
            {pendingAction === "comment" ? <PrCommentSubmit key={pr.key} prKey={pr.key} /> : null}
            {pendingAction === "approve" || pendingAction === "requestChanges" ? (
              <PrReviewSubmit
                key={`${pr.key}:${pendingAction}`}
                prKey={pr.key}
                prUrl={pr.url}
                draft={null}
                disabled={isRunning}
                onBusyChange={() => {}}
                quickEvent={pendingAction === "approve" ? "APPROVE" : "REQUEST_CHANGES"}
              />
            ) : null}
            {pendingAction === "merge" ? (
              <div className="space-y-1 text-xs">
                {mergeComparison ? (
                  <p title={JSON.stringify(mergeComparison)}>
                    Merge {mergeComparison.headRepository}:{mergeComparison.headRef} (
                    {mergeComparison.headOid.slice(0, 12)}) into {mergeComparison.baseRepository}:
                    {mergeComparison.baseRef} ({mergeComparison.baseOid.slice(0, 12)}). Merge base:{" "}
                    {mergeComparison.mergeBaseOid.slice(0, 12)}.
                  </p>
                ) : (
                  <p role="status">{mergeComparisonError ?? "Loading merge comparison?"}</p>
                )}
                {mergeComparisonError ? (
                  <Button size="xs" variant="outline" onClick={reloadMergeComparison}>
                    Retry comparison
                  </Button>
                ) : null}
              </div>
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
              <SnoozePresetPicker value={snoozeUntil} onChange={setSnoozeUntil} />
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            {pendingAction !== "approve" &&
            pendingAction !== "requestChanges" &&
            pendingAction !== "comment" ? (
              <Button
                onClick={() => void runAction()}
                disabled={
                  isRunning ||
                  (pendingAction === "merge" && !mergeComparison) ||
                  (pendingAction === "reRequestReview" && reviewers.trim().length === 0)
                }
              >
                {isRunning ? "Working..." : "Confirm"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={candidatePicker !== null}
        onOpenChange={(open) => {
          if (!open && !isOpeningInF5) {
            setCandidatePicker(null);
            setFolderPath("");
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {candidatePicker?.error
                ? "Could not resolve local repository"
                : candidatePicker?.candidates.length === 0
                  ? "No matching F5 project"
                  : candidatePicker?.intent === "open"
                    ? "Choose local clone"
                    : "Choose clone for F5 run"}
            </DialogTitle>
            <DialogDescription>
              F5 checks registered projects and your configured base directory for{" "}
              {pr.repository.nameWithOwner}. Selecting a matching folder adds it as a project and
              continues the requested action.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            {candidatePicker?.error && (
              <p role="alert" className="text-sm text-destructive">
                {candidatePicker.error}
              </p>
            )}
            {(candidatePicker?.candidates ?? []).map((candidate) => (
              <button
                key={`${candidate.projectId}:${candidate.cwd}`}
                type="button"
                className="flex w-full min-w-0 flex-col rounded-lg border border-border px-3 py-2 text-left hover:bg-accent"
                disabled={isOpeningInF5}
                onClick={() => {
                  if (candidatePicker) void openInF5(candidate, candidatePicker.intent);
                }}
              >
                <span className="truncate text-sm font-medium">{candidate.projectTitle}</span>
                <span className="truncate text-xs text-muted-foreground">{candidate.cwd}</span>
              </button>
            ))}
            {!canPickFolder && (
              <Input
                aria-label="Existing repository folder"
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                placeholder="Path on the F5 server"
                disabled={isOpeningInF5}
              />
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isOpeningInF5}
              onClick={() => {
                setCandidatePicker(null);
                setFolderPath("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={isOpeningInF5 || (!canPickFolder && !folderPath.trim())}
              onClick={() => void selectFolder(canPickFolder ? undefined : folderPath)}
            >
              Select existing folder
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
