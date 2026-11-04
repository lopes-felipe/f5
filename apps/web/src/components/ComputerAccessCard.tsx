import { usePendingComputerAccessRequests } from "../hooks/usePendingComputerAccessRequests";
import { useStore } from "../store";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ComputerAccessPush, ComputerAppTier } from "@t3tools/contracts";
import { AppWindowIcon, GlobeIcon, KeyboardIcon } from "lucide-react";

import { readNativeApi } from "../nativeApi";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { COMPUTER_TIER_LABEL } from "./AgentComputerLiveCard.logic";
import { RequestDeadline } from "./RequestDeadline";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const TIER_BADGE: Record<ComputerAppTier, "warning" | "info" | "outline" | "error"> = {
  full: "warning",
  click: "info",
  view: "outline",
  blocked: "error",
};

export function ComputerAccessCard({ request }: { request: typeof ComputerAccessPush.Type }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bridge = window.desktopBridge?.computerAutomation;
  const review = async (trusted: boolean) => {
    if (!bridge || !trusted || sending) return;
    setSending(true);
    setError("");
    try {
      await bridge.answerAccess({
        requestId: request.requestId,
        backendIncarnation: request.backendIncarnation,
        decisions: [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer computer access.");
      setSending(false);
    }
  };
  return (
    <div className="space-y-3 px-6 pb-6 text-sm" data-testid="computer-access-card">
      {request.reason ? (
        <div className="space-y-1 rounded-md bg-muted/50 px-3 py-2">
          <p className="font-medium text-muted-foreground text-xs">Agent's reason</p>
          <p>{request.reason}</p>
        </div>
      ) : null}
      {request.chromeSetup ? (
        <dl className="space-y-2 rounded-md border p-3">
          <div>
            <dt className="text-muted-foreground text-xs">Current targets</dt>
            {request.chromeSetup.previousTargets.length > 0 ? (
              request.chromeSetup.previousTargets.map((target) => (
                <dd key={target} className="break-all font-mono text-xs">
                  {target}
                </dd>
              ))
            ) : (
              <dd className="text-muted-foreground text-xs">None</dd>
            )}
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">
              New target for {request.chromeSetup.provider}
            </dt>
            <dd className="break-all font-mono text-xs">{request.chromeSetup.targetPath}</dd>
          </div>
          <SignedInWarning />
        </dl>
      ) : null}
      {request.apps.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {request.apps.map((app) => (
            <li key={app.appId} className="space-y-1 px-3 py-2">
              <div className="flex items-center gap-2">
                <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{app.name}</span>
                <Badge variant={TIER_BADGE[app.tier]}>{COMPUTER_TIER_LABEL[app.tier]}</Badge>
              </div>
              {app.warning === "browser" ? <SignedInWarning /> : null}
              {app.tier === "full" ? (
                <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <KeyboardIcon className="size-3.5 shrink-0" />
                  Includes typing
                </p>
              ) : null}
              {app.tier === "click" ? (
                <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <KeyboardIcon className="size-3.5 shrink-0" />
                  Typing can run commands; choose it in the native dialog
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!bridge ? (
        <p className="text-muted-foreground">Answer on the computer running F5.</p>
      ) : (
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-muted-foreground text-xs">
            Choose access and remembering in F5's native dialog
          </p>
          <Button disabled={sending} onClick={(event) => void review(event.isTrusted)}>
            Review access
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SignedInWarning() {
  return (
    <p className="flex items-center gap-1.5 text-warning-foreground text-xs">
      <GlobeIcon className="size-3.5 shrink-0" />
      Can act on sites you're signed in to
    </p>
  );
}
/** Mounted once per app window. Consent stays visible even when its thread is not selected. */
export function ComputerAccessInbox() {
  const titleId = useId();
  const descriptionId = useId();
  const pending = usePendingComputerAccessRequests();
  const request = pending[0];
  const requests = useAgentComputerActivityStore((state) => state.requests);
  const [dismissed, setDismissed] = useState<string>();
  const persistenceFailure = Object.values(requests).findLast(
    (entry) =>
      entry?.settled &&
      entry.allowed &&
      entry.persistence === "session-only" &&
      entry.requestId !== dismissed,
  );
  const canReview = !!window.desktopBridge?.computerAutomation;
  const [announcement, setAnnouncement] = useState("");
  const announcementCount = useRef(0);
  const requestId = request?.requestId;
  const panelRef = useRef<HTMLElement>(null);
  const [panelTop, setPanelTop] = useState(80);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !canReview) return;
    let frame = 0;
    const measure = () => {
      const bounds = panel.getBoundingClientRect();
      let top = 80;
      for (const viewport of document.querySelectorAll<HTMLElement>(
        '[data-slot="toast-viewport"][data-position*="top"]',
      )) {
        const toastBounds = viewport.getBoundingClientRect();
        if (toastBounds.left >= bounds.right || toastBounds.right <= bounds.left) continue;
        for (const toast of viewport.querySelectorAll<HTMLElement>(
          '[data-slot="toast-root"]:not([data-limited])',
        ))
          top = Math.max(
            top,
            toast.getBoundingClientRect().bottom + 12,
            toastBounds.top + toast.offsetHeight + 12,
          );
      }
      setPanelTop(Math.ceil(top));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect();
      resize.observe(panel);
      document
        .querySelectorAll('[data-slot="toast-viewport"], [data-slot="toast-root"]')
        .forEach((node) => resize.observe(node));
      schedule();
    };
    const toastNode = (node: Node) =>
      node instanceof Element &&
      (node.matches('[data-slot="toast-root"], [data-slot="toast-viewport"]') ||
        node.querySelector('[data-slot="toast-viewport"]'));
    const mutations = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            (record.target instanceof Element &&
              record.target.closest('[data-slot="toast-viewport"]')) ||
            [...record.addedNodes, ...record.removedNodes].some(toastNode),
        )
      )
        observe();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    const transitioned = (event: TransitionEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-slot="toast-viewport"]'))
        schedule();
    };
    document.addEventListener("transitionend", transitioned);
    window.addEventListener("resize", schedule);
    observe();
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.removeEventListener("transitionend", transitioned);
      window.removeEventListener("resize", schedule);
    };
  }, [requestId, canReview]);
  useEffect(() => {
    setAnnouncement(
      requestId && canReview
        ? "Computer access request " +
            ++announcementCount.current +
            " is waiting. Use Review access in the Computer access panel."
        : "",
    );
  }, [requestId, canReview]);
  const title = useStore(
    (store) => store.threads.find((thread) => thread.id === request?.threadId)?.title,
  );
  const projectName = useStore((store) => {
    const thread = store.threads.find((entry) => entry.id === request?.threadId);
    return store.projects.find((entry) => entry.id === thread?.projectId)?.name;
  });
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.computer) return;
    const store = useAgentComputerActivityStore.getState();
    const off = [
      api?.computer?.access.onRequested(store.request),
      api?.computer?.access.onSettled(store.settle),
      api?.computer?.access.onGrantsChanged((event) =>
        store.setGrants(event.threadId, event.grants),
      ),
      api?.computer?.onActivity(store.record),
      api?.computer?.onObservationsInvalidated?.((event) => store.invalidate(event.threadId)),
      api?.computer?.onLeaseChanged(store.setLeases),
      api?.preview.automation.onPauseChanged((event) =>
        store.setPaused(event.threadId, event.paused),
      ),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe?.());
  }, []);
  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      {!request && persistenceFailure ? (
        <div
          role="status"
          className="fixed right-4 bottom-20 z-40 w-[min(28rem,calc(100vw-2rem))] rounded-xl border bg-popover p-4 text-sm shadow-lg"
        >
          <p>Permission applies until F5 closes.</p>
          <p>{persistenceFailure.persistenceReason ?? "F5 could not save Don't ask again."}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDismissed(persistenceFailure.requestId)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {request && canReview ? (
        <section
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="fixed left-1/2 z-40 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-xl border bg-popover text-popover-foreground shadow-lg"
          style={{ top: panelTop, maxHeight: "calc(100dvh - " + (panelTop + 16) + "px)" }}
        >
          <div className="space-y-2 p-6">
            <h2 id={titleId} className="font-semibold text-lg">
              {request.kind === "chrome-setup"
                ? "Browser integration setup"
                : request.kind === "foreground-takeover"
                  ? "Foreground control"
                  : "Computer access"}
            </h2>
            <p id={descriptionId} className="text-muted-foreground text-sm">
              {request.kind === "chrome-setup"
                ? "Review the browser registration change before allowing it."
                : request.kind === "foreground-takeover"
                  ? `The agent asks to take over ${request.takeover?.appName ?? "an app"} with the mouse and keyboard. It starts once you stop using them.`
                  : request.kind === "session-actions" && request.background
                    ? "The agent may keep acting in granted apps while you work elsewhere."
                    : "Choose which apps the agent can use for this session."}
            </p>
          </div>
          <div className="space-y-1 px-6 pb-3 text-muted-foreground text-sm">
            <p>{[projectName, title].filter(Boolean).join(" · ")}</p>
            {request.expiresAtMs !== undefined ? (
              <RequestDeadline expiresAtMs={request.expiresAtMs} />
            ) : null}
            {pending.length > 1 ? <p>{pending.length - 1} more requests waiting</p> : null}
          </div>
          <ComputerAccessCard key={request.requestId} request={request} />
        </section>
      ) : null}
    </>
  );
}
