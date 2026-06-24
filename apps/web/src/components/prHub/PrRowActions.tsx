import {
  ArchiveIcon,
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { prRowActionVisibility } from "./prHubPresentation";

export interface PrRowActionsProps {
  pr: TrackedPullRequest;
  isAuthor: boolean;
  isOpen: boolean;
  isIgnored: boolean;
  isSnoozed: boolean;
  isIgnoring: boolean;
  isAnalyzingAdvisory: boolean;
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
  onOpenGitHub: () => void;
}

export function PrRowActions({
  pr,
  isAuthor,
  isOpen,
  isIgnored,
  isSnoozed,
  isIgnoring,
  isAnalyzingAdvisory,
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
  onOpenGitHub,
}: PrRowActionsProps) {
  const { primary, canReview, canSnooze, canSuggest, canIgnore } = prRowActionVisibility(pr, {
    isAuthor,
    isOpen,
    isIgnored,
  });

  const onPrimary =
    primary?.kind === "approve"
      ? onApprove
      : primary?.kind === "merge"
        ? onMerge
        : primary?.kind === "markReady"
          ? onMarkReady
          : primary?.kind === "reRequest"
            ? onReRequest
            : undefined;

  const showSuggest = canSuggest && Boolean(onAnalyzeAdvisory);

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {primary && onPrimary ? (
        <Button size="xs" onClick={onPrimary}>
          <primary.Icon /> {primary.label}
        </Button>
      ) : null}

      <Menu>
        <MenuTrigger render={<Button aria-label="More actions" size="icon-xs" variant="outline" />}>
          <EllipsisIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-44">
          {canReview ? (
            <>
              <MenuItem onClick={onComment}>
                <MessageSquareIcon /> Comment
              </MenuItem>
              <MenuItem onClick={onRequestChanges}>
                <XIcon /> Request changes
              </MenuItem>
            </>
          ) : null}
          {canSnooze ? (
            isSnoozed ? (
              <MenuItem onClick={onUnsnooze}>
                <PlayIcon /> Unsnooze
              </MenuItem>
            ) : (
              <MenuItem onClick={onSnooze}>
                <PauseIcon /> Snooze
              </MenuItem>
            )
          ) : null}
          {showSuggest ? (
            <MenuItem disabled={isAnalyzingAdvisory} onClick={() => onAnalyzeAdvisory?.()}>
              <SparklesIcon /> {isAnalyzingAdvisory ? "Suggesting…" : "Suggest actions"}
            </MenuItem>
          ) : null}
          <MenuItem onClick={onOpenInF5}>
            <SquareArrowOutUpRightIcon /> Open in F5
          </MenuItem>
          <MenuItem onClick={onOpenGitHub}>
            <GithubIcon /> Open on GitHub
          </MenuItem>
          {canIgnore ? (
            <>
              <MenuSeparator />
              <MenuItem variant="destructive" disabled={isIgnoring} onClick={onIgnore}>
                <ArchiveIcon /> {isIgnoring ? "Ignoring…" : "Ignore"}
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}
