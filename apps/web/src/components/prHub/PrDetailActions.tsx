import {
  ArchiveIcon,
  CheckIcon,
  EllipsisIcon,
  GithubIcon,
  MessageSquareIcon,
  PauseIcon,
  PlayIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { prRowActionVisibility } from "./prHubPresentation";

export interface PrDetailActionsProps {
  pr: TrackedPullRequest;
  isAuthor: boolean;
  isOpen: boolean;
  isIgnored: boolean;
  isSnoozed: boolean;
  isIgnoring: boolean;
  isAnalyzingAdvisory: boolean;
  isOpeningInF5: boolean;
  runInF5Label: string | null;
  onReview: () => void;
  onApprove: () => void;
  onComment: () => void;
  onRequestChanges: () => void;
  onMerge: () => void;
  onMarkReady: () => void;
  onReRequest: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onIgnore: () => void;
  onAnalyzeAdvisory?: (() => void) | undefined;
  onOpenInF5: () => void;
  onRunInF5: () => void;
  onOpenGitHub: () => void;
}

/**
 * The detail/focus action bar. Unlike the dense list, the detail surface has
 * room to breathe, so the contextual actions are promoted to real buttons
 * (primary + the applicable secondary actions). Only the rare/destructive
 * Ignore stays behind the `⋯` overflow.
 */
export function PrDetailActions({
  pr,
  isAuthor,
  isOpen,
  isIgnored,
  isSnoozed,
  isIgnoring,
  isAnalyzingAdvisory,
  isOpeningInF5,
  runInF5Label,
  onReview,
  onApprove,
  onComment,
  onRequestChanges,
  onMerge,
  onMarkReady,
  onReRequest,
  onSnooze,
  onUnsnooze,
  onIgnore,
  onAnalyzeAdvisory,
  onOpenInF5,
  onRunInF5,
  onOpenGitHub,
}: PrDetailActionsProps) {
  const { primary, canReview, canSnooze, canSuggest, canIgnore } = prRowActionVisibility(pr, {
    isAuthor,
    isOpen,
    isIgnored,
  });

  const onPrimary =
    primary?.kind === "review"
      ? onReview
      : primary?.kind === "merge"
        ? onMerge
        : primary?.kind === "markReady"
          ? onMarkReady
          : primary?.kind === "reRequest"
            ? onReRequest
            : undefined;

  const showSuggest = canSuggest && Boolean(onAnalyzeAdvisory);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary && onPrimary ? (
        <Button size="sm" onClick={onPrimary}>
          <primary.Icon /> {primary.label}
        </Button>
      ) : null}

      {canReview ? (
        <>
          <Button size="sm" variant="outline" onClick={onApprove}>
            <CheckIcon /> Approve
          </Button>
          <Button size="sm" variant="outline" onClick={onComment}>
            <MessageSquareIcon /> Comment
          </Button>
          <Button size="sm" variant="outline" onClick={onRequestChanges}>
            <XIcon /> Request changes
          </Button>
        </>
      ) : null}

      {canSnooze ? (
        isSnoozed ? (
          <Button size="sm" variant="outline" onClick={onUnsnooze}>
            <PlayIcon /> Unsnooze
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onSnooze}>
            <PauseIcon /> Snooze
          </Button>
        )
      ) : null}

      {showSuggest ? (
        <Button
          size="sm"
          variant="outline"
          disabled={isAnalyzingAdvisory}
          onClick={() => onAnalyzeAdvisory?.()}
        >
          <SparklesIcon /> {isAnalyzingAdvisory ? "Suggesting…" : "Suggest"}
        </Button>
      ) : null}

      <Button size="sm" variant="outline" onClick={onOpenGitHub}>
        <GithubIcon /> GitHub
      </Button>
      <Button size="sm" variant="outline" disabled={isOpeningInF5} onClick={onOpenInF5}>
        <SquareArrowOutUpRightIcon /> Open in F5
      </Button>
      {runInF5Label ? (
        <Button size="sm" disabled={isOpeningInF5} onClick={onRunInF5}>
          <SparklesIcon /> {isOpeningInF5 ? "Starting…" : runInF5Label}
        </Button>
      ) : null}

      {canIgnore ? (
        <Menu>
          <MenuTrigger
            render={<Button aria-label="More actions" size="icon-sm" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-44">
            <MenuItem variant="destructive" disabled={isIgnoring} onClick={onIgnore}>
              <ArchiveIcon /> {isIgnoring ? "Ignoring…" : "Ignore"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
