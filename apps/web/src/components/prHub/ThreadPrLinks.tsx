import type { ThreadId } from "@t3tools/contracts";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { EyeIcon } from "lucide-react";

import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { useThreadPullRequestWatches } from "../pullRequests/threadPullRequestActions";
import { Button } from "../ui/button";

/**
 * Watches on PRs that are not linked to the thread. Linked PRs, and their watch toggles,
 * live in View PR's menu; a watch on any other PR stays visible and stoppable here.
 */
export function ThreadPrLinks({ threadId }: { threadId: ThreadId }) {
  return <ThreadPrLinksContent key={threadId} threadId={threadId} />;
}

function ThreadPrLinksContent({ threadId }: { threadId: ThreadId }) {
  const links = useStore((state) => selectThreadById(state, threadId)?.pullRequests);
  const { watches, busy, error, watchAction } = useThreadPullRequestWatches(threadId);
  const unlinked =
    watches.data?.filter(
      (watch) => !links?.some((link) => formatSourceControlPullRequestKey(link) === watch.key),
    ) ?? [];
  if (unlinked.length === 0 && !error) return null;
  return (
    <span className="flex items-center gap-1 text-xs">
      {unlinked.map((watch) => (
        <Button
          key={watch.key}
          variant="ghost"
          size="xs"
          disabled={busy}
          aria-label={`Stop watching ${watch.key}`}
          onClick={() => void watchAction(watch.key, true)}
        >
          <EyeIcon className="size-3" />
          {watch.key}
        </Button>
      ))}
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}
