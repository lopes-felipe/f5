import type {
  DesktopBrowserOpenBridge,
  DesktopBrowserOpenChoice,
  DesktopBrowserOpenRequest,
} from "@t3tools/contracts";
import { ChevronDownIcon, GlobeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { RequestDeadline } from "./RequestDeadline";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";

/**
 * Mounted once per app window. Main owns the decision and expiry; this card only reports the
 * clicked choice. It never takes focus, so typing in a terminal cannot answer it.
 */
export function BrowserOpenRequestCard() {
  const bridge = window.desktopBridge?.browserOpen;
  const [request, setRequest] = useState<DesktopBrowserOpenRequest | null>(null);
  const settled = useRef(new Set<string>());
  const acknowledged = useRef<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const show = (next: DesktopBrowserOpenRequest | null) => {
      if (!disposed && next && !settled.current.has(next.requestId)) setRequest(next);
    };
    const offRequested = bridge.onRequested(show);
    const offSettled = bridge.onSettled((requestId) => {
      settled.current.add(requestId);
      setRequest((current) => (current?.requestId === requestId ? null : current));
    });
    // A window that mounts after main sent the request still picks it up.
    bridge.current().then(show, () => {});
    return () => {
      disposed = true;
      offRequested();
      offSettled();
    };
  }, [bridge]);
  useEffect(() => {
    if (!bridge || !request || acknowledged.current === request.requestId) return;
    acknowledged.current = request.requestId;
    bridge.acknowledge(request.requestId).catch(() => {});
  }, [bridge, request]);
  if (!bridge || !request) return null;
  return <BrowserOpenRequestView key={request.requestId} bridge={bridge} request={request} />;
}

function BrowserOpenRequestView({
  bridge,
  request,
}: {
  bridge: DesktopBrowserOpenBridge;
  request: DesktopBrowserOpenRequest;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const answer = async (choice: DesktopBrowserOpenChoice) => {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      await bridge.answer(request.requestId, choice);
      if (choice === "copy") toastManager.add({ type: "success", title: "Link copied" });
    } catch {
      setError("F5 could not record that choice. Try again.");
      setSending(false);
    }
  };
  return (
    <Card
      role="region"
      aria-label="Browser open request"
      data-testid="browser-open-request"
      className="fixed right-4 bottom-4 z-50 w-96 max-w-[calc(100vw-2rem)] gap-3 p-4 text-sm shadow-lg"
    >
      <span className="sr-only" aria-live="polite">
        {`A terminal or agent wants to open ${request.host} in your browser.`}
      </span>
      <div className="flex items-center gap-2">
        <GlobeIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 font-medium">Open in browser?</p>
        <RequestDeadline
          expiresAtMs={request.expiresAtMs}
          className="text-muted-foreground text-xs tabular-nums"
        />
      </div>
      <Collapsible open={expanded} onOpenChange={setExpanded} className="min-w-0 space-y-1">
        <p className="break-all font-medium text-base">{request.host}</p>
        <div className="flex min-w-0 items-center gap-1">
          <p className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
            {request.url}
          </p>
          <CollapsibleTrigger
            render={
              <Button
                aria-label={expanded ? "Hide full URL" : "Show full URL"}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("transition-transform", expanded && "rotate-180")}
            />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <p
            aria-label="Full URL"
            className="max-h-40 overflow-auto break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs"
          >
            {request.url}
          </p>
        </CollapsiblePanel>
      </Collapsible>
      <p className="text-muted-foreground text-xs">
        Requested by a terminal or agent in {request.profileName}
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" disabled={sending} onClick={() => void answer("copy")}>
          Copy link
        </Button>
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => void answer("cancel")}>
          Cancel
        </Button>
        <Group aria-label="Open options">
          <Button size="sm" disabled={sending} onClick={() => void answer("open")}>
            Open
          </Button>
          <GroupSeparator />
          <Menu>
            <MenuTrigger
              render={<Button aria-label="More open options" size="icon-sm" />}
              disabled={sending}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              <MenuItem onClick={() => void answer("allow-host")}>
                Always allow {request.host} until F5 quits
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      </div>
      {request.waiting > 0 ? (
        <p className="text-muted-foreground text-xs">+{request.waiting} more waiting</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
