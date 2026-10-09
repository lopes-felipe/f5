import type { ThreadId } from "@t3tools/contracts";
import {
  BotIcon,
  GlobeIcon,
  HandIcon,
  MonitorIcon,
  PanelRightOpenIcon,
  PlayIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  AGENT_BROWSER_ACTIVE_WINDOW_MS,
  describeAgentBrowserAction,
  isAgentBrowserActive,
  useAgentBrowserActivityStore,
} from "../agentBrowserActivityStore";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import {
  describeAgentBrowserCapabilities,
  type AgentBrowserAccess,
  type BrowserCapabilityItem,
  type RuntimeAgentBrowser,
} from "./AgentBrowserLiveCard.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const TONE_CLASS: Record<BrowserCapabilityItem["tone"], string> = {
  ok: "bg-success",
  pending: "bg-info animate-pulse",
  warning: "bg-warning",
  off: "bg-muted-foreground",
};

/** Compact "what can this agent reach" indicator for the active session. */
export function BrowserCapabilityChip(props: {
  readonly agentBrowser: RuntimeAgentBrowser | undefined;
  readonly access: AgentBrowserAccess;
}) {
  const items = describeAgentBrowserCapabilities(props.agentBrowser, props.access);
  if (items.length === 0) return null;
  const Icon = items.some((item) => item.key === "computerUse") ? MonitorIcon : GlobeIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-muted-foreground text-xs"
            data-testid="browser-capability-chip"
          />
        }
      >
        <Icon className="size-3" />
        {items.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", TONE_CLASS[item.tone])} />
            {item.label}
          </span>
        ))}
      </TooltipTrigger>
      <TooltipPopup>
        <div className="max-w-xs space-y-1 text-xs">
          <p>Browser and computer access for this session.</p>
          {items
            .filter((item) => item.detail)
            .map((item) => (
              <p key={item.key}>
                {item.label}: {item.detail}
              </p>
            ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Shown in the chat while an agent drives a preview the user is not looking at: a live
 * thumbnail, what it is doing, and controls to watch or take over.
 */
export function AgentBrowserLiveCard(props: { readonly threadId: ThreadId }) {
  const activity = useAgentBrowserActivityStore(
    (store) => store.byThreadId[String(props.threadId)],
  );
  const previewVisible = useRightPanelStore((store) => {
    const state = selectThreadRightPanelState(store.byThreadId, props.threadId);
    return state.isOpen && state.activeSurfaceId === "preview";
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [activity]);
  useEffect(() => {
    if (!activity || activity.paused || activity.status === "running") return;
    const remaining =
      AGENT_BROWSER_ACTIVE_WINDOW_MS - (Date.now() - (activity.completedAt ?? activity.startedAt));
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [activity]);

  if (!activity || previewVisible || !isAgentBrowserActive(activity, now)) return null;
  const setPaused = (paused: boolean) => {
    useAgentBrowserActivityStore.getState().setPaused(props.threadId, paused);
    void readNativeApi()
      ?.preview.automation.setPaused({ threadId: props.threadId, paused })
      .catch(() => undefined);
  };
  return (
    <div
      className="mx-auto mt-2 flex w-full max-w-3xl items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-xs"
      data-testid="agent-browser-live-card"
    >
      {activity.thumbnailDataUrl ? (
        <img
          src={activity.thumbnailDataUrl}
          alt="Live preview thumbnail"
          className="h-12 w-20 shrink-0 rounded border border-border object-cover object-top"
        />
      ) : (
        <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-border bg-muted">
          <BotIcon className="size-4 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" aria-live="polite">
          {describeAgentBrowserAction(activity)}
        </p>
        <p className="truncate text-muted-foreground text-xs">
          {activity.title || activity.url || "F5 browser preview"}
        </p>
      </div>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => useRightPanelStore.getState().open(props.threadId, "preview")}
      >
        <PanelRightOpenIcon />
        Watch
      </Button>
      {activity.paused ? (
        <Button size="xs" variant="outline" onClick={() => setPaused(false)}>
          <PlayIcon />
          Let agent continue
        </Button>
      ) : (
        <Button size="xs" variant="outline" onClick={() => setPaused(true)}>
          <HandIcon />
          Take over
        </Button>
      )}
    </div>
  );
}
