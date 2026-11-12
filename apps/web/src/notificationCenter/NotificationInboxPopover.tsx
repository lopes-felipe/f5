import { ApprovalRequestId, ThreadId, type ProviderRequestKind } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckCheckIcon, ListFilterIcon, MoonIcon, SettingsIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { updateAppSettings, useAppSettingsSelector } from "../appSettings";
import {
  ITEM_TONE_CLASS,
  resolveToastVisual,
  ToastGlyph,
  ToastRail,
  type AppToastData,
  type ToastVisual,
} from "../components/ui/toast";
import { formatToastAge } from "../components/ui/toast.logic";
import { Button } from "../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../components/ui/menu";
import { Popover, PopoverPopup } from "../components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import type { ThreadStatus } from "../threadStatus";
import { useThreadSummaries } from "../threadSelectors";
import {
  useNotificationInbox,
  useNotificationInboxPopover,
  useVisibleInboxEntries,
  type InboxEntry,
} from "./inboxStore";
import { buildInboxSections, type InboxView } from "./inboxView.logic";
import { loadPendingApprovalRequestIds } from "./inlineApproval";
import { respondToNotificationApproval } from "./notify";
import { useOpenNotificationTarget } from "./openTarget";
import {
  describeDoNotDisturb,
  DO_NOT_DISTURB_SNOOZE_LABELS,
  doNotDisturbUntilFor,
  type DoNotDisturbSnooze,
  type NotificationSource,
} from "./preferences";

const SOURCE_FILTERS: ReadonlyArray<{ value: NotificationSource; label: string }> = [
  { value: "thread", label: "Threads" },
  { value: "pr", label: "Pull requests" },
  { value: "scheduled", label: "Scheduled" },
  { value: "upstream", label: "Upstream" },
  { value: "errors", label: "Errors" },
];

const ALL_SOURCES = "all";
const MAX_ROW_ITEMS = 3;

function entryVisual(entry: InboxEntry): ToastVisual {
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
  const visual = resolveToastVisual(type, data);
  // An answered approval is history: it keeps its glyph but loses its colour.
  return entry.resolved ? { ...visual, tone: "muted" } : visual;
}

function InboxRowItems({ entry }: { entry: InboxEntry }) {
  const items = entry.items ?? [];
  if (items.length === 0) return null;
  const more = (entry.moreCount ?? 0) + Math.max(0, items.length - MAX_ROW_ITEMS);
  return (
    <span className="mt-0.5 flex min-w-0 flex-col gap-0.5" data-slot="inbox-row-items">
      {items.slice(0, MAX_ROW_ITEMS).map((item) => (
        <span key={item.id} className="flex min-w-0 items-center gap-2 text-xs">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", ITEM_TONE_CLASS[item.tone ?? "muted"])}
          />
          <span className="min-w-0 truncate font-mono text-foreground">{item.label}</span>
          {item.trailing ? (
            <span className="shrink-0 text-muted-foreground">{item.trailing}</span>
          ) : null}
        </span>
      ))}
      {more > 0 ? <span className="text-xs text-muted-foreground">+ {more} more</span> : null}
    </span>
  );
}

function InboxRow({
  entry,
  now,
  answerable,
  pinned,
  onOpen,
}: {
  entry: InboxEntry;
  now: number;
  answerable: boolean;
  pinned: boolean;
  onOpen: (entry: InboxEntry) => void;
}) {
  const remove = useNotificationInbox((state) => state.remove);
  const [pending, setPending] = useState(false);
  const visual = entryVisual(entry);
  const unread = entry.readAt === null;
  const showApproval = Boolean(entry.approval && !entry.resolved && answerable);
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
  // With the approval buttons showing, the detail moves to their line.
  const approvalDetail = showApproval ? (entry.detail ?? entry.approval?.detail) : undefined;
  const secondLine = showApproval
    ? (entry.body ?? entry.sourceLabel)
    : (entry.body ?? entry.detail ?? entry.sourceLabel);
  return (
    <li
      className={cn("group/row relative overflow-hidden rounded-lg", pinned && "bg-foreground/5")}
      data-inbox-pinned={pinned ? "" : undefined}
    >
      <ToastRail tone={visual.tone} />
      {unread ? (
        <span
          aria-label="Unread"
          className="absolute top-3.5 left-1.5 size-1.5 rounded-full bg-primary"
        />
      ) : null}
      <button
        type="button"
        data-inbox-row={entry.id}
        className="flex w-full min-w-0 gap-2 rounded-lg py-2 pr-2 pl-4 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/7"
        onClick={() => onOpen(entry)}
      >
        <ToastGlyph visual={visual} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 truncate text-ui font-medium",
                !unread && "text-muted-foreground",
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
          {secondLine ? (
            <span className="truncate text-xs text-muted-foreground">{secondLine}</span>
          ) : null}
          <InboxRowItems entry={entry} />
          {entry.resolved ? (
            <span className="text-2xs text-faint-foreground">{entry.resolved.label}</span>
          ) : null}
        </span>
      </button>
      {showApproval ? (
        <div className="flex min-w-0 items-center gap-2 pr-2 pb-2 pl-10">
          {approvalDetail ? (
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
              title={approvalDetail}
            >
              {approvalDetail}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            size="xs"
            variant="secondary"
            disabled={pending}
            onClick={() => answer("decline")}
          >
            Deny
          </Button>
          <Button size="xs" disabled={pending} onClick={() => answer("accept")}>
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

function SourceFilterMenu({
  sources,
  value,
  onChange,
}: {
  sources: ReadonlyArray<{ value: NotificationSource; label: string }>;
  value: NotificationSource | null;
  onChange: (source: NotificationSource | null) => void;
}) {
  const label = value
    ? `Filter by source: ${sources.find((option) => option.value === value)?.label ?? value}`
    : "Filter by source";
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            title={label}
            className="relative"
            data-testid="inbox-source-filter"
          />
        }
      >
        <ListFilterIcon className="size-3.5" />
        {value ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={value ?? ALL_SOURCES}
          onValueChange={(next) =>
            onChange(next === ALL_SOURCES ? null : (next as NotificationSource))
          }
        >
          <MenuRadioItem value={ALL_SOURCES} closeOnClick>
            All sources
          </MenuRadioItem>
          {sources.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} closeOnClick>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function DoNotDisturbMenu() {
  const until = useAppSettingsSelector((settings) => settings.doNotDisturbUntil);
  const summary = describeDoNotDisturb(until, new Date());
  const active = summary !== null;
  const label = active ? `Do Not Disturb: ${summary}` : "Do Not Disturb";
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            title={label}
            data-active={active ? "" : undefined}
            className={cn(active && "bg-control-active text-foreground")}
            data-testid="inbox-do-not-disturb"
          />
        }
      >
        <MoonIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>
            {active ? `Do Not Disturb: ${summary}` : "Do Not Disturb"}
          </MenuGroupLabel>
          {active ? (
            <MenuItem onClick={() => updateAppSettings({ doNotDisturbUntil: null })}>
              Turn off
            </MenuItem>
          ) : (
            (["1h", "tomorrow", "forever"] as const satisfies readonly DoNotDisturbSnooze[]).map(
              (snooze) => (
                <MenuItem
                  key={snooze}
                  onClick={() =>
                    updateAppSettings({
                      doNotDisturbUntil: doNotDisturbUntilFor(snooze, new Date()),
                    })
                  }
                >
                  {DO_NOT_DISTURB_SNOOZE_LABELS[snooze]}
                </MenuItem>
              ),
            )
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <h3 className="px-2 pt-2 pb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
      {label}
    </h3>
  );
}

/**
 * The notification inbox, anchored to the sidebar bell: what needs you pinned on top, then
 * Today/Yesterday/Earlier, with All / Needs you / Unread views, a source filter and Do Not
 * Disturb in the header. Arrow keys move between rows; Backspace removes one.
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
  const [view, setView] = useState<InboxView>("all");
  const [source, setSource] = useState<NotificationSource | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const threadStatusById = useMemo(
    () => new Map<string, ThreadStatus>(threads.map((thread) => [thread.id, thread.status])),
    [threads],
  );
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
  // Sources kept out of the inbox would always be empty, so they are not offered; a selected
  // source whose Inbox switch goes off falls back to all sources.
  const sources = SOURCE_FILTERS.filter((option) => preferences[option.value].inbox);
  const activeSource = source && sources.some((option) => option.value === source) ? source : null;
  const sections = useMemo(
    () =>
      buildInboxSections(entries, {
        view,
        source: activeSource,
        threadStatusById,
        now: new Date(now),
      }),
    [entries, view, activeSource, threadStatusById, now],
  );
  const hasUnread = entries.some((entry) => entry.readAt === null);
  const isEmpty = sections.needsYou.length === 0 && sections.groups.length === 0;

  const openEntry = (entry: InboxEntry) => {
    markRead(entry.id);
    if (entry.target.kind === "none") return;
    setOpen(false);
    void openTarget(entry.target);
  };

  const isAnswerable = (entry: InboxEntry) =>
    entry.approval
      ? pendingApprovalThreads.has(ThreadId.makeUnsafe(entry.approval.threadId)) &&
        pendingRequestIds.has(entry.approval.requestId)
      : false;

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
          <div className="flex items-center gap-1 pt-2.5 pr-2 pb-2 pl-3">
            <h2 className="flex-1 text-sm font-semibold">Notifications</h2>
            <SourceFilterMenu sources={sources} value={activeSource} onChange={setSource} />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Mark all read"
              title="Mark all read"
              disabled={!hasUnread}
              onClick={markAllRead}
            >
              <CheckCheckIcon className="size-3.5" />
            </Button>
            <DoNotDisturbMenu />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Notification settings"
              title="Notification settings"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings", search: { category: "notifications" } });
              }}
            >
              <SettingsIcon className="size-3.5" />
            </Button>
          </div>
          <div className="px-3 pb-2">
            <ToggleGroup
              variant="outline"
              size="xs"
              aria-label="Show"
              className="w-full"
              value={[view]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "all" || next === "needs-you" || next === "unread") setView(next);
              }}
            >
              <ToggleGroupItem value="all" className="flex-1" data-inbox-view="all">
                All
              </ToggleGroupItem>
              <ToggleGroupItem value="needs-you" className="flex-1" data-inbox-view="needs-you">
                Needs you
                {sections.counts.needsYou > 0 ? (
                  <span className="text-2xs font-semibold text-warning-foreground tabular-nums">
                    {sections.counts.needsYou}
                  </span>
                ) : null}
              </ToggleGroupItem>
              <ToggleGroupItem value="unread" className="flex-1" data-inbox-view="unread">
                Unread
                {sections.counts.unread > 0 ? (
                  <span className="text-2xs font-semibold tabular-nums">
                    {sections.counts.unread}
                  </span>
                ) : null}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto border-t border-border"
            onKeyDown={onListKeyDown}
          >
            {isEmpty ? (
              <p className="px-3 py-10 text-center text-ui text-muted-foreground">
                {view === "needs-you" ? "Nothing needs you" : "You're all caught up"}
              </p>
            ) : (
              <>
                {sections.needsYou.length > 0 ? (
                  <section
                    aria-label="Needs you"
                    className="px-1 pb-1"
                    data-inbox-section="needs-you"
                  >
                    <SectionHeading label="Needs you" />
                    <ul className="flex flex-col gap-px">
                      {sections.needsYou.map((entry) => (
                        <InboxRow
                          key={entry.id}
                          entry={entry}
                          now={now}
                          answerable={isAnswerable(entry)}
                          pinned
                          onOpen={openEntry}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}
                {sections.groups.map((group, index) => (
                  <section
                    key={group.label}
                    aria-label={group.label}
                    className={cn(
                      "px-1 pb-1",
                      (index > 0 || sections.needsYou.length > 0) && "border-t border-border",
                    )}
                    data-inbox-section={group.label}
                  >
                    <SectionHeading label={group.label} />
                    <ul className="flex flex-col gap-px">
                      {group.entries.map((entry) => (
                        <InboxRow
                          key={entry.id}
                          entry={entry}
                          now={now}
                          answerable={isAnswerable(entry)}
                          pinned={false}
                          onOpen={openEntry}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
