import { CheckCheckIcon, GitPullRequestIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";

export function PrEmptyState({
  incomplete,
  mode,
}: {
  incomplete: boolean;
  mode: "inbox" | "focus";
}) {
  const caughtUp = mode === "focus" && !incomplete;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {caughtUp ? <CheckCheckIcon /> : <GitPullRequestIcon />}
        </EmptyMedia>
        <EmptyTitle>
          {incomplete
            ? "No results available"
            : caughtUp
              ? "You're all caught up"
              : "No pull requests"}
        </EmptyTitle>
        <EmptyDescription>
          {incomplete
            ? "The latest refresh was incomplete. Pull requests may be missing."
            : caughtUp
              ? "Nothing in this queue needs you right now."
              : "No entries match this filter."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
