import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ToastItemTone } from "../components/ui/toast";
import type { ThreadStatus } from "../threadStatus";
import type { NotificationSeverity } from "./notify";
import type { NotificationTarget } from "./openTarget";
import { NOTIFICATION_SOURCES, type NotificationSource } from "./preferences";

export const NOTIFICATION_INBOX_STORAGE_KEY = "f5:notifications:inbox:v1";
export const INBOX_MAX_ENTRIES = 200;
export const INBOX_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface InboxItem {
  readonly id: string;
  readonly label: string;
  readonly trailing?: string;
  readonly tone?: ToastItemTone;
  readonly target: NotificationTarget;
}

export interface InboxApproval {
  readonly threadId: string;
  readonly requestId: string;
  readonly requestKind: string;
  readonly detail?: string;
}

export interface InboxEntry {
  readonly id: string;
  readonly source: NotificationSource;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string;
  readonly detail?: string;
  readonly sourceLabel?: string;
  readonly items?: readonly InboxItem[];
  readonly moreCount?: number;
  readonly target: NotificationTarget;
  readonly threadId?: string;
  readonly threadStatus?: ThreadStatus;
  readonly approval?: InboxApproval;
  readonly dedupeKey?: string;
  readonly count: number;
  readonly createdAt: number;
  readonly readAt: number | null;
  /** An approval answered (here, in the chat or elsewhere): shown muted, without actions. */
  readonly resolved?: { readonly label: string; readonly at: number };
}

export type InboxRecordInput = Omit<InboxEntry, "count" | "readAt" | "resolved">;

/**
 * Adds an entry, newest first. A repeat of an unread entry (same dedupe key) bumps its count
 * and moves it to the top instead of adding a row. Old entries fall off by age and by count.
 */
export function recordInboxEntry(
  entries: readonly InboxEntry[],
  input: InboxRecordInput,
  nowMs: number,
): InboxEntry[] {
  const index = input.dedupeKey
    ? entries.findIndex((entry) => entry.dedupeKey === input.dedupeKey && entry.readAt === null)
    : -1;
  let next: InboxEntry[];
  if (index >= 0) {
    const existing = entries[index]!;
    const merged: InboxEntry = {
      ...input,
      id: existing.id,
      count: existing.count + 1,
      readAt: null,
    };
    next = [merged, ...entries.slice(0, index), ...entries.slice(index + 1)];
  } else {
    next = [{ ...input, count: 1, readAt: null }, ...entries];
  }
  return pruneInboxEntries(next, nowMs);
}

export function pruneInboxEntries(entries: readonly InboxEntry[], nowMs: number): InboxEntry[] {
  return entries
    .filter((entry) => nowMs - entry.createdAt <= INBOX_MAX_AGE_MS)
    .slice(0, INBOX_MAX_ENTRIES);
}

function markEntryRead(entry: InboxEntry, nowMs: number): InboxEntry {
  return entry.readAt === null ? { ...entry, readAt: nowMs } : entry;
}

export function unreadInboxCount(entries: readonly InboxEntry[]): number {
  return entries.reduce((count, entry) => count + (entry.readAt === null ? 1 : 0), 0);
}

export type InboxGroup = {
  readonly label: "Today" | "Yesterday" | "Earlier";
  readonly entries: InboxEntry[];
};

/** Today, Yesterday and Earlier, in the user's local calendar. */
export function groupInboxEntries(entries: readonly InboxEntry[], now: Date): InboxGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const groups: InboxGroup[] = [
    { label: "Today", entries: [] },
    { label: "Yesterday", entries: [] },
    { label: "Earlier", entries: [] },
  ];
  for (const entry of entries) {
    if (entry.createdAt >= startOfToday.getTime()) groups[0]!.entries.push(entry);
    else if (entry.createdAt >= startOfYesterday.getTime()) groups[1]!.entries.push(entry);
    else groups[2]!.entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}

interface InboxState {
  entries: InboxEntry[];
  record: (input: InboxRecordInput) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  markThreadRead: (threadId: string) => void;
  resolveApproval: (requestId: string, label: string) => void;
  /** The thread stopped waiting on approval, so its approval entries can no longer be answered. */
  resolveThreadApprovals: (threadId: string, label: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const noopStorage = {
  getItem: (_name: string) => null,
  setItem: (_name: string, _value: string) => {},
  removeItem: (_name: string) => {},
};

function getInboxStorage() {
  if (
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function" &&
    typeof localStorage.setItem === "function" &&
    typeof localStorage.removeItem === "function"
  ) {
    return localStorage;
  }
  return noopStorage;
}

const SOURCES = new Set<string>(NOTIFICATION_SOURCES);

function isInboxEntry(value: unknown): value is InboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.count === "number" &&
    SOURCES.has(entry.source as string) &&
    Boolean(entry.target) &&
    typeof entry.target === "object"
  );
}

/** Whether the inbox popover is open; shared by the bell and the keyboard shortcut. */
export const useNotificationInboxPopover = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));

/** The notification inbox: a local history of what F5 told the user, kept for two weeks. */
export const useNotificationInbox = create<InboxState>()(
  persist(
    (set) => ({
      entries: [],
      record: (input) =>
        set((state) => ({ entries: recordInboxEntry(state.entries, input, Date.now()) })),
      markRead: (id) =>
        set((state) => ({
          entries: state.entries.map((entry) =>
            entry.id === id ? markEntryRead(entry, Date.now()) : entry,
          ),
        })),
      markAllRead: () =>
        set((state) => {
          const now = Date.now();
          return { entries: state.entries.map((entry) => markEntryRead(entry, now)) };
        }),
      markThreadRead: (threadId) =>
        set((state) => {
          if (!state.entries.some((entry) => entry.threadId === threadId && !entry.readAt))
            return state;
          const now = Date.now();
          return {
            entries: state.entries.map((entry) =>
              entry.threadId === threadId ? markEntryRead(entry, now) : entry,
            ),
          };
        }),
      resolveApproval: (requestId, label) =>
        set((state) => {
          if (!state.entries.some((entry) => entry.approval?.requestId === requestId)) return state;
          const now = Date.now();
          return {
            entries: state.entries.map((entry) =>
              entry.approval?.requestId === requestId && !entry.resolved
                ? { ...entry, resolved: { label, at: now } }
                : entry,
            ),
          };
        }),
      resolveThreadApprovals: (threadId, label) =>
        set((state) => {
          const pending = (entry: InboxEntry) =>
            entry.approval?.threadId === threadId && !entry.resolved;
          if (!state.entries.some(pending)) return state;
          const now = Date.now();
          return {
            entries: state.entries.map((entry) =>
              pending(entry) ? { ...entry, resolved: { label, at: now } } : entry,
            ),
          };
        }),
      remove: (id) =>
        set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),
      clear: () => set({ entries: [] }),
    }),
    {
      name: NOTIFICATION_INBOX_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(getInboxStorage),
      partialize: (state) => ({ entries: state.entries }),
      // One malformed entry must not cost the whole history; old entries fall off on load.
      merge: (persisted, current) => {
        const raw = (persisted as { entries?: unknown } | undefined)?.entries;
        const entries = Array.isArray(raw) ? raw.filter(isInboxEntry) : [];
        return { ...current, entries: pruneInboxEntries(entries, Date.now()) };
      },
    },
  ),
);
