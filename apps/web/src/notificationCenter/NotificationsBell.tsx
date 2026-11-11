import { BellIcon, BellOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAppSettingsSelector } from "../appSettings";
import { formatCompactCount } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { shortcutLabelForCommand, useServerKeybindings } from "../keybindings";
import {
  unreadInboxCount,
  useNotificationInboxPopover,
  useVisibleInboxEntries,
} from "./inboxStore";
import { NotificationInboxPopover } from "./NotificationInboxPopover";
import { isDoNotDisturbActive } from "./preferences";

/** Do Not Disturb, re-checked every 30s so a timed snooze ends on its own. */
function useDoNotDisturbActive(): boolean {
  const until = useAppSettingsSelector((settings) => settings.doNotDisturbUntil);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [until]);
  return isDoNotDisturbActive(until, now);
}

/**
 * The bell in the sidebar title bar: unread count, Do Not Disturb state, and the inbox popover
 * it anchors. Styled like the back/forward buttons; as a `<button>` it stays clickable inside the
 * desktop title bar's drag region (`.drag-region button` in index.css).
 */
export function NotificationsBell() {
  const unread = unreadInboxCount(useVisibleInboxEntries());
  const open = useNotificationInboxPopover((state) => state.open);
  const toggle = useNotificationInboxPopover((state) => state.toggle);
  const dnd = useDoNotDisturbActive();
  const keybindings = useServerKeybindings();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "notifications.toggle");
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const label = dnd ? "Notifications (Do Not Disturb)" : "Notifications";
  const Icon = dnd ? BellOffIcon : BellIcon;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={bellRef}
              aria-label={label}
              aria-pressed={open}
              data-testid="sidebar-notifications"
              className="relative text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              onClick={toggle}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {unread > 0 ? (
            <span className="pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-2xs leading-none font-medium text-white tabular-nums">
              <span aria-hidden="true">{formatCompactCount(unread)}</span>
              <span className="sr-only">{` ${unread} unread`}</span>
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="flex items-center gap-2">
          {label}
          {unread > 0 ? (
            <span className="text-muted-foreground tabular-nums">
              {unread.toLocaleString()} unread
            </span>
          ) : null}
          {shortcutLabel ? <Kbd>{shortcutLabel}</Kbd> : null}
        </TooltipPopup>
      </Tooltip>
      <NotificationInboxPopover anchor={bellRef} />
    </>
  );
}
