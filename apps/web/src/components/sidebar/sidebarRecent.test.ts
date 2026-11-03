import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadStatus } from "../../threadStatus";
import type { ThreadListItem } from "../../types";
import type { SidebarWorkflowEntry } from "./sidebarLists";
import { bucketRecentSidebarItems, type RecentSidebarItem } from "./sidebarRecent";

const PROJECT_ID = ProjectId.makeUnsafe("project");
// Local noon, so day boundaries are the machine's own midnight.
const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime();
const at = (daysBack: number, hour: number) =>
  new Date(2026, 10, 3 - daysBack, hour, 0, 0).toISOString();

const threadItem = (
  id: string,
  activityAt: string,
  extra: Partial<ThreadListItem> = {},
): RecentSidebarItem => ({
  kind: "thread",
  key: `thread:${id}`,
  projectId: PROJECT_ID,
  thread: {
    id: ThreadId.makeUnsafe(id),
    lastInteractionAt: activityAt,
    pinnedAt: null,
    pinOrderKey: null,
    ...extra,
  } as ThreadListItem,
  activityAt,
});

const workflowItem = (
  id: string,
  activityAt: string,
  overallState: "active" | "completed",
): RecentSidebarItem => ({
  kind: "workflow",
  key: `planning:${id}`,
  projectId: PROJECT_ID,
  entry: { type: "planning", workflow: { id } } as unknown as SidebarWorkflowEntry,
  activityAt,
  overallState,
});

const keysOf = (items: readonly RecentSidebarItem[]) => items.map((item) => item.key);

describe("bucketRecentSidebarItems", () => {
  it("splits activity at local midnight and the seven-day boundary", () => {
    const buckets = bucketRecentSidebarItems(
      [
        threadItem("today-early", at(0, 0)),
        threadItem("yesterday-late", at(1, 23)),
        threadItem("yesterday-early", at(1, 0)),
        threadItem("six-days", at(6, 0)),
        threadItem("seven-days", at(7, 23)),
      ],
      new Map(),
      NOW,
    );
    expect(keysOf(buckets.today)).toEqual(["thread:today-early"]);
    expect(keysOf(buckets.yesterday)).toEqual(["thread:yesterday-late", "thread:yesterday-early"]);
    expect(keysOf(buckets.thisWeek)).toEqual(["thread:six-days"]);
    expect(keysOf(buckets.earlier)).toEqual(["thread:seven-days"]);
  });

  it("puts running threads and active workflows in Running, ahead of their dates", () => {
    const statusById = new Map<ThreadId, ThreadStatus>([
      [ThreadId.makeUnsafe("working"), "working"],
      [ThreadId.makeUnsafe("connecting"), "connecting"],
      [ThreadId.makeUnsafe("waiting"), "awaiting-input"],
    ]);
    const buckets = bucketRecentSidebarItems(
      [
        threadItem("working", at(10, 9)),
        threadItem("connecting", at(0, 8)),
        threadItem("waiting", at(0, 7)),
        workflowItem("running-workflow", at(3, 9), "active"),
        workflowItem("done-workflow", at(0, 6), "completed"),
      ],
      statusById,
      NOW,
    );
    expect(keysOf(buckets.running)).toEqual([
      "thread:connecting",
      "planning:running-workflow",
      "thread:working",
    ]);
    expect(keysOf(buckets.today)).toEqual(["thread:waiting", "planning:done-workflow"]);
  });

  it("lists pinned threads first in pin order, even while running", () => {
    const buckets = bucketRecentSidebarItems(
      [
        threadItem("second", at(0, 9), { pinnedAt: at(5, 9), pinOrderKey: 2 }),
        threadItem("first", at(20, 9), { pinnedAt: at(9, 9), pinOrderKey: 1 }),
        threadItem("plain", at(0, 9)),
      ],
      new Map([[ThreadId.makeUnsafe("second"), "working" as ThreadStatus]]),
      NOW,
    );
    expect(keysOf(buckets.pinned)).toEqual(["thread:first", "thread:second"]);
    expect(keysOf(buckets.running)).toEqual([]);
    expect(keysOf(buckets.today)).toEqual(["thread:plain"]);
  });

  it("places every item in exactly one bucket", () => {
    const items = [
      threadItem("a", at(0, 9), { pinnedAt: at(0, 9), pinOrderKey: 1 }),
      threadItem("b", at(0, 9)),
      threadItem("c", at(2, 9)),
      threadItem("d", "not a date"),
      workflowItem("w", at(1, 9), "active"),
    ];
    const buckets = bucketRecentSidebarItems(
      items,
      new Map([[ThreadId.makeUnsafe("b"), "working" as ThreadStatus]]),
      NOW,
    );
    const placed = Object.values(buckets).flatMap(keysOf);
    expect(placed.toSorted()).toEqual(keysOf(items).toSorted());
    expect(keysOf(buckets.earlier)).toEqual(["thread:d"]);
  });
});
