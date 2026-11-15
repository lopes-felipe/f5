import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleSlashIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  Maximize2Icon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import type { PrHubThreadLink, ThreadId, TrackedPullRequest } from "@t3tools/contracts";

import { prHubDetailQueryOptions } from "../../lib/prHubReactQuery";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { PrMarkdown } from "./PrMarkdown";
import { attentionVariant } from "./prHubPresentation";
import { prStatusChecklist } from "./prQueueModel";
import type { PrQueueActionState } from "./PrQueueActions";
import { PR_TONE_DOT, PrThreadChip } from "./PrQueueTable";
import { usePrMarkSeen } from "./usePrMarkSeen";

/** How long a row must stay selected before its description is fetched. */
const DETAIL_DWELL_MS = 250;

function useDwell(key: string, delay: number): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(key), delay);
    return () => window.clearTimeout(timer);
  }, [key, delay]);
  return settled === key;
}

/**
 * The side panel for the selected row: enough to decide and act without leaving the
 * queue. The full conversation, files and threads live on the pull request page.
 */
export function PrQueuePeek({
  pr,
  links,
  actions,
  now,
  onClose,
  onOpenPage,
  onOpenThread,
}: {
  pr: TrackedPullRequest;
  links: readonly PrHubThreadLink[] | undefined;
  actions: PrQueueActionState;
  now: number;
  onClose: () => void;
  onOpenPage: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  usePrMarkSeen(pr);
  const dwelled = useDwell(pr.key, DETAIL_DWELL_MS);
  const detail = useQuery({ ...prHubDetailQueryOptions(pr.key), enabled: dwelled });
  const { flags, handlers, primary } = actions;
  const body = detail.data?.detail.body.trim();
  // The excerpt fades out only when the description is longer than the space it gets.
  const excerptRef = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = excerptRef.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [body]);
  const reference = `${pr.repository.nameWithOwner}#${pr.number}`;

  return (
    <aside
      aria-label={`Pull request ${reference}`}
      className="flex w-100 shrink-0 flex-col border-l border-border bg-background"
    >
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs text-muted-foreground">{reference}</span>
              {pr.state === "merged" ? <Badge variant="secondary">Merged</Badge> : null}
              {pr.state === "closed" ? <Badge variant="secondary">Closed</Badge> : null}
              {pr.isDraft ? <Badge variant="outline">Draft</Badge> : null}
              {flags.isSnoozed ? <Badge variant="secondary">Snoozed</Badge> : null}
              {flags.isIgnored ? <Badge variant="secondary">Ignored</Badge> : null}
            </div>
            <h2 className="text-sm font-semibold leading-snug text-foreground">{pr.title}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {pr.author ? `${pr.author} · ` : ""}
              <span title={formatAbsoluteTimeLabel(pr.updatedAt)}>
                updated {formatRelativeTimeLabel(pr.updatedAt, now)}
              </span>
              {pr.headRefName && pr.baseRefName ? (
                <span className="font-mono">
                  {" "}
                  · {pr.headRefName} → {pr.baseRefName}
                </span>
              ) : null}
            </p>
          </div>
          <Button size="icon-xs" variant="ghost" aria-label="Close peek" onClick={onClose}>
            <XIcon />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {primary ? (
            <Button
              size="sm"
              disabled={actions.isOpeningInF5}
              onClick={() => actions.run("primary")}
            >
              {primary.label}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onOpenPage}>
            <Maximize2Icon /> Open <Kbd>↵</Kbd>
          </Button>
          {flags.isOpen && !flags.isIgnored ? (
            <Button size="sm" variant="outline" onClick={() => actions.run("snooze")}>
              {flags.isSnoozed ? <PlayIcon /> : <PauseIcon />}
              {flags.isSnoozed ? "Unsnooze" : "Snooze"}
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={<Button aria-label="More actions" size="icon-sm" variant="outline" />}
            >
              <EllipsisIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-48">
              {actions.canMerge && primary?.kind !== "merge" ? (
                <MenuItem onClick={() => actions.run("merge")}>
                  <GitMergeIcon /> Merge…
                </MenuItem>
              ) : null}
              <MenuItem onClick={handlers.onOpenGitHub}>
                <ExternalLinkIcon /> Open on {pr.provider === "github" ? "GitHub" : "the forge"}
              </MenuItem>
              {flags.isOpen ? (
                <MenuItem disabled={actions.isOpeningInF5} onClick={handlers.onOpenInF5}>
                  <SquareArrowOutUpRightIcon /> Open in F5
                </MenuItem>
              ) : null}
              {actions.canClose ? (
                <MenuItem onClick={() => actions.run("close")}>
                  <CircleSlashIcon /> Close…
                </MenuItem>
              ) : null}
              {actions.canReopen ? (
                <MenuItem onClick={() => actions.run("reopen")}>
                  <RotateCcwIcon /> Reopen…
                </MenuItem>
              ) : null}
              {flags.isIgnored ? (
                <MenuItem onClick={() => actions.run("ignore")}>
                  <ArchiveRestoreIcon /> Restore to the queue
                </MenuItem>
              ) : flags.isOpen ? (
                <MenuItem
                  variant="destructive"
                  disabled={flags.isIgnoring}
                  onClick={() => actions.run("ignore")}
                >
                  <ArchiveIcon /> Ignore
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {pr.state === "open" ? (
          <section aria-label="Status" className="flex flex-col gap-2">
            {pr.nextAction ? (
              <div className="flex flex-col gap-1">
                <Badge variant={attentionVariant(pr)} className="self-start">
                  {pr.nextAction}
                </Badge>
                {pr.primaryReason ? (
                  <p className="text-xs text-muted-foreground">{pr.primaryReason}</p>
                ) : null}
              </div>
            ) : null}
            <ul className="flex flex-col rounded-lg border border-border">
              {prStatusChecklist(pr).map((item) => (
                <li
                  key={item.id}
                  className="flex items-baseline gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 -translate-y-px rounded-full",
                      PR_TONE_DOT[item.tone],
                    )}
                  />
                  <span className="w-24 shrink-0 font-medium text-foreground">{item.label}</span>
                  <span className="min-w-0 text-muted-foreground">{item.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {links && links.length > 0 ? (
          <section aria-label="Linked threads" className="flex flex-col gap-1.5">
            <h3 className="text-2xs uppercase tracking-wide text-muted-foreground">
              Linked threads
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {links.map((link) => (
                <PrThreadChip key={link.threadId} link={link} onOpen={onOpenThread} />
              ))}
            </div>
          </section>
        ) : null}

        {pr.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {pr.labels.map((label) => (
              <Badge key={label} variant="outline" size="sm">
                {label}
              </Badge>
            ))}
          </div>
        ) : null}

        <section aria-label="Description" className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-2xs uppercase tracking-wide text-muted-foreground">Description</h3>
          {detail.data ? (
            body ? (
              <div ref={excerptRef} className="relative max-h-72 overflow-hidden text-sm">
                <PrMarkdown body={body} host={pr.host} provider={pr.provider} />
                {clipped ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-background to-transparent"
                  />
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No description.</p>
            )
          ) : detail.isError ? (
            <p className="text-xs text-muted-foreground">
              The description could not be loaded.{" "}
              <button type="button" className="underline" onClick={() => void detail.refetch()}>
                Retry
              </button>
            </p>
          ) : (
            <div className="flex flex-col gap-1.5" aria-hidden="true">
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          )}
          {body ? (
            <Button size="xs" variant="ghost" className="self-start" onClick={onOpenPage}>
              Read the full pull request
            </Button>
          ) : null}
        </section>
      </div>
    </aside>
  );
}
