import { usePrQuickActionModifier } from "../../hooks/usePrQuickActionModifier";
import { useOpenLink } from "../../hooks/useOpenLink";
import {
  prQuickActions,
  PR_QUICK_ACTION_LABELS,
  type PrQuickAction,
} from "../../lib/prQuickActions";
import { useRightPanelStore } from "../../rightPanelStore";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { writePullRequestReferenceDrag } from "../../lib/pullRequestReference";
import { EyeIcon, EllipsisIcon } from "lucide-react";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { PrHubThreadLinks } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { newCommandId } from "../../lib/utils";
import { PrLinkPreview } from "./PrLinkPreview";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
export function ThreadPrLinks({ threadId }: { threadId: ThreadId }) {
  return <ThreadPrLinksContent key={threadId} threadId={threadId} />;
}
function ThreadPrLinksContent({ threadId }: { threadId: ThreadId }) {
  const speedMode = usePrQuickActionModifier();
  const openLink = useOpenLink(threadId);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const openPr = (link: ThreadPullRequestLink, action?: PrQuickAction) => {
    useRightPanelStore.getState().openPullRequest(threadId, {
      key: formatSourceControlPullRequestKey(link),
      url: link.url,
      ...(action ? { initialAction: { kind: action, id: crypto.randomUUID() } } : {}),
    });
  };
  const [editing, setEditing] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ["threadPrLinks", threadId],
    queryFn: async () =>
      Schema.decodeUnknownSync(PrHubThreadLinks)(
        await ensureNativeApi().prHub.getThreadLinks({ threadId }),
      ),
    staleTime: 60000,
    retry: false,
  });
  const watches = useQuery({
    queryKey: ["pullRequestWatches", threadId],
    queryFn: () => ensureNativeApi().pullRequestWatches.list({ threadId }),
    staleTime: 30000,
    retry: false,
  });
  useEffect(
    () =>
      ensureNativeApi().pullRequestWatches.onChanged((change) => {
        if (change.threadId === threadId) void watches.refetch();
      }),
    [threadId, watches.refetch],
  );
  const watchAction = (pr: string, stop: boolean) => {
    setBusy(true);
    setError(null);
    void (
      stop
        ? ensureNativeApi().pullRequestWatches.stop({ threadId, pr })
        : ensureNativeApi().pullRequestWatches.start({ threadId, pr })
    )
      .then(() => watches.refetch())
      .catch(() =>
        setError("Could not update the PR watch. Check the PR, thread and forge account."),
      )
      .finally(() => setBusy(false));
  };
  return (
    <span className="flex items-center gap-1 text-xs">
      {query.data?.map((link) => (
        <span
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenuPosition({ x: event.clientX, y: event.clientY });
            setMenuKey(formatSourceControlPullRequestKey(link));
          }}
          draggable
          onDragStart={(event) => {
            if (!writePullRequestReferenceDrag(event.dataTransfer, link.url))
              event.preventDefault();
          }}
          key={`${link.provider}:${link.host}/${link.repository}#${link.number}`}
          className="flex items-center gap-1 rounded border border-border px-1"
        >
          <PrLinkPreview url={link.url}>
            {link.provider} #{link.number}
          </PrLinkPreview>
          {watches.data?.some((watch) => watch.key === formatSourceControlPullRequestKey(link)) ? (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              aria-label={`Stop watching PR #${link.number}`}
              title="Stop watching"
              onClick={() => watchAction(link.url, true)}
            >
              <EyeIcon className="size-3" />
            </Button>
          ) : null}
          {speedMode
            ? prQuickActions(link)
                .filter((action) => action !== "reopen")
                .map((action) => (
                  <Button
                    key={action}
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    aria-label={`${PR_QUICK_ACTION_LABELS[action]} PR #${link.number}`}
                    onClick={() => openPr(link, action)}
                  >
                    {PR_QUICK_ACTION_LABELS[action]}
                  </Button>
                ))
            : null}
          <Menu
            open={menuKey === formatSourceControlPullRequestKey(link)}
            onOpenChange={(open) => {
              if (open) setMenuKey(formatSourceControlPullRequestKey(link));
              else {
                setMenuKey((key) => (key === formatSourceControlPullRequestKey(link) ? null : key));
                setMenuPosition(null);
              }
            }}
          >
            <MenuTrigger
              aria-label={`PR #${link.number} actions`}
              className="rounded p-0.5 hover:bg-accent"
            >
              <EllipsisIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup
              anchor={
                menuPosition && menuKey === formatSourceControlPullRequestKey(link)
                  ? {
                      getBoundingClientRect: () =>
                        new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                    }
                  : undefined
              }
              align={menuPosition ? "start" : "end"}
            >
              <MenuItem onClick={() => openPr(link)}>Open in F5</MenuItem>
              <MenuItem onClick={() => void openLink(link.url, { external: true })}>
                Open on forge
              </MenuItem>
              <MenuItem onClick={() => void writeTextToClipboard(link.url)}>Copy link</MenuItem>
              {prQuickActions(link).map((action) => (
                <MenuItem key={action} disabled={busy} onClick={() => openPr(link, action)}>
                  {PR_QUICK_ACTION_LABELS[action]}…
                </MenuItem>
              ))}
              <MenuItem
                disabled={busy || watches.isPending || watches.isError}
                onClick={() =>
                  watchAction(
                    link.url,
                    !!watches.data?.some(
                      (watch) => watch.key === formatSourceControlPullRequestKey(link),
                    ),
                  )
                }
              >
                {watches.data?.some(
                  (watch) => watch.key === formatSourceControlPullRequestKey(link),
                )
                  ? "Stop watching"
                  : "Watch"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
      ))}
      {watches.data
        ?.filter(
          (watch) =>
            !query.data?.some((link) => formatSourceControlPullRequestKey(link) === watch.key),
        )
        .map((watch) => (
          <Button
            key={watch.key}
            variant="ghost"
            size="xs"
            disabled={busy}
            aria-label={`Stop watching ${watch.key}`}
            onClick={() => watchAction(watch.key, true)}
          >
            <EyeIcon className="size-3" />
            {watch.key}
          </Button>
        ))}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Link pull request"
        onClick={() => setEditing(!editing)}
      >
        +
      </Button>
      {editing ? (
        <span className="flex gap-1">
          <Input
            aria-label="Pull request URL to link"
            placeholder="Pull request URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            size="xs"
            disabled={busy || !url.trim()}
            onClick={() => {
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
                await query.refetch();
                setEditing(false);
                setUrl("");
              })()
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : "Could not link pull request."),
                )
                .finally(() => setBusy(false));
            }}
          >
            Link
          </Button>
        </span>
      ) : null}
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}
