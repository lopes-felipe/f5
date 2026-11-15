import { Switch } from "../ui/switch";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { getPrHubDraftIdentity } from "../../lib/prHubAccount";
import { ForgeComposer } from "./ForgeControls";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import type { PrActionDialogProps, PrPendingAction } from "./usePrActions";
import { SnoozePresetPicker } from "../SnoozePresetPicker";
import { PrReviewerPicker, usePrReviewerCandidates } from "./PrReviewerPicker";
import type { TrackedPullRequest } from "@t3tools/contracts";

type ForgeMethod = "merge" | "squash" | "rebase";

/** Actions whose own form prepares and confirms them; the dialog adds no Confirm button. */
const SELF_CONFIRMING: ReadonlySet<PrPendingAction> = new Set([
  "close",
  "reopen",
  "approve",
  "requestChanges",
  "comment",
  "autoMerge",
  "convertToDraft",
  "updateBranch",
]);

/**
 * The action dialog (approve / comment / request-changes / merge / mark-ready /
 * re-request / snooze) and the local-clone picker dialog. Fully driven by the
 * state returned from {@link usePrActions}, so a single instance is mounted per
 * visible detail surface (never once per list row).
 */
export function PrActionDialogs({
  confirmationMode = "dialog",
  pr,
  pendingAction,
  setPendingAction,
  dialogTitle,
  reviewers,
  setReviewers,
  mergeMethod,
  deleteBranch = false,
  setDeleteBranch,
  allowedMergeMethods,
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
}: PrActionDialogProps & { confirmationMode?: "dialog" | "inline" }) {
  const [folderPath, setFolderPath] = useState("");
  const [branchChoiceLocked, setBranchChoiceLocked] = useState(false);
  const [reviewBody, setReviewBody] = useLocalStorage(
    JSON.stringify(["nativeQuickReview", getPrHubDraftIdentity(), pr.key, pendingAction]),
    "",
    Schema.String,
  );
  const native = pr.provider !== "github";
  const nativeCaps = pr.forgeCapabilities;
  const availableMergeMethods = native ? (nativeCaps?.mergeMethods ?? []) : allowedMergeMethods;
  // Merge when ready and Update branch pick a method of their own; both start on the
  // first one the forge offers.
  const forgeMethods =
    pendingAction === "updateBranch"
      ? (nativeCaps?.updateMethods ?? [])
      : pendingAction === "autoMerge"
        ? availableMergeMethods
        : [];
  const [forgeMethodChoice, setForgeMethodChoice] = useState<ForgeMethod | null>(null);
  useEffect(() => setForgeMethodChoice(null), [pendingAction, pr.key]);
  const preferredMethod =
    forgeMethodChoice ?? (pendingAction === "autoMerge" ? mergeMethod : null) ?? forgeMethods[0];
  const forgeMethod =
    preferredMethod && forgeMethods.includes(preferredMethod) ? preferredMethod : forgeMethods[0];
  useEffect(() => {
    setFolderPath("");
  }, [candidatePicker === null, pr.key]);
  const canPickFolder = typeof window !== "undefined" && Boolean(window.desktopBridge);
  return (
    <>
      <PrActionConfirmation
        mode={confirmationMode}
        open={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        title={dialogTitle}
        description={`${pr.repository.nameWithOwner}#${pr.number} · ${pr.title}`}
      >
        <DialogPanel className="space-y-3">
          {(pendingAction === "merge" || pendingAction === "close") &&
          pr.provider === "github" &&
          nativeCaps?.actions.includes("delete-branch") ? (
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Delete source branch after {pendingAction}</p>
                <p className="text-xs text-muted-foreground">
                  Remote deletion checks the reviewed head. Local branches used by a worktree or
                  changed since review are kept.
                </p>
              </div>
              <Switch
                aria-label="Delete source branch after this action"
                checked={deleteBranch}
                disabled={isRunning || branchChoiceLocked || !setDeleteBranch}
                onCheckedChange={setDeleteBranch}
              />
            </div>
          ) : null}
          {pendingAction === "comment" ? (
            pr.provider === "github" ? (
              <PrCommentSubmit key={pr.key} prKey={pr.key} />
            ) : (
              <ForgeComposer pr={pr} />
            )
          ) : null}
          {pendingAction === "approve" || pendingAction === "requestChanges" ? (
            pr.provider !== "github" ? (
              nativeCaps?.review.verdicts.includes(
                pendingAction === "approve" ? "approve" : "request-changes",
              ) ? (
                <div className="space-y-2">
                  <Textarea
                    aria-label="Review explanation"
                    value={reviewBody}
                    onChange={(event) => setReviewBody(event.target.value)}
                  />
                  <ForgeOperationPanel
                    pr={pr}
                    payload={{
                      kind: "review",
                      body: reviewBody,
                      verdict: pendingAction === "approve" ? "approve" : "request-changes",
                    }}
                    label={pendingAction === "approve" ? "Approve" : "Request changes"}
                    onSucceeded={() => {
                      setReviewBody("");
                      setPendingAction(null);
                    }}
                  />
                </div>
              ) : null
            ) : (
              <PrReviewSubmit
                key={`${pr.key}:${pendingAction}`}
                prKey={pr.key}
                prUrl={pr.url}
                draft={null}
                disabled={isRunning}
                onBusyChange={() => {}}
                quickEvent={pendingAction === "approve" ? "APPROVE" : "REQUEST_CHANGES"}
              />
            )
          ) : null}
          {pendingAction === "merge" && !native ? (
            <div className="space-y-1 text-xs">
              {mergeComparison ? (
                <p title={JSON.stringify(mergeComparison)}>
                  Merge {mergeComparison.headRepository}:{mergeComparison.headRef} (
                  {mergeComparison.headOid.slice(0, 12)}) into {mergeComparison.baseRepository}:
                  {mergeComparison.baseRef} ({mergeComparison.baseOid.slice(0, 12)}). Merge base:{" "}
                  {mergeComparison.mergeBaseOid.slice(0, 12)}.
                </p>
              ) : (
                <p role="status">{mergeComparisonError ?? "Loading merge comparison…"}</p>
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
              onValueChange={(value) =>
                value && setMergeMethod(value as "squash" | "merge" | "rebase")
              }
            >
              <SelectButton size="sm">
                {mergeMethod ?? "Refresh PR hub to load merge methods"}
              </SelectButton>
              <SelectPopup>
                {availableMergeMethods.map((method) => (
                  <SelectItem key={method} value={method}>
                    {method}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {pendingAction === "reRequestReview" ? (
            <ReRequestReviewers
              pr={pr}
              value={reviewers}
              onChange={setReviewers}
              disabled={isRunning}
            />
          ) : null}
          {pendingAction === "autoMerge" || pendingAction === "updateBranch" ? (
            <>
              <p className="text-sm text-muted-foreground">
                {pendingAction === "autoMerge"
                  ? "The forge merges this pull request by itself once its required reviews and checks pass."
                  : `Brings ${pr.headRefName || "the branch"} up to date with ${
                      pr.baseRefName || "its base branch"
                    }.`}
              </p>
              {forgeMethods.length > 1 ? (
                <Select
                  value={forgeMethod ?? null}
                  onValueChange={(value) => value && setForgeMethodChoice(value as ForgeMethod)}
                >
                  <SelectButton
                    size="sm"
                    aria-label={pendingAction === "autoMerge" ? "Merge method" : "Update method"}
                  >
                    {forgeMethod}
                  </SelectButton>
                  <SelectPopup>
                    {forgeMethods.map((method) => (
                      <SelectItem key={method} value={method}>
                        {method}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
              {forgeMethod ? (
                <ForgeOperationPanel
                  pr={pr}
                  payload={{
                    kind: "action",
                    action: pendingAction === "autoMerge" ? "enable-auto-merge" : "update-branch",
                    method: forgeMethod,
                  }}
                  label={pendingAction === "autoMerge" ? "Merge when ready" : "Branch update"}
                  onSucceeded={() => setPendingAction(null)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {pendingAction === "autoMerge"
                    ? "Refresh the PR hub to load the repository's merge methods."
                    : "This forge cannot update the branch from here."}
                </p>
              )}
            </>
          ) : null}
          {pendingAction === "convertToDraft" ? (
            <ForgeOperationPanel
              pr={pr}
              payload={{ kind: "action", action: "draft" }}
              label="Convert to draft"
              onSucceeded={() => setPendingAction(null)}
            />
          ) : null}
          {native &&
          pendingAction === "merge" &&
          mergeMethod &&
          availableMergeMethods.includes(mergeMethod) ? (
            <ForgeOperationPanel
              pr={pr}
              payload={{
                kind: "action",
                action: "merge",
                method: mergeMethod,
                ...(deleteBranch ? { deleteBranch: true } : {}),
              }}
              onPendingChange={setBranchChoiceLocked}
              label="Merge"
              onSucceeded={() => setPendingAction(null)}
            />
          ) : null}
          {native && pendingAction === "markReady" && nativeCaps?.actions.includes("ready") ? (
            <ForgeOperationPanel
              pr={pr}
              payload={{ kind: "action", action: "ready" }}
              label="Mark ready"
              onSucceeded={() => setPendingAction(null)}
            />
          ) : null}
          {native &&
          pendingAction === "reRequestReview" &&
          reviewers.length > 0 &&
          nativeCaps?.reviewers.request ? (
            <ForgeOperationPanel
              pr={pr}
              payload={{ kind: "reviewers", reviewers }}
              label="Request reviewers"
              onSucceeded={() => setPendingAction(null)}
            />
          ) : null}
          {pendingAction === "close" || pendingAction === "reopen" ? (
            <ForgeOperationPanel
              pr={pr}
              payload={{
                kind: "action",
                action: pendingAction,
                ...(deleteBranch ? { deleteBranch: true } : {}),
              }}
              onPendingChange={setBranchChoiceLocked}
              label={pendingAction === "close" ? "Close pull request" : "Reopen pull request"}
              onSucceeded={() => setPendingAction(null)}
            />
          ) : null}
          {pendingAction === "snooze" ? (
            <SnoozePresetPicker value={snoozeUntil} onChange={setSnoozeUntil} />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingAction(null)}>
            Cancel
          </Button>
          {pendingAction !== null &&
          !SELF_CONFIRMING.has(pendingAction) &&
          (!native || pendingAction === "snooze") ? (
            <Button
              onClick={() => void runAction()}
              disabled={
                isRunning ||
                (pendingAction === "merge" && (!mergeComparison || !mergeMethod)) ||
                (pendingAction === "reRequestReview" && reviewers.length === 0)
              }
            >
              {isRunning ? "Working..." : "Confirm"}
            </Button>
          ) : null}
        </DialogFooter>
      </PrActionConfirmation>

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
              F5 checks registered projects and, when configured, the base directory for{" "}
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

/** The reviewers of a re-request, picked from the forge's candidates. */
function ReRequestReviewers({
  pr,
  value,
  onChange,
  disabled,
}: {
  pr: TrackedPullRequest;
  value: readonly string[];
  onChange: (value: readonly string[]) => void;
  disabled: boolean;
}) {
  const native = pr.provider !== "github";
  const { set, isPending } = usePrReviewerCandidates(
    pr,
    !!pr.forgeCapabilities?.reviewers.listCandidates,
  );
  // Other forges replace the whole reviewer set by id, so the picker starts from the
  // forge's own list instead of the names saved with the pull request.
  const seeded = useRef(false);
  useEffect(() => {
    if (!native || seeded.current || !set?.known) return;
    seeded.current = true;
    onChange(set.current.map((reviewer) => reviewer.id));
  }, [native, set, onChange]);
  return (
    <>
      {native && set && !set.known ? (
        <p role="alert" className="text-xs">
          Existing reviewer identities could not be verified. Refresh before changing reviewers.
        </p>
      ) : null}
      <PrReviewerPicker
        pr={pr}
        set={set}
        isLoading={isPending}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </>
  );
}

/** Panel confirmations share the same form and submit path without covering the conversation. */
function PrActionConfirmation(props: {
  mode: "dialog" | "inline";
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const inlineRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.mode === "inline" && props.open) {
      inlineRef.current?.focus({ preventScroll: true });
      inlineRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [props.mode, props.open, props.title]);
  if (props.mode === "inline")
    return props.open ? (
      <section
        data-pr-inline-confirmation
        ref={inlineRef}
        tabIndex={-1}
        aria-label={props.title}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div className="space-y-1 px-6 pt-5 pb-3">
          <h3 className="font-semibold">{props.title}</h3>
          <p className="text-sm text-muted-foreground">{props.description}</p>
        </div>
        {props.children}
      </section>
    ) : null;
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {props.children}
      </DialogPopup>
    </Dialog>
  );
}
