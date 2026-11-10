import { useEffect, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { AgentComputerUseChanged, AgentComputerUseHolder } from "@t3tools/contracts";
import { MonitorIcon, SquareIcon } from "lucide-react";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { useStore } from "../store";
import { Button } from "./ui/button";
import {
  CHROME_RELEASE_TITLE,
  chromeReleaseFailureText,
  pauseComputerThread,
  releaseChromeReservation,
  stopComputerTurn,
  computerStopShortcutLabel,
} from "./computerControls";

const PAUSE_CAUSE_LABEL: Record<NonNullable<AgentComputerUseHolder["pauseCause"]>, string> = {
  paused: "",
  "kill-switch": "stop shortcut",
  "user-input": "you used the mouse or keyboard",
  "permit-expired": "F5 lost contact with the helper",
  "target-active": "you are using that app",
  activation: "an app changed focus",
  "outcome-unknown": "last action's result is unknown",
  "access-changed": "access changed",
};

/**
 * The holder the banner speaks for: foreground control first, then the first background
 * one. A Chrome runtime that is only holding its lease comes last.
 */
export function primaryComputerHolder(
  leases: typeof AgentComputerUseChanged.Type,
): AgentComputerUseHolder | undefined {
  const busy = leases.holders.filter((holder) => holder.browser !== "idle");
  return (
    busy.find((holder) => holder.delivery === "foreground") ??
    busy.find((holder) => holder.state === "active") ??
    busy[0] ??
    leases.holders[0]
  );
}

/** Threads the banner text speaks for: every active background agent when it summarizes them. */
export function computerUseBannerTargets(
  leases: typeof AgentComputerUseChanged.Type,
): ReadonlyArray<AgentComputerUseHolder["threadId"]> {
  const holder = primaryComputerHolder(leases);
  if (!holder) return [];
  if (holder.delivery === "foreground") return [holder.threadId];
  return leases.holders
    .filter((entry) => entry.delivery === "background")
    .map((entry) => entry.threadId);
}
/**
 * A Chrome runtime that only holds its lease: idle, past the linger after its last call,
 * with nothing else to report. It still blocks other threads' Chrome and foreground
 * control, so the banner names it quietly with a way to release it.
 */
export function chromeIdleReservation(
  leases: typeof AgentComputerUseChanged.Type,
  pausedLocally: boolean,
  chromeLinger = false,
): boolean {
  const holder = primaryComputerHolder(leases);
  return (
    !leases.pendingTakeover &&
    holder?.browser === "idle" &&
    holder.state === "active" &&
    !pausedLocally &&
    !chromeLinger
  );
}
/**
 * `chromeLinger`: a Chrome call ended moments ago, so an idle runtime still reads as in use
 * and the banner doesn't flicker between back-to-back calls.
 */
export function computerUseBannerText(
  leases: typeof AgentComputerUseChanged.Type,
  pausedLocally: boolean,
  chromeLinger = false,
): string | null {
  const pending = leases.pendingTakeover;
  if (pending) {
    const app = pending.appName ?? "an app";
    return pending.state === "waiting-idle"
      ? `An agent will take over ${app} when you stop using the mouse and keyboard`
      : `An agent is asking to take over ${app}`;
  }
  const holder = primaryComputerHolder(leases);
  // Only Chrome holders carry `browser`; their lease lasts the browser runtime's life.
  const reserved = chromeIdleReservation(leases, pausedLocally, chromeLinger);
  // Another profile's control outranks this profile's idle reservation.
  if (!holder || (reserved && leases.otherProfile))
    return leases.otherProfile
      ? "An agent in another F5 profile is controlling this computer"
      : null;
  if (reserved) return "Chrome reserved · idle";
  const app = holder.appName ?? (holder.appId ? "an app" : undefined);
  const cause = holder.pauseCause ? PAUSE_CAUSE_LABEL[holder.pauseCause] : "";
  const state =
    pausedLocally && ["active", "waiting-user", "waiting-agent"].includes(holder.state)
      ? "paused"
      : holder.state;
  switch (state) {
    case "paused":
      return `Computer control paused${cause ? ` · ${cause}` : ""}`;
    case "recovery":
      return `Needs recovery${app ? ` · check ${app} before resuming` : ""}${cause ? ` · ${cause}` : ""}`;
    case "waiting-secure-input":
      return `Agent waiting${app ? ` in ${app}` : ""} while secure text entry is active`;
    case "pending-consent":
      return "Agent waiting for computer access approval";
    case "waiting-idle":
      return "Agent waiting for you to stop using the mouse and keyboard";
    case "waiting-user":
      return app ? `Waiting for you to finish in ${app}` : "Waiting while you use the computer";
    case "waiting-agent":
      return "Waiting for another agent";
    case "active":
      break;
  }
  switch (holder.browser) {
    case "working":
    case "idle":
      return "An agent is using Chrome";
    case "unknown":
      return "An agent may be using Chrome";
    case undefined:
      break;
  }
  if (holder.delivery === "foreground")
    return holder.appId
      ? `An agent is controlling ${app} in the foreground`
      : "An agent is controlling this computer";
  const background = leases.holders.filter(
    (entry) => entry.delivery === "background" && entry.state === "active",
  );
  if (background.length <= 1) return `Working in background · ${app ?? "an app"}`;
  const apps = [...new Set(background.flatMap((entry) => (entry.appName ? [entry.appName] : [])))];
  return `${background.length} agents working in background${apps.length ? ` · ${apps.join(", ")}` : ""}`;
}

/**
 * Background-only control is ambient: a quieter style, no takeover of the user's attention.
 */
export function computerUseBannerAmbient(
  leases: typeof AgentComputerUseChanged.Type,
  pausedLocally: boolean,
  chromeLinger = false,
): boolean {
  const holder = primaryComputerHolder(leases);
  if (leases.pendingTakeover || leases.otherProfile || pausedLocally) return false;
  // An idle Chrome reservation is ambient too: nothing is happening, it just holds Chrome.
  if (chromeIdleReservation(leases, pausedLocally, chromeLinger)) return true;
  return (
    holder?.state === "waiting-user" ||
    holder?.state === "waiting-agent" ||
    (holder?.delivery === "background" && holder.state === "active")
  );
}

export { chromeReleaseFailureText };

/** How long Chrome keeps reading as in use after its last call ends. */
export const CHROME_BANNER_LINGER_MS = 3000;

/** True while `active` and for `ms` after it last was, so back-to-back calls don't flicker. */
export function useLinger(active: boolean, ms = CHROME_BANNER_LINGER_MS): boolean {
  const [linger, setLinger] = useState(active);
  useEffect(() => {
    if (active) {
      setLinger(true);
      return;
    }
    const timer = setTimeout(() => setLinger(false), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active || linger;
}

export function ComputerUseBanner() {
  const [error, setError] = useState("");
  const stopUnconfirmed = useAgentComputerActivityStore((state) => state.stopUnconfirmed);
  const leases = useAgentComputerActivityStore((state) => state.leases);
  const shortcut = computerStopShortcutLabel(leases);
  const holder = primaryComputerHolder(leases);
  const threadId = leases.pendingTakeover?.threadId ?? holder?.threadId;
  const paused = useAgentComputerActivityStore((state) =>
    threadId ? !!state.paused[threadId] : false,
  );
  const navigate = useNavigate();
  const title = useStore((store) =>
    threadId ? store.threads.find((thread) => thread.id === threadId)?.title : undefined,
  );
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params as { threadId?: string }).threadId ?? null,
  });
  const chromeLinger = useLinger(leases.holders.some((entry) => entry.browser === "working"));
  const text = computerUseBannerText(leases, paused, chromeLinger);
  const retryTargets = Object.entries(stopUnconfirmed)
    .filter(([, value]) => value)
    .map(([id]) => id as AgentComputerUseHolder["threadId"]);
  if (!text && !retryTargets.length) return null;
  const ambient = computerUseBannerAmbient(leases, paused, chromeLinger);
  const reserved =
    !retryTargets.length &&
    !leases.otherProfile &&
    chromeIdleReservation(leases, paused, chromeLinger);
  // The holding thread's own card already shows the idle reservation with Release.
  if (reserved && threadId && routeThreadId === threadId) return null;
  const backend = holder?.backend;
  // A summary of several background agents controls all of them; otherwise just the one shown.
  const summarized = leases.pendingTakeover ? [] : computerUseBannerTargets(leases);
  const targets = summarized.length > 1 ? summarized : threadId ? [threadId] : [];
  const run = async (
    operation: (target: AgentComputerUseHolder["threadId"]) => Promise<void>,
    snapshot = [...targets],
  ) => {
    setError("");
    const results = await Promise.allSettled(snapshot.map(operation));
    if (results.some((result) => result.status === "rejected"))
      setError(
        "Some controls could not be updated. Check the app. Resume on the computer running F5.",
      );
  };
  return (
    <div
      role="status"
      // Drawn over the frameless titlebar's drag region, which would otherwise take Stop's click.
      className={
        ambient
          ? "pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-border bg-background/95 py-1 pr-1 pl-3 text-muted-foreground text-sm shadow-sm [-webkit-app-region:no-drag]"
          : "pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-warning/50 bg-background/95 py-1 pr-1 pl-3 text-sm shadow-md [-webkit-app-region:no-drag]"
      }
      data-testid="computer-use-banner"
      data-delivery={holder?.delivery}
    >
      <MonitorIcon className={ambient ? "size-4" : "size-4 text-warning-foreground"} />
      <span>
        {retryTargets.length ? "Stop unconfirmed · check the app before resuming" : text}
        {title ? ` · ${title}` : ""}
        {backend ? ` · ${backend === "native" ? "F5" : backend}` : ""}
      </span>
      {threadId && reserved ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            title="Go to the thread holding Chrome"
            onClick={() => void navigate({ to: "/$threadId", params: { threadId } })}
          >
            View
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={CHROME_RELEASE_TITLE}
            onClick={() => {
              setError("");
              void releaseChromeReservation(threadId).then(setError);
            }}
          >
            Release
          </Button>
        </>
      ) : threadId ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/$threadId", params: { threadId } })}
          >
            View
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title={`Stop shortcut: ${shortcut}`}
            onClick={() => {
              const snapshot = [...targets];
              void run(
                (target) => pauseComputerThread(target, snapshot.length > 1 ? true : !paused),
                snapshot,
              );
            }}
          >
            {targets.length > 1 ? "Pause all" : paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            title={backend === "native" ? "Stop computer input" : "Stops after the current action"}
            onClick={() => {
              void run(stopComputerTurn);
            }}
          >
            <SquareIcon />
            {targets.length > 1 ? "Stop all" : "Stop"}
          </Button>
        </>
      ) : (
        <span className="text-xs">{shortcut} to stop</span>
      )}
      {retryTargets.length ? (
        <Button
          size="xs"
          variant="destructive"
          onClick={() => void run(stopComputerTurn, [...retryTargets])}
        >
          Retry Stop
        </Button>
      ) : null}
      {holder?.pauseCause === "outcome-unknown" ? (
        <span className="text-xs">
          Check the app before resuming. Observe the result before another action.
        </span>
      ) : null}
      {paused && !window.desktopBridge?.computerAutomation ? (
        <span className="text-xs">Resume on the computer running F5.</span>
      ) : null}
      {error ? (
        <span role="alert" className="w-full text-xs">
          {error}
        </span>
      ) : null}
    </div>
  );
}
