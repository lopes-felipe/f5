import { useShallow } from "zustand/react/shallow";
import { AGENT_ACTIVITY_WINDOW_MS } from "../agentActivityWindow";
import { useEffect, useMemo, useState } from "react";
import type { ComputerAccessPush, ComputerGrant, ThreadId } from "@t3tools/contracts";
import {
  CheckIcon,
  ClockIcon,
  HistoryIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  useAgentComputerActivityStore,
  isAgentComputerActive,
  EMPTY_COMPUTER_REQUESTS,
} from "../agentComputerActivityStore";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import {
  computerBackendLabel,
  computerGrantLabel,
  computerStatusTone,
  describeComputerAction,
  type ComputerStatusTone,
} from "./AgentComputerLiveCard.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { pauseComputerThread, stopComputerTurn } from "./computerControls";
const EMPTY_GRANTS: ReadonlyArray<ComputerGrant> = [];
const TONE_CLASS: Record<ComputerStatusTone, string> = {
  ok: "bg-success",
  pending: "bg-info animate-pulse",
  warning: "bg-warning",
  error: "bg-destructive",
  off: "bg-muted-foreground",
};
type AccessRequest = typeof ComputerAccessPush.Type & { settled?: boolean; allowed?: boolean };
const KIND_LABEL: Record<AccessRequest["kind"], string> = {
  apps: "Apps",
  "session-actions": "Session actions",
  "chrome-setup": "Browser setup",
  "chrome-session": "Browser session",
  "foreground-takeover": "Foreground takeover",
};

export function AgentComputerLiveCard({ threadId }: { threadId: ThreadId }) {
  const activity = useAgentComputerActivityStore((state) => state.activity[threadId]);
  const capture = useAgentComputerActivityStore((state) => state.lastCapture[threadId]);
  const grants = useAgentComputerActivityStore((state) => state.grants[threadId] ?? EMPTY_GRANTS);
  const appNames = useAgentComputerActivityStore(
    useShallow((state) =>
      Object.fromEntries(grants.map((grant) => [grant.appId, state.appNames[grant.appId]])),
    ),
  );
  const requests = useAgentComputerActivityStore(
    (state) => state.requestsByThread[threadId] ?? EMPTY_COMPUTER_REQUESTS,
  );
  const actions = useAgentComputerActivityStore((state) => state.history[threadId]);
  const stopUnconfirmed = useAgentComputerActivityStore((state) => state.stopUnconfirmed[threadId]);
  const paused = useAgentComputerActivityStore((state) => state.paused[threadId]);
  const held = useAgentComputerActivityStore(
    (state) =>
      state.leases.holders.some((holder) => holder.threadId === threadId) ||
      state.leases.pendingTakeover?.threadId === threadId,
  );
  const lastLeaseAt = useAgentComputerActivityStore((state) => state.lastLeaseAt[threadId]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  useEffect(() => {
    setNow(Date.now());
  }, [activity, lastLeaseAt, held]);
  useEffect(() => {
    if (held) return;
    const expiries = [
      activity && activity.status !== "started"
        ? activity.at + AGENT_ACTIVITY_WINDOW_MS
        : undefined,
      lastLeaseAt !== undefined ? lastLeaseAt + AGENT_ACTIVITY_WINDOW_MS : undefined,
    ].filter((expiry): expiry is number => expiry !== undefined && expiry > now);
    if (!expiries.length) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(...expiries) - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [activity, lastLeaseAt, held, now]);
  const history = useMemo(() => [...requests].reverse(), [requests]);
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Computer control could not be updated."),
    );
  };
  const visible =
    stopUnconfirmed ||
    paused ||
    grants.length > 0 ||
    isAgentComputerActive(activity, now, held, lastLeaseAt);
  if (!visible) {
    const latest = history[0];
    if (!latest && !actions?.length) return null;
    return (
      <div
        className="mx-auto mt-2 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-border bg-card px-3 py-1 text-muted-foreground text-xs shadow-xs"
        data-testid="computer-access-summary"
      >
        <MonitorIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" aria-live="polite">
          {latest ? "Computer access · last request" : "Computer actions"}{" "}
          {latest ? (!latest.settled ? "pending" : latest.allowed ? "allowed" : "not allowed") : ""}
        </span>
        {actions?.length ? <ComputerActionsHistory history={actions} /> : null}
        {history.length ? <ComputerAccessHistory history={history} /> : null}
      </div>
    );
  }
  const native = activity?.backend === "native";
  const backendLabel = computerBackendLabel(activity?.backend);
  const tone = computerStatusTone(activity, { paused, held });
  return (
    <div
      className={cn(
        "mx-auto mt-2 flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-xs",
        paused && "border-warning/50",
      )}
      data-testid="computer-live-card"
    >
      {capture?.thumbnailDataUrl ? (
        <img
          src={capture.thumbnailDataUrl}
          alt="Last captured computer action"
          title={capture.appName ? `Last capture · ${capture.appName}` : "Last capture"}
          className="h-12 w-20 shrink-0 rounded border border-border object-cover object-top"
        />
      ) : (
        <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-border bg-muted">
          <MonitorIcon className="size-4 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-40 flex-1 space-y-1">
        <p className="flex items-center gap-1.5 truncate font-medium" aria-live="polite">
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[tone])} />
          <span className="truncate">
            {stopUnconfirmed
              ? "Stop unconfirmed"
              : describeComputerAction(activity, { paused, held })}
          </span>
          {activity?.appName && !paused ? (
            <span className="truncate font-normal text-muted-foreground">· {activity.appName}</span>
          ) : null}
          {backendLabel ? (
            <span className="shrink-0 font-normal text-muted-foreground">· {backendLabel}</span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {grants.length === 0 ? (
            <span className="text-muted-foreground text-xs">No apps allowed</span>
          ) : (
            grants.map((grant) => {
              const name = appNames[grant.appId] ?? grant.appId;
              return (
                <Badge key={grant.appId} variant="outline" className="gap-1 pr-0.5">
                  {name} · {computerGrantLabel(grant.tier, grant.allowTyping)}
                  <button
                    type="button"
                    aria-label={`Revoke ${name}`}
                    title={`Revoke ${name}`}
                    className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() =>
                      run(async () =>
                        readNativeApi()?.computer?.access.revoke({ threadId, appId: grant.appId }),
                      )
                    }
                  >
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              );
            })
          )}
        </div>
        {activity?.outcome === "OutcomeUnknown" ? (
          <p className="text-warning-foreground text-xs">
            Check the app before resuming. Observe the result before another action.
          </p>
        ) : null}
        {paused && !window.desktopBridge?.computerAutomation ? (
          <p className="text-muted-foreground text-xs">Resume on the computer running F5.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {error}
          </p>
        ) : null}
      </div>
      {/* Controls wrap onto another row so Stop remains reachable at narrow widths. */}
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
        {actions?.length ? <ComputerActionsHistory history={actions} /> : null}
        {history.length > 0 ? <ComputerAccessHistory history={history} /> : null}
        <Button
          size="xs"
          variant="outline"
          onClick={() => run(() => pauseComputerThread(threadId, !paused))}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          size="xs"
          variant="destructive"
          title={native ? "Stop computer input" : "Stops after the current action"}
          onClick={() => run(() => stopComputerTurn(threadId))}
        >
          <SquareIcon />
          {stopUnconfirmed ? "Retry Stop" : "Stop"}
        </Button>
      </div>
    </div>
  );
}

function ComputerAccessHistory({ history }: { history: ReadonlyArray<AccessRequest> }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost">
            <HistoryIcon />
            History ({history.length})
          </Button>
        }
      />
      <PopoverPopup className="w-96" align="end">
        <PopoverTitle className="mb-2 text-sm">Access requests</PopoverTitle>
        <ul className="max-h-72 space-y-1 overflow-y-auto" data-testid="computer-access-history">
          {history.map((request) => (
            <li key={request.requestId} className="flex gap-2 rounded-md px-1 py-1.5 text-sm">
              {!request.settled ? (
                <ClockIcon
                  aria-label="Pending"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
              ) : request.allowed ? (
                <CheckIcon aria-label="Allowed" className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : (
                <XIcon
                  aria-label="Not allowed"
                  className="mt-0.5 size-3.5 shrink-0 text-destructive-foreground"
                />
              )}
              <div className="min-w-0 flex-1">
                {/* Settlement is request-wide, so list what was asked for, not what was granted. */}
                <p className="truncate font-medium">
                  <span className="font-normal text-muted-foreground">Requested: </span>
                  {request.apps.length > 0
                    ? request.apps
                        .map(
                          (app) =>
                            `${app.name} · ${computerGrantLabel(app.tier, request.typingRequested ?? false)}`,
                        )
                        .join(", ")
                    : KIND_LABEL[request.kind]}
                </p>
                {request.reason ? (
                  <p className="line-clamp-2 text-muted-foreground text-xs">{request.reason}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}

function ComputerActionsHistory({
  history,
}: {
  history: ReadonlyArray<import("@t3tools/contracts").ComputerActivity & { at: number }>;
}) {
  const [openedAt, setOpenedAt] = useState(Date.now());
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setOpenedAt(Date.now());
      }}
    >
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost">
            <HistoryIcon />
            Actions ({history.length})
          </Button>
        }
      />
      <PopoverPopup className="w-96" align="end">
        <PopoverTitle className="mb-2 text-sm">Computer actions</PopoverTitle>
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {[...history].reverse().map((entry, index) => (
            <li key={`${entry.at}:${index}`} className="text-sm">
              <p>
                {describeComputerAction(entry, {})}
                {entry.appName ? ` · ${entry.appName}` : ""}{" "}
                {entry.delivery === "background" ? (
                  <Badge variant="outline">background</Badge>
                ) : null}
              </p>
              <p className="text-muted-foreground text-xs">
                {entry.outcome ? `${entry.outcome} · ` : ""}
                {Math.max(0, Math.floor((openedAt - entry.at) / 1000))}s ago
              </p>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
