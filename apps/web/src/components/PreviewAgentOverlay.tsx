import type { ThreadId } from "@t3tools/contracts";
import { BotIcon, HandIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AGENT_BROWSER_ACTIVE_WINDOW_MS,
  describeAgentBrowserAction,
  isAgentBrowserActive,
  useAgentBrowserActivityStore,
} from "../agentBrowserActivityStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

/**
 * Shows that an agent is driving this preview: a frame, the last pointer position and
 * target, and a take-over control. Pointer events pass through except on the controls.
 */
export function PreviewAgentOverlay(props: {
  readonly threadId: ThreadId;
  readonly zoomFactor: number;
  readonly paused: boolean;
  readonly onTakeOver: () => void;
  readonly onResume: () => void;
}) {
  const activity = useAgentBrowserActivityStore(
    (store) => store.byThreadId[String(props.threadId)],
  );
  const [now, setNow] = useState(() => Date.now());
  const active = isAgentBrowserActive(activity, now);

  // Re-render once the activity window lapses so the frame disappears on its own.
  useEffect(() => {
    if (!activity || activity.paused || activity.status === "running") return;
    const remaining =
      AGENT_BROWSER_ACTIVE_WINDOW_MS - (Date.now() - (activity.completedAt ?? activity.startedAt));
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [activity]);
  useEffect(() => setNow(Date.now()), [activity]);

  if (!activity || !active) return null;
  const zoom = props.zoomFactor > 0 ? props.zoomFactor : 1;
  const point = activity.geometry?.point;
  const rect = activity.geometry?.rect;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-20 rounded-sm ring-2 ring-inset",
        props.paused ? "ring-warning/70" : "ring-info/70",
      )}
      data-testid="preview-agent-overlay"
    >
      {!props.paused && rect && rect.width > 0 && rect.height > 0 ? (
        <div
          className="absolute rounded-sm border-2 border-info/80 bg-info/10 transition-all duration-150"
          style={{
            left: rect.x * zoom,
            top: rect.y * zoom,
            width: rect.width * zoom,
            height: rect.height * zoom,
          }}
        />
      ) : null}
      {!props.paused && point ? (
        <div
          className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-info shadow-md transition-all duration-150"
          style={{ left: point.x * zoom, top: point.y * zoom }}
        />
      ) : null}
      <div className="pointer-events-auto absolute top-2 left-1/2 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 py-1 pr-1 pl-3 text-xs shadow-sm">
        {props.paused ? (
          <HandIcon className="size-3.5 shrink-0 text-warning-foreground" />
        ) : (
          <BotIcon className="size-3.5 shrink-0 text-info-foreground" />
        )}
        <span className="truncate" aria-live="polite">
          {props.paused
            ? "You have control. The agent is paused."
            : describeAgentBrowserAction(activity)}
        </span>
        {props.paused ? (
          <Button size="xs" variant="outline" onClick={props.onResume}>
            <PlayIcon />
            Let agent continue
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={props.onTakeOver}>
            <HandIcon />
            Take over
          </Button>
        )}
      </div>
    </div>
  );
}
