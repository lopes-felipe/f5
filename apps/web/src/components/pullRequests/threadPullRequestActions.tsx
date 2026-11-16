import type { ThreadId } from "@t3tools/contracts";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useOpenLink } from "../../hooks/useOpenLink";
import {
  PR_QUICK_ACTION_LABELS,
  prQuickActions,
  type PrQuickAction,
} from "../../lib/prQuickActions";
import type { ThreadPullRequestItem } from "../../lib/threadPullRequests";
import { newCommandId } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";
import { ThreadPullRequestLabel } from "./ThreadPullRequestMenuItems";

export const WATCH_ERROR_MESSAGE =
  "Could not update the PR watch. Check the PR, thread and forge account.";

/** A thread's PR watches, refreshed by server pushes. */
export function useThreadPullRequestWatches(threadId: ThreadId | null) {
  const watches = useQuery({
    queryKey: ["pullRequestWatches", threadId],
    queryFn: () => ensureNativeApi().pullRequestWatches.list({ threadId: threadId! }),
    enabled: threadId !== null,
    staleTime: 30_000,
    retry: false,
  });
  const { refetch } = watches;
  useEffect(() => {
    if (threadId === null) return;
    return ensureNativeApi().pullRequestWatches.onChanged((change) => {
      if (change.threadId === threadId) void refetch();
    });
  }, [threadId, refetch]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Starts or stops a watch by PR URL or key; resolves false (and sets `error`) on failure. */
  const watchAction = useCallback(
    async (pr: string, stop: boolean): Promise<boolean> => {
      if (threadId === null) return false;
      setBusy(true);
      setError(null);
      try {
        await (stop
          ? ensureNativeApi().pullRequestWatches.stop({ threadId, pr })
          : ensureNativeApi().pullRequestWatches.start({ threadId, pr }));
        await refetch();
        return true;
      } catch {
        setError(WATCH_ERROR_MESSAGE);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [threadId, refetch],
  );
  const isWatched = useCallback(
    (key: string | null) => key !== null && !!watches.data?.some((watch) => watch.key === key),
    [watches.data],
  );
  return { watches, busy, error, watchAction, isWatched };
}

export function unlinkThreadPullRequest(threadId: ThreadId, item: ThreadPullRequestItem) {
  if (!item.ref) return Promise.resolve();
  return ensureNativeApi()
    .orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      pullRequestUnlink: item.ref,
    })
    .then(() => undefined);
}

/** One PR's actions in View PR's menu: open, copy, quick actions, watch and unlink. */
export function ThreadPullRequestSubmenu({
  threadId,
  item,
  showRepository,
  watched,
  watchBusy,
  onWatch,
  onUnlink,
}: {
  threadId: ThreadId;
  item: ThreadPullRequestItem;
  showRepository: boolean;
  watched: boolean;
  watchBusy: boolean;
  onWatch: (stop: boolean) => void;
  onUnlink: () => void;
}) {
  const openLink = useOpenLink(threadId);
  const key = item.ref ? formatSourceControlPullRequestKey(item.ref) : null;
  const openInF5 = (action?: PrQuickAction) => {
    if (!key) return;
    useRightPanelStore.getState().openPullRequest(threadId, {
      key,
      url: item.url,
      ...(action ? { initialAction: { kind: action, id: crypto.randomUUID() } } : {}),
    });
  };
  const quickActions = item.ref
    ? prQuickActions({ provider: item.ref.provider, state: item.state })
    : [];
  return (
    <MenuSub>
      <MenuSubTrigger aria-label={`PR #${item.number}`}>
        <ThreadPullRequestLabel item={item} showRepository={showRepository} />
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuItem onClick={() => void openLink(item.url, { external: true })}>
          Open in browser
        </MenuItem>
        <MenuItem disabled={!key} onClick={() => openInF5()}>
          Open in F5
        </MenuItem>
        <MenuItem onClick={() => void writeTextToClipboard(item.url)}>Copy link</MenuItem>
        {quickActions.map((action) => (
          <MenuItem key={action} onClick={() => openInF5(action)}>
            {PR_QUICK_ACTION_LABELS[action]}…
          </MenuItem>
        ))}
        <MenuItem
          disabled={watchBusy || (!watched && item.state !== "open")}
          onClick={() => onWatch(watched)}
        >
          {watched ? "Stop watching" : "Watch"}
        </MenuItem>
        <MenuSeparator />
        {item.linked ? (
          <MenuItem variant="destructive" onClick={onUnlink}>
            Unlink
          </MenuItem>
        ) : (
          <MenuItem disabled title="Detected from the branch; it can't be unlinked.">
            Unlink
          </MenuItem>
        )}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Links a PR to the thread by URL, after the forge confirms it exists. */
export function LinkPullRequestDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: ThreadId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    onOpenChange(false);
    setUrl("");
    setError(null);
  };
  const submit = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      const api = ensureNativeApi();
      const preview = await api.prHub.peek({ url });
      if (!preview) throw new Error("Enter a supported pull request URL.");
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        pullRequest: {
          provider: preview.provider,
          host: preview.host,
          repository: preview.repository,
          number: preview.number,
          title: preview.title,
          url: preview.url,
        },
      });
      close();
    })()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not link pull request."),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link pull request</DialogTitle>
          <DialogDescription>
            The PR shows on this thread's sidebar row and in View PR.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && url.trim()) submit();
            }}
          >
            <Input
              aria-label="Pull request URL to link"
              placeholder="https://github.com/owner/repo/pull/123"
              value={url}
              autoFocus
              onChange={(event) => setUrl(event.target.value)}
            />
          </form>
          {error ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !url.trim()} onClick={submit}>
            Link
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
