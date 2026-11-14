import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadStatus } from "../threadStatus";
import {
  buildHomeQueue,
  type HomeQueueThread,
  type HomeQueueWorkflow,
  resolveHomeSelection,
  stepHomeSelection,
} from "./homeQueue";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

/** `minutesAgo` orders threads by recency: a smaller number is more recent. */
function thread(id: string, status: ThreadStatus, minutesAgo: number): HomeQueueThread {
  const at = new Date(Date.UTC(2026, 10, 14, 12, 0) - minutesAgo * 60_000).toISOString();
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    createdAt: at,
    lastInteractionAt: at,
    archivedAt: null,
    status,
  };
}

function minutesAgoIso(minutesAgo: number): string {
  return new Date(Date.UTC(2026, 10, 14, 12, 0) - minutesAgo * 60_000).toISOString();
}

/** A working thread whose turn was requested `startedMinutesAgo` and last produced output `activeMinutesAgo`. */
function running(id: string, startedMinutesAgo: number, activeMinutesAgo: number): HomeQueueThread {
  return {
    ...thread(id, "working", activeMinutesAgo),
    latestTurn: { requestedAt: minutesAgoIso(startedMinutesAgo) },
  };
}

function workflow(
  key: string,
  active: boolean,
  startedMinutesAgo: number,
  activeMinutesAgo = startedMinutesAgo,
): HomeQueueWorkflow {
  return {
    key,
    active,
    startedAt: minutesAgoIso(startedMinutesAgo),
    activityAt: minutesAgoIso(activeMinutesAgo),
  };
}

function build(input: {
  threads?: HomeQueueThread[];
  workflowThreads?: HomeQueueThread[];
  paused?: string[];
  pinned?: string[];
  workflows?: HomeQueueWorkflow[];
}) {
  const threads = (input.threads ?? []).toSorted((left, right) =>
    right.lastInteractionAt.localeCompare(left.lastInteractionAt),
  );
  return buildHomeQueue({
    threads,
    workflowThreads: input.workflowThreads ?? [],
    pausedQueueThreadIds: new Set((input.paused ?? []).map((id) => ThreadId.makeUnsafe(id))),
    pinnedThreadIds: (input.pinned ?? []).map((id) => ThreadId.makeUnsafe(id)),
    workflows: input.workflows ?? [],
  });
}

function summary(queue: ReturnType<typeof build>) {
  return queue.groups.map((group) => [
    group.id,
    group.items.map((item) =>
      item.type === "thread" ? `${item.thread.id}:${item.kind}` : item.id,
    ),
  ]);
}

describe("buildHomeQueue", () => {
  it("orders decisions by urgency, then recency", () => {
    const queue = build({
      threads: [
        thread("plan", "plan-ready", 1),
        thread("question", "awaiting-input", 2),
        thread("approval-old", "pending-approval", 9),
        thread("approval-new", "pending-approval", 3),
        thread("paused", "none", 0),
      ],
      paused: ["paused"],
    });
    expect(summary(queue)).toEqual([
      [
        "decision",
        [
          "approval-new:approval",
          "approval-old:approval",
          "question:question",
          "plan:plan",
          "paused:queue-paused",
        ],
      ],
    ]);
  });

  it("puts unseen failures and unread completions in review, failures first", () => {
    const queue = build({
      threads: [
        thread("done-new", "completed", 1),
        thread("failed", "failed", 5),
        thread("done-old", "completed", 8),
        thread("idle", "none", 0),
      ],
    });
    expect(summary(queue)).toEqual([
      ["review", ["failed:failed", "done-new:completed", "done-old:completed"]],
    ]);
  });

  it("lists working threads and active workflows together, most recently started first", () => {
    const queue = build({
      threads: [thread("working", "working", 4), thread("connecting", "connecting", 1)],
      workflows: [workflow("planning:w1", true, 2), workflow("planning:idle", false, 0)],
    });
    expect(summary(queue)).toEqual([
      ["running", ["connecting:running", "workflow:planning:w1", "working:running"]],
    ]);
  });

  it("keeps running rows in place while their output streams", () => {
    const order = (activity: { first: number; second: number; flow: number }) =>
      summary(
        build({
          threads: [running("first", 9, activity.first), running("second", 5, activity.second)],
          workflows: [workflow("planning:w1", true, 7, activity.flow)],
        }),
      );
    const expected = [["running", ["second:running", "workflow:planning:w1", "first:running"]]];
    expect(order({ first: 3, second: 2, flow: 1 })).toEqual(expected);
    // The oldest turn streams last: activity order would move it to the top.
    expect(order({ first: 0, second: 2, flow: 1 })).toEqual(expected);
  });

  it("surfaces a workflow thread only while it is blocked on the user", () => {
    const queue = build({
      workflowThreads: [
        thread("step-approval", "pending-approval", 1),
        thread("step-plan", "plan-ready", 2),
        thread("step-paused-plan", "plan-ready", 3),
        thread("step-working", "working", 4),
        thread("step-done", "completed", 5),
      ],
      paused: ["step-paused-plan"],
    });
    // A workflow consumes its own plans: the paused step is there for its queue.
    expect(summary(queue)).toEqual([
      ["decision", ["step-approval:approval", "step-paused-plan:queue-paused"]],
    ]);
  });

  it("lists a pinned thread once, in pin order, and never a settled or missing one", () => {
    const queue = build({
      threads: [
        thread("pinned-approval", "pending-approval", 1),
        thread("pinned-idle-b", "none", 2),
        thread("pinned-idle-a", "none", 3),
        thread("pinned-working", "working", 4),
      ],
      // A settled thread is not in the visible list its caller passes.
      pinned: [
        "pinned-idle-a",
        "pinned-settled",
        "pinned-approval",
        "pinned-idle-b",
        "pinned-working",
      ],
    });
    expect(summary(queue)).toEqual([
      ["decision", ["pinned-approval:approval"]],
      ["running", ["pinned-working:running"]],
      ["pinned", ["pinned-idle-a:pinned", "pinned-idle-b:pinned"]],
    ]);
    expect(queue.items.map((item) => item.id)).toEqual([
      "thread:pinned-approval",
      "thread:pinned-working",
      "thread:pinned-idle-a",
      "thread:pinned-idle-b",
    ]);
  });

  it("has no groups for an empty queue", () => {
    expect(build({ threads: [thread("idle", "none", 0)] })).toEqual({ groups: [], items: [] });
  });
});

describe("resolveHomeSelection", () => {
  const previous = ["a", "b", "c", "d"];

  it("starts at the top and keeps a listed selection", () => {
    expect(resolveHomeSelection([], previous, null)).toBe("a");
    expect(resolveHomeSelection(previous, ["d", "c", "b"], "c")).toBe("c");
    expect(resolveHomeSelection(previous, [], "c")).toBeNull();
  });

  it("moves to the item that followed a departed one, else the one before", () => {
    expect(resolveHomeSelection(previous, ["a", "c", "d"], "b")).toBe("c");
    expect(resolveHomeSelection(previous, ["a", "d"], "b")).toBe("d");
    expect(resolveHomeSelection(previous, ["a", "b", "c"], "d")).toBe("c");
    expect(resolveHomeSelection(previous, ["x", "y"], "b")).toBe("x");
    expect(resolveHomeSelection(previous, ["x", "y"], "unknown")).toBe("x");
  });
});

describe("stepHomeSelection", () => {
  it("moves within the list and stops at its ends", () => {
    const ids = ["a", "b", "c"];
    expect(stepHomeSelection(ids, "a", 1)).toBe("b");
    expect(stepHomeSelection(ids, "c", 1)).toBe("c");
    expect(stepHomeSelection(ids, "a", -1)).toBe("a");
    expect(stepHomeSelection(ids, null, 1)).toBe("a");
    expect(stepHomeSelection(ids, null, -1)).toBe("c");
    expect(stepHomeSelection([], "a", 1)).toBeNull();
  });
});
