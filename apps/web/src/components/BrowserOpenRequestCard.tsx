import type {
  DesktopBrowserOpenBridge,
  DesktopBrowserOpenChoice,
  DesktopBrowserOpenRequest,
} from "@t3tools/contracts";
import { ChevronDownIcon, GlobeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RequestDeadline } from "./RequestDeadline";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";

/**
 * Mounted once per app window, inside the top banner stack under the computer-use pill. Main
 * owns the decision and expiry; this pill only reports the clicked choice. It never takes focus,
 * so typing in a terminal cannot answer it.
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
  // A click aimed at something else as the pill appears must not answer it.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ANSWER_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const locked = sending || !armed;
  const answer = async (choice: DesktopBrowserOpenChoice) => {
    if (locked) return;
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
  const { origin, rest } = urlParts(request.url, request.host);
  return (
    <div
      role="region"
      aria-label="Browser open request"
      data-testid="browser-open-request"
      // Drawn over the frameless titlebar's drag region, which would otherwise take its clicks.
      className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-warning/50 bg-background/95 py-1 pr-1 pl-3 text-sm shadow-md [-webkit-app-region:no-drag]"
    >
      <span className="sr-only" aria-live="polite">
        {`A terminal or agent wants to open ${request.host} in your browser.`}
      </span>
      {/* Icon, title and expander wrap as one unit, so the icon never sits alone on a line. */}
      <span className="flex min-w-0 max-w-full items-center gap-2">
        <GlobeIcon aria-hidden="true" className="size-4 shrink-0 text-warning-foreground" />
        {/* The whole host always shows, wrapping if needed: its end names the real site. */}
        <span title={request.url} className="min-w-0">
          Open <span className="break-all font-mono">{origin}</span>
          {rest ? (
            <span className="inline-block max-w-[24ch] truncate align-bottom font-mono text-muted-foreground">
              {rest}
            </span>
          ) : null}
          ?
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={expanded ? "Hide full URL" : "Show full URL"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
          />
        </Button>
      </span>
      <span className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
        <span>·</span>
        <span>Agent or terminal in {request.profileName}</span>
        <span>·</span>
        <RequestDeadline compact expiresAtMs={request.expiresAtMs} className="tabular-nums" />
        {request.waiting > 0 ? (
          <>
            <span>·</span>
            <span>+{request.waiting} waiting</span>
          </>
        ) : null}
      </span>
      <span className="flex items-center gap-1">
        <Button size="xs" variant="ghost" disabled={locked} onClick={() => void answer("copy")}>
          Copy link
        </Button>
        <Button size="xs" variant="ghost" disabled={locked} onClick={() => void answer("cancel")}>
          Cancel
        </Button>
        <Group aria-label="Open options">
          <Button size="xs" disabled={locked} onClick={() => void answer("open")}>
            Open
          </Button>
          <GroupSeparator />
          <Menu>
            <MenuTrigger
              render={<Button aria-label="More open options" size="icon-xs" />}
              disabled={locked}
            >
              <ChevronDownIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom">
              <MenuItem onClick={() => void answer("allow-host")}>
                Always allow {request.host} until F5 quits
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      </span>
      {/* `w-0 min-w-…` fills its own row without widening the pill to fit a long URL. */}
      {expanded ? (
        <p
          aria-label="Full URL"
          className="mb-1 max-h-40 w-0 min-w-[calc(100%-0.5rem)] overflow-auto break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs"
        >
          {request.url}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mb-1 w-0 min-w-[calc(100%-0.5rem)] text-destructive-foreground text-xs"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** How long a newly shown request ignores clicks; long enough to stop a click already on its way. */
const ANSWER_ARM_DELAY_MS = 500;

/** The host with its port, which tells loopback servers apart, and the rest of the URL. */
function urlParts(url: string, host: string): { origin: string; rest: string } {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return { origin: parsed.host || host, rest: rest === "/" ? "" : rest };
  } catch {
    return { origin: host, rest: "" };
  }
}
