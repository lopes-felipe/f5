import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FilePenLineIcon,
  GitMergeIcon,
  MessageSquareIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { Fragment } from "react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { PR_AGENT_ACTIONS, prPageActionAvailability, type PrRowAction } from "./prQueueModel";
import type { PrActionFlags, PrActionHandlers, PrMergeMethod } from "./usePrActions";

const MERGE_METHOD_LABELS: Record<PrMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

function copy(value: string, what: string) {
  void writeTextToClipboard(value).then(
    () => toastManager.add({ type: "success", title: `${what} copied` }),
    () => toastManager.add({ type: "error", title: `Could not copy the ${what.toLowerCase()}` }),
  );
}

export interface PrPageActionsProps {
  pr: TrackedPullRequest;
  /** The contextual next step, the same one the queue row offers. */
  primary: PrRowAction | null;
  flags: PrActionFlags;
  handlers: PrActionHandlers;
  mergeMethod: PrMergeMethod | null;
  mergeMethods: readonly PrMergeMethod[];
  onMergeMethodChange: (method: PrMergeMethod) => void;
  isOpeningInF5: boolean;
  /** Label of the agent run that fits this pull request, or null when none does. */
  runInF5Label: string | null;
  onPrimary: () => void;
  isAnalyzingAdvisory?: boolean;
  onAnalyzeAdvisory?: (() => void) | undefined;
  /** Set inside a thread: that thread can follow this pull request. */
  watch?: { watched: boolean; busy: boolean; onToggle: () => void } | undefined;
}

/**
 * The action bar of the pull request page: one contextual primary step, the merge or
 * review choices next to it, Snooze, and everything else behind the overflow menu.
 */
export function PrPageActions({
  pr,
  primary,
  flags,
  handlers,
  mergeMethod,
  mergeMethods,
  onMergeMethodChange,
  isOpeningInF5,
  runInF5Label,
  onPrimary,
  isAnalyzingAdvisory = false,
  onAnalyzeAdvisory,
  watch,
}: PrPageActionsProps) {
  const can = prPageActionAvailability(pr);
  const forge = pr.provider === "github" ? "GitHub" : "the forge";
  const mergeIsPrimary = primary?.kind === "merge";
  const showMerge = can.canMerge || can.canMergeWhenReady;
  const reviewChoices = can.canApprove || can.canComment || can.canRequestChanges;
  const primaryIsAgent = primary !== null && PR_AGENT_ACTIONS.has(primary.kind);
  const primaryBusy = isOpeningInF5 && primaryIsAgent;
  const branch = pr.headRefName;

  // The overflow menu, in sections: F5, changes to the pull request, copy and open, hide.
  const sections = [
    [
      runInF5Label && !primaryIsAgent && primary?.kind !== "open_thread" ? (
        <MenuItem key="run" disabled={isOpeningInF5} onClick={handlers.onRunInF5}>
          <SparklesIcon /> {runInF5Label}
        </MenuItem>
      ) : null,
      flags.isOpen ? (
        <MenuItem key="open-f5" disabled={isOpeningInF5} onClick={handlers.onOpenInF5}>
          <SquareArrowOutUpRightIcon /> Open in F5
        </MenuItem>
      ) : null,
      can.canIgnore && onAnalyzeAdvisory ? (
        <MenuItem key="advisory" disabled={isAnalyzingAdvisory} onClick={onAnalyzeAdvisory}>
          <SparklesIcon /> {isAnalyzingAdvisory ? "Analyzing…" : "Get an AI recommendation"}
        </MenuItem>
      ) : null,
      watch ? (
        <MenuItem key="watch" disabled={watch.busy} onClick={watch.onToggle}>
          {watch.watched ? <BellOffIcon /> : <BellIcon />}
          {watch.watched ? "Stop watching from this thread" : "Watch from this thread"}
        </MenuItem>
      ) : null,
    ],
    [
      can.canComment && primary?.kind !== "review" ? (
        <MenuItem key="comment" onClick={handlers.onComment}>
          <MessageSquareIcon /> Comment…
        </MenuItem>
      ) : null,
      can.canReRequest ? (
        <MenuItem key="re-request" onClick={handlers.onReRequest}>
          <RefreshCwIcon /> Re-request review…
        </MenuItem>
      ) : null,
      can.canMarkReady && primary?.kind !== "mark_ready" ? (
        <MenuItem key="ready" onClick={handlers.onMarkReady}>
          <SendIcon /> Mark ready…
        </MenuItem>
      ) : null,
      can.canConvertToDraft ? (
        <MenuItem key="draft" onClick={handlers.onConvertToDraft}>
          <FilePenLineIcon /> Convert to draft…
        </MenuItem>
      ) : null,
      can.canClose ? (
        <MenuItem key="close" onClick={handlers.onClose}>
          <CircleSlashIcon /> Close…
        </MenuItem>
      ) : null,
      can.canReopen ? (
        <MenuItem key="reopen" onClick={handlers.onReopen}>
          <RotateCcwIcon /> Reopen…
        </MenuItem>
      ) : null,
    ],
    [
      <MenuItem key="copy-link" onClick={() => copy(pr.url, "Link")}>
        <CopyIcon /> Copy link
      </MenuItem>,
      <MenuItem key="copy-number" onClick={() => copy(String(pr.number), "Number")}>
        <CopyIcon /> Copy number
      </MenuItem>,
      branch ? (
        <MenuItem key="copy-branch" onClick={() => copy(branch, "Branch name")}>
          <CopyIcon /> Copy branch name
        </MenuItem>
      ) : null,
      <MenuItem key="forge" onClick={handlers.onOpenGitHub}>
        <ExternalLinkIcon /> Open on {forge}
      </MenuItem>,
    ],
    [
      flags.isIgnored ? (
        <MenuItem key="restore" onClick={handlers.onRestore}>
          <ArchiveRestoreIcon /> Restore to the queue
        </MenuItem>
      ) : can.canIgnore ? (
        <MenuItem
          key="ignore"
          variant="destructive"
          disabled={flags.isIgnoring}
          onClick={handlers.onIgnore}
        >
          <ArchiveIcon /> {flags.isIgnoring ? "Ignoring…" : "Ignore"}
        </MenuItem>
      ) : null,
    ],
  ]
    .map((items) => items.filter((item) => item !== null))
    .filter((items) => items.length > 0);

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Actions">
      {primary?.kind === "review" ? (
        <Group aria-label="Review">
          <Button size="sm" onClick={onPrimary}>
            Review
          </Button>
          {reviewChoices ? (
            <>
              <GroupSeparator />
              <Menu>
                <MenuTrigger render={<Button aria-label="Review options" size="icon-sm" />}>
                  <ChevronDownIcon aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-48">
                  {can.canApprove ? (
                    <MenuItem onClick={handlers.onApprove}>
                      <CheckIcon /> Approve…
                    </MenuItem>
                  ) : null}
                  {can.canComment ? (
                    <MenuItem onClick={handlers.onComment}>
                      <MessageSquareIcon /> Comment…
                    </MenuItem>
                  ) : null}
                  {can.canRequestChanges ? (
                    <MenuItem onClick={handlers.onRequestChanges}>
                      <XIcon /> Request changes…
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </>
          ) : null}
        </Group>
      ) : primary && !mergeIsPrimary ? (
        <Button size="sm" disabled={primaryBusy} onClick={onPrimary}>
          {primaryBusy ? "Starting…" : primary.label}
        </Button>
      ) : null}

      {showMerge ? (
        <Group aria-label="Merge">
          <Button
            size="sm"
            variant={mergeIsPrimary ? "default" : "outline"}
            onClick={can.canMerge ? handlers.onMerge : handlers.onMergeWhenReady}
          >
            <GitMergeIcon /> {can.canMerge ? "Merge" : "Merge when ready"}
          </Button>
          <GroupSeparator />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label="Merge options"
                  size="icon-sm"
                  variant={mergeIsPrimary ? "default" : "outline"}
                />
              }
            >
              <ChevronDownIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-56">
              {can.canMerge ? <MenuItem onClick={handlers.onMerge}>Merge now…</MenuItem> : null}
              {can.canMergeWhenReady ? (
                <MenuItem onClick={handlers.onMergeWhenReady}>Merge when ready…</MenuItem>
              ) : null}
              {mergeMethods.length > 1 ? (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Method</MenuGroupLabel>
                    <MenuRadioGroup
                      value={mergeMethod ?? ""}
                      onValueChange={(value) => onMergeMethodChange(value as PrMergeMethod)}
                    >
                      {mergeMethods.map((method) => (
                        <MenuRadioItem key={method} value={method} closeOnClick={false}>
                          {MERGE_METHOD_LABELS[method]}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </Group>
      ) : null}

      {can.canSnooze ? (
        flags.isSnoozed ? (
          <Button size="sm" variant="outline" onClick={handlers.onUnsnooze}>
            <PlayIcon /> Unsnooze
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={handlers.onSnooze}>
            <PauseIcon /> Snooze
          </Button>
        )
      ) : null}

      <Menu>
        <MenuTrigger render={<Button aria-label="More actions" size="icon-sm" variant="outline" />}>
          <EllipsisIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-56">
          {sections.map((items, index) => (
            // The sections are fixed in order; only whole empty ones drop out.
            <Fragment key={index}>
              {index > 0 ? <MenuSeparator /> : null}
              {items}
            </Fragment>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}
