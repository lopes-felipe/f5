import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadListItem } from "../../types";
import {
  orderThreadsByPipeline,
  prStatusIndicator,
  type ThreadPr,
  workflowPrLabel,
} from "./sidebarLists";

const thread = (id: string, lastInteractionAt: string) =>
  ({
    id: ThreadId.makeUnsafe(id),
    title: id,
    createdAt: lastInteractionAt,
    lastInteractionAt,
    archivedAt: null,
  }) as unknown as ThreadListItem;

describe("prStatusIndicator", () => {
  const pr = (state: "open" | "closed" | "merged"): ThreadPr =>
    ({
      number: 462,
      title: "Sidebar redesign",
      url: "https://github.com/acme/repo/pull/462",
      baseBranch: "main",
      headBranch: "feature",
      state,
    }) as ThreadPr;

  it("carries the PR number with each state", () => {
    expect(prStatusIndicator(pr("open"))).toMatchObject({ label: "PR open", number: 462 });
    expect(prStatusIndicator(pr("merged"))).toMatchObject({ label: "PR merged", number: 462 });
    expect(prStatusIndicator(pr("closed"))).toMatchObject({ label: "PR closed", number: 462 });
    expect(prStatusIndicator(null)).toBeNull();
  });

  it("labels a finished workflow's step line by PR state", () => {
    expect(workflowPrLabel(prStatusIndicator(pr("open"))!)).toBe("PR #462 open");
    expect(workflowPrLabel(prStatusIndicator(pr("merged"))!)).toBe("Merged #462");
    expect(workflowPrLabel(prStatusIndicator(pr("closed"))!)).toBe("PR #462 closed");
  });
});

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
