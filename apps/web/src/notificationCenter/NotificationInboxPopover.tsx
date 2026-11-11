import { ApprovalRequestId, ThreadId, type ProviderRequestKind } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { updateAppSettings, useAppSettingsSelector } from "../appSettings";
import { resolveToastTile, type AppToastData } from "../components/ui/toast";
import { formatToastAge } from "../components/ui/toast.logic";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup } from "../components/ui/popover";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { useThreadSummaries } from "../threadSelectors";
import {
  groupInboxEntries,
  unreadInboxCount,
  useNotificationInbox,
  useNotificationInboxPopover,
  useVisibleInboxEntries,
  type InboxEntry,
} from "./inboxStore";
import { loadPendingApprovalRequestIds } from "./inlineApproval";
import { respondToNotificationApproval } from "./notify";
import { useOpenNotificationTarget } from "./openTarget";
import {
  describeDoNotDisturb,
  DO_NOT_DISTURB_FOREVER,
  DO_NOT_DISTURB_SNOOZE_LABELS,
  doNotDisturbUntilFor,
  type DoNotDisturbSnooze,
  type NotificationSource,
} from "./preferences";

type InboxFilter = "all" | NotificationSource;

const FILTERS: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "thread", label: "Threads" },
  { value: "pr", label: "Pull requests" },
  { value: "scheduled", label: "Scheduled" },
  { value: "upstream", label: "Upstream" },
  { value: "errors", label: "Errors" },
];

function entryTile(entry: InboxEntry) {
  const type =
    entry.severity === "error"
      ? "error"
      : entry.severity === "success"
        ? "success"
        : entry.source === "pr"
          ? "warning"
          : "info";
  const data: AppToastData = {
    source: entry.source,
    ...(entry.threadStatus ? { threadStatus: entry.threadStatus } : {}),
  };
  return resolveToastTile(type, data);
}

function InboxRow({
  entry,
  now,
  answerable,
  onOpen,
}: {
  entry: InboxEntry;
  now: number;
  answerable: boolean;
  onOpen: (entry: InboxEntry) => void;
}) {
  const remove = useNotificationInbox((state) => state.remove);
  const [pending, setPending] = useState(false);
  const visual = entryTile(entry);
  const Icon = visual?.Icon;
  const answer = (decision: "accept" | "decline") => {
    if (!entry.approval) return;
    setPending(true);
    void respondToNotificationApproval(
      {
        threadId: ThreadId.makeUnsafe(entry.approval.threadId),
        requestId: ApprovalRequestId.makeUnsafe(entry.approval.requestId),
        requestKind: entry.approval.requestKind as ProviderRequestKind,
        ...(entry.approval.detail ? { detail: entry.approval.detail } : {}),
      },
      decision,
    )
      .then(() => useNotificationInbox.getState().markRead(entry.id))
      .catch(() => undefined)
      .finally(() => setPending(false));
  };
  const body = entry.body ?? entry.detail ?? entry.sourceLabel;
  return (
    <li className="group/row relative">
      <button
        type="button"
        data-inbox-row={entry.id}
        className="flex w-full min-w-0 gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/7"
        onClick={() => onOpen(entry)}
      >
        {entry.readAt === null ? (
          <span
            aria-label="Unread"
            className="absolute top-3.5 left-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
        {Icon ? (
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg",
              visual.className,
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={cn(
                "min-w-0 truncate text-ui font-medium",
                entry.readAt !== null && "text-muted-foreground",
              )}
            >
              {entry.title}
            </span>
            {entry.count > 1 ? (
              <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 text-2xs font-semibold tabular-nums">
                ×{entry.count}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums group-hover/row:invisible">
              {formatToastAge(entry.createdAt, now)}
            </span>
          </span>
          {body ? <span className="truncate text-xs text-muted-foreground">{body}</span> : null}
          {entry.resolved ? (
            <span className="text-2xs text-faint-foreground">{entry.resolved.label}</span>
          ) : null}
        </span>
      </button>
      {entry.approval && !entry.resolved && answerable ? (
        <div className="flex gap-1.5 pb-2 pl-11.5 pr-2">
          <Button
            size="xs"
            variant="secondary"
            className="flex-1"
            disabled={pending}
            onClick={() => answer("decline")}
          >
            Deny
          </Button>
          <Button size="xs" className="flex-1" disabled={pending} onClick={() => answer("accept")}>
            Approve
          </Button>
        </div>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${entry.title}`}
        className="absolute top-2 right-2 hidden size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring group-hover/row:flex"
        onClick={() => remove(entry.id)}
      >
        <XIcon className="size-3" />
      </button>
    </li>
  );
}

function DoNotDisturbFooter() {
  const until = useAppSettingsSelector((settings) => settings.doNotDisturbUntil);
  const summary = describeDoNotDisturb(until, new Date());
  return (
    <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5 text-xs">
      <label className="flex items-center justify-between gap-2">
        <span className="flex flex-col">
          <span className="font-medium text-foreground">Do Not Disturb</span>
          {summary ? <span className="text-muted-foreground">{summary}</span> : null}
        </span>
        <Switch
          aria-label="Do Not Disturb"
          checked={summary !== null}
          onCheckedChange={(checked) =>
            updateAppSettings({ doNotDisturbUntil: checked ? DO_NOT_DISTURB_FOREVER : null })
          }
        />
      </label>
      {summary === null ? (
        <div className="flex flex-wrap gap-1">
          {(["1h", "tomorrow"] as const satisfies readonly DoNotDisturbSnooze[]).map((snooze) => (
            <button
              key={snooze}
              type="button"
              className="rounded-md bg-secondary px-2 py-0.5 text-muted-foreground outline-none hover:bg-control-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                updateAppSettings({ doNotDisturbUntil: doNotDisturbUntilFor(snooze, new Date()) })
              }
            >
              {DO_NOT_DISTURB_SNOOZE_LABELS[snooze]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The notification inbox, anchored to the sidebar bell: filters, Today/Yesterday/Earlier groups,
 * inline approvals, and Do Not Disturb. Arrow keys move between rows; Backspace removes one.
 */
export function NotificationInboxPopover({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const open = useNotificationInboxPopover((state) => state.open);
  const setOpen = useNotificationInboxPopover((state) => state.setOpen);
  const entries = useVisibleInboxEntries();
  const preferences = useAppSettingsSelector((settings) => settings.notificationPreferences);
  const markRead = useNotificationInbox((state) => state.markRead);
  const markAllRead = useNotificationInbox((state) => state.markAllRead);
  const remove = useNotificationInbox((state) => state.remove);
  const openTarget = useOpenNotificationTarget();
  const navigate = useNavigate();
  const threads = useThreadSummaries();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const pendingApprovalThreads = useMemo(
    () =>
      new Set(
        threads.filter((thread) => thread.status === "pending-approval").map((thread) => thread.id),
      ),
    [threads],
  );
  // A thread can wait on a newer request than the one an entry offers to answer, so the
  // buttons show only for requests the thread is confirmed to still wait on.
  const threadsToVerify = useMemo(
    () =>
      [
        ...new Set(
          entries
            .filter(
              (entry) =>
                entry.approval &&
                !entry.resolved &&
                pendingApprovalThreads.has(ThreadId.makeUnsafe(entry.approval.threadId)),
            )
            .map((entry) => entry.approval!.threadId),
        ),
      ]
        .sort()
        .join(","),
    [entries, pendingApprovalThreads],
  );
  const [pendingRequestIds, setPendingRequestIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!open || threadsToVerify.length === 0) {
      setPendingRequestIds(new Set());
      return;
    }
    let cancelled = false;
    const threadIds = threadsToVerify.split(",").map((id) => ThreadId.makeUnsafe(id));
    void Promise.all(threadIds.map((threadId) => loadPendingApprovalRequestIds(threadId))).then(
      (results) => {
        if (cancelled) return;
        const pending = new Set<string>();
        const inbox = useNotificationInbox.getState();
        results.forEach((ids, index) => {
          if (!ids) return;
          for (const id of ids) pending.add(id);
          for (const entry of inbox.entries) {
            const approval = entry.approval;
            if (
              approval &&
              approval.threadId === threadIds[index] &&
              !entry.resolved &&
              !ids.has(approval.requestId)
            )
              inbox.resolveApproval(approval.requestId, "Answered");
          }
        });
        setPendingRequestIds(pending);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, threadsToVerify]);
  // Filters for sources kept out of the inbox would always be empty, so they are hidden.
  const filters = FILTERS.filter(
    (option) => option.value === "all" || preferences[option.value].inbox,
  );
  const activeFilter = filters.some((option) => option.value === filter) ? filter : "all";
  const visible = useMemo(
    () =>
      activeFilter === "all" ? entries : entries.filter((entry) => entry.source === activeFilter),
    [entries, activeFilter],
  );
  const groups = groupInboxEntries(visible, new Date(now));
  const unread = unreadInboxCount(entries);

  const openEntry = (entry: InboxEntry) => {
    markRead(entry.id);
    if (entry.target.kind === "none") return;
    setOpen(false);
    void openTarget(entry.target);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-inbox-row]") ?? [],
    );
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = index < 0 ? (step > 0 ? 0 : rows.length - 1) : index + step;
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && index >= 0) {
      event.preventDefault();
      const id = rows[index]!.dataset.inboxRow!;
      (rows[index + 1] ?? rows[index - 1])?.focus();
      remove(id);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // A press on the bell itself toggles; let its click decide instead of closing here.
        const target = details.event?.target;
        if (!next && target instanceof Node && anchor.current?.contains(target)) return;
        setOpen(next);
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={6}
        aria-label="Notifications"
        className="w-95 max-w-[calc(100vw-2rem)] p-0 **:data-[slot=popover-viewport]:p-0"
      >
        <div className="flex max-h-[70vh] flex-col" data-testid="notification-inbox">
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 ? (
              <span className="rounded-full bg-primary px-1.5 text-2xs font-semibold text-primary-foreground tabular-nums">
                {unread} new
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {unread > 0 ? (
                <Button size="xs" variant="ghost" onClick={markAllRead}>
                  Mark all read
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Notification settings"
                onClick={() => {
                  setOpen(false);
                  void navigate({ to: "/settings", search: { category: "notifications" } });
                }}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1 px-3 pb-2" role="tablist" aria-label="Filter">
            {filters.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={activeFilter === option.value}
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  activeFilter === option.value
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto border-t border-border px-1 py-1"
            onKeyDown={onListKeyDown}
          >
            {groups.length === 0 ? (
              <p className="px-3 py-10 text-center text-ui text-muted-foreground">
                You're all caught up
              </p>
            ) : (
              groups.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <h3 className="px-2 pt-2 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                    {group.label}
                  </h3>
                  <ul>
                    {group.entries.map((entry) => (
                      <InboxRow
                        key={entry.id}
                        entry={entry}
                        now={now}
                        answerable={
                          entry.approval
                            ? pendingApprovalThreads.has(
                                ThreadId.makeUnsafe(entry.approval.threadId),
                              ) && pendingRequestIds.has(entry.approval.requestId)
                            : false
                        }
                        onOpen={openEntry}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
          <DoNotDisturbFooter />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
