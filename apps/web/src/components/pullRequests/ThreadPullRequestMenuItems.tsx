import { GitPullRequestIcon } from "lucide-react";

import {
  threadPullRequestStateColorClass,
  threadPullRequestStateLabel,
  type ThreadPullRequestItem,
} from "../../lib/threadPullRequests";
import { cn } from "../../lib/utils";
import { MenuItem } from "../ui/menu";

/** A PR's state icon, number and title; the repository shows only when several repositories mix. */
export function ThreadPullRequestLabel({
  item,
  showRepository,
}: {
  item: ThreadPullRequestItem;
  showRepository: boolean;
}) {
  return (
    <>
      <GitPullRequestIcon
        aria-label={`PR ${threadPullRequestStateLabel(item.state)}`}
        className={cn("size-3.5 shrink-0", threadPullRequestStateColorClass(item.state))}
      />
      <span className="shrink-0 tabular-nums text-muted-foreground">#{item.number}</span>
      <span className="min-w-0 max-w-72 truncate">{item.title}</span>
      {showRepository && item.repository ? (
        <span className="shrink-0 text-muted-foreground text-xs">{item.repository}</span>
      ) : null}
    </>
  );
}

export function threadPullRequestsSpanRepositories(
  items: ReadonlyArray<ThreadPullRequestItem>,
): boolean {
  return new Set(items.map((item) => item.repository?.toLowerCase() ?? "")).size > 1;
}

/** One menu item per PR; choosing one opens it. */
export function ThreadPullRequestMenuItems({
  items,
  onOpen,
}: {
  items: ReadonlyArray<ThreadPullRequestItem>;
  onOpen: (item: ThreadPullRequestItem) => void;
}) {
  const showRepository = threadPullRequestsSpanRepositories(items);
  return items.map((item) => (
    <MenuItem key={item.key} onClick={() => onOpen(item)}>
      <ThreadPullRequestLabel item={item} showRepository={showRepository} />
    </MenuItem>
  ));
}
