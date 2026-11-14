import type { ThreadStatus } from "../threadStatus";
import { groupInboxEntries, type InboxEntry, type InboxGroup } from "./inboxStore";
import type { NotificationSource } from "./preferences";

/** The inbox's segmented filter. */
export type InboxView = "all" | "needs-you" | "unread";

/** Thread states that wait on the user; an entry about one stays pinned while it lasts. */
const WAITING_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "pending-approval",
  "awaiting-input",
  "plan-ready",
]);

/**
 * An entry needs the user while what it reports is still true: an approval until it is
 * answered and its thread stops waiting on approval, and an input or plan-ready notice while
 * its thread is still in that state.
 */
export function isNeedsYouEntry(
  entry: InboxEntry,
  threadStatusById: ReadonlyMap<string, ThreadStatus>,
): boolean {
  if (entry.approval) {
    if (entry.resolved) return false;
    return threadStatusById.get(entry.approval.threadId) === "pending-approval";
  }
  if (!entry.threadId || !entry.threadStatus || !WAITING_STATUSES.has(entry.threadStatus)) {
    return false;
  }
  return threadStatusById.get(entry.threadId) === entry.threadStatus;
}

export interface InboxSections {
  /** Pinned above the day groups. */
  readonly needsYou: InboxEntry[];
  /** Today, Yesterday and Earlier, without the pinned entries. */
  readonly groups: InboxGroup[];
  /** Segment badges, counted after the source filter and before the view filter. */
  readonly counts: { readonly needsYou: number; readonly unread: number };
}

/** Source filter first, then the view, then the pinned "Needs you" entries out of the days. */
export function buildInboxSections(
  entries: readonly InboxEntry[],
  options: {
    readonly view: InboxView;
    readonly source: NotificationSource | null;
    readonly threadStatusById: ReadonlyMap<string, ThreadStatus>;
    readonly now: Date;
  },
): InboxSections {
  const bySource = options.source
    ? entries.filter((entry) => entry.source === options.source)
    : entries;
  const needsYouIds = new Set(
    bySource
      .filter((entry) => isNeedsYouEntry(entry, options.threadStatusById))
      .map((entry) => entry.id),
  );
  const counts = {
    needsYou: needsYouIds.size,
    unread: bySource.reduce((count, entry) => count + (entry.readAt === null ? 1 : 0), 0),
  };
  const inView =
    options.view === "unread" ? bySource.filter((entry) => entry.readAt === null) : bySource;
  const needsYou = inView.filter((entry) => needsYouIds.has(entry.id));
  if (options.view === "needs-you") return { needsYou, groups: [], counts };
  const rest = inView.filter((entry) => !needsYouIds.has(entry.id));
  return { needsYou, groups: groupInboxEntries(rest, options.now), counts };
}
