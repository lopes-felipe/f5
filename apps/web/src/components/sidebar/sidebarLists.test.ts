import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadListItem } from "../../types";
import { orderThreadsByPipeline } from "./sidebarLists";

const thread = (id: string, lastInteractionAt: string) =>
  ({
    id: ThreadId.makeUnsafe(id),
    title: id,
    createdAt: lastInteractionAt,
    lastInteractionAt,
    archivedAt: null,
  }) as unknown as ThreadListItem;

describe("orderThreadsByPipeline", () => {
  it("orders a workflow's threads by pipeline, then unmatched ones by activity", () => {
    const threads = [
      thread("implementation", "2026-11-03T12:00:00.000Z"),
      thread("review-b", "2026-10-22T12:00:00.000Z"),
      thread("stray-old", "2026-10-01T12:00:00.000Z"),
      thread("branch-a", "2026-10-20T12:00:00.000Z"),
      thread("stray-new", "2026-11-02T12:00:00.000Z"),
      thread("branch-b", "2026-10-21T12:00:00.000Z"),
    ];
    const order = ["branch-a", "branch-b", "review-b", "implementation", "not-loaded"].map((id) =>
      ThreadId.makeUnsafe(id),
    );
    expect(orderThreadsByPipeline(order, threads).map((entry) => entry.id)).toEqual([
      "branch-a",
      "branch-b",
      "review-b",
      "implementation",
      "stray-new",
      "stray-old",
    ]);
  });
});
