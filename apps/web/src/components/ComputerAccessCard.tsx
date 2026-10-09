import { useEffect, useState } from "react";
import type { ComputerAccessPush } from "@t3tools/contracts";
import { initialComputerAccessDecisions, computerAccessAnswer } from "./ComputerAccessCard.logic";
import { readNativeApi } from "../nativeApi";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogHeader } from "./ui/dialog";

export function ComputerAccessCard({
  request,
  settled,
  allowed,
  handleEscape = false,
}: {
  handleEscape?: boolean;
  request: typeof ComputerAccessPush.Type;
  settled?: boolean | undefined;
  allowed?: boolean | undefined;
}) {
  const [decisions, setDecisions] = useState(() => initialComputerAccessDecisions(request));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bridge = window.desktopBridge?.computerAutomation;
  const answer = async (allow: boolean, trusted: boolean) => {
    if (!bridge || !trusted || settled || sending) return;
    setSending(true);
    setError("");
    try {
      await bridge.answerAccess(computerAccessAnswer(request, decisions, allow));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer computer access.");
      setSending(false);
    }
  };
  useEffect(() => {
    if (!handleEscape) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && event.isTrusted) void answer(false, true);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  });
  const change = (appId: string, key: "allow" | "allowTyping" | "remember", value: boolean) =>
    setDecisions((current) =>
      current.map((decision) =>
        decision.appId === appId ? { ...decision, [key]: value } : decision,
      ),
    );
  return (
    <div className="space-y-3 p-4 text-sm" data-testid="computer-access-card">
      <p>{request.reason}</p>
      {request.chromeSetup ? (
        <div className="space-y-2 break-all rounded-md border p-3">
          <p>Current targets:</p>
          {request.chromeSetup.previousTargets.map((target) => (
            <p key={target}>{target}</p>
          ))}
          <p>
            New target for {request.chromeSetup.provider}: {request.chromeSetup.targetPath}
          </p>
          <p>This integration can act on sites you are signed in to.</p>
        </div>
      ) : null}
      {request.apps.map((app) => {
        const decision = decisions.find((entry) => entry.appId === app.appId)!;
        return (
          <fieldset
            key={app.appId}
            className="space-y-2 rounded-md border p-3"
            disabled={settled || sending || !bridge || app.tier === "blocked"}
          >
            <legend className="px-1 font-medium">
              {app.name} · {app.tier}
            </legend>
            {app.warning === "browser" ? (
              <p>This app can act on sites you are signed in to.</p>
            ) : null}
            {app.tier === "click" ? <p>Typing here can run commands.</p> : null}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={decision.allow}
                onChange={(event) => change(app.appId, "allow", event.target.checked)}
              />
              Allow
            </label>
            {app.tier === "click" ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!decision.allow}
                  checked={decision.allowTyping}
                  onChange={(event) => change(app.appId, "allowTyping", event.target.checked)}
                />
                Allow typing
              </label>
            ) : null}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!decision.allow}
                checked={decision.remember}
                onChange={(event) => change(app.appId, "remember", event.target.checked)}
              />
              Always allow in this project
            </label>
          </fieldset>
        );
      })}
      {settled ? (
        <p role="status">{allowed ? "Access allowed" : "Access denied or expired"}</p>
      ) : !bridge ? (
        <p>Answer on the computer running F5.</p>
      ) : (
        <div className="flex gap-2">
          <Button disabled={sending} onClick={(event) => void answer(true, event.isTrusted)}>
            {request.kind === "apps" ? "Allow selected" : "Allow"}
          </Button>
          <Button
            variant="outline"
            disabled={sending}
            onClick={(event) => void answer(false, event.isTrusted)}
          >
            Deny all
          </Button>
        </div>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
/** Mounted once per app window. Consent stays visible even when its thread is not selected. */
export function ComputerAccessInbox() {
  const requests = useAgentComputerActivityStore((state) => state.requests);
  useEffect(() => {
    const api = readNativeApi();
    const store = useAgentComputerActivityStore.getState();
    const off = [
      api?.computer?.access.onRequested(store.request),
      api?.computer?.access.onSettled(store.settle),
      api?.computer?.access.onGrantsChanged((event) =>
        store.setGrants(event.threadId, event.grants),
      ),
      api?.computer?.onActivity(store.record),
      api?.computer?.onLeaseChanged(store.setLease),
      api?.preview.automation.onPauseChanged((event) =>
        store.setPaused(event.threadId, event.paused),
      ),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe?.());
  }, []);
  const request = Object.values(requests).find((entry) => entry && !entry.settled);
  if (!request || !window.desktopBridge?.computerAutomation) return null;
  return (
    <Dialog open>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {request.kind === "chrome-setup" ? "Browser integration setup" : "Computer access"}
          </DialogTitle>
          <DialogDescription>
            {request.kind === "chrome-setup"
              ? "Review the browser registration change before allowing it."
              : "Choose which apps the agent can use for this session."}
          </DialogDescription>
        </DialogHeader>
        <ComputerAccessCard key={request.requestId} request={request} handleEscape />
      </DialogPopup>
    </Dialog>
  );
}
export function ComputerAccessTimeline({ threadId }: { threadId: string }) {
  const requests = useAgentComputerActivityStore((state) => state.requests);
  return (
    <>
      {Object.values(requests)
        .filter((request) => request?.threadId === threadId)
        .map((request) =>
          request ? (
            <div key={request.requestId} className="my-2 rounded-lg border">
              <ComputerAccessCard
                request={request}
                settled={request.settled}
                allowed={request.allowed}
              />
            </div>
          ) : null,
        )}
    </>
  );
}
