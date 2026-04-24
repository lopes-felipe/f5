import { CodeReviewWorkflowId, PlanningWorkflowId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import {
  codeReviewWorkflowTabTargetKey,
  planningWorkflowTabTargetKey,
  settingsTabTargetKey,
  threadTabTargetKey,
  type TabTargetKey,
} from "./tabTargets";
import {
  advanceCycle,
  beginCycle,
  endCycle,
  getCycleTargetKey,
  pruneRecentTabTargets,
  recordTabTargetVisit,
  type ThreadRecencyState,
} from "./threadRecency";

const ctrlTabShortcut = {
  key: "tab",
  metaKey: false,
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  modKey: false,
} as const;

const plainTabShortcut = {
  key: "tab",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: false,
} as const;

function threadKey(value: string): TabTargetKey {
  return threadTabTargetKey(ThreadId.makeUnsafe(value));
}

function planningKey(value: string): TabTargetKey {
  return planningWorkflowTabTargetKey(PlanningWorkflowId.makeUnsafe(value));
}

function codeReviewKey(value: string): TabTargetKey {
  return codeReviewWorkflowTabTargetKey(CodeReviewWorkflowId.makeUnsafe(value));
}

function state(recentTargetKeys: TabTargetKey[]): ThreadRecencyState {
  return {
    recentTargetKeys,
    activeCycle: null,
  };
}

describe("recordTabTargetVisit", () => {
  it("keeps unique most-recent-first ordering", () => {
    const initial = state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]);
    const next = recordTabTargetVisit(initial, settingsTabTargetKey());

    assert.deepEqual(next.recentTargetKeys, [
      settingsTabTargetKey(),
      threadKey("thread-a"),
      planningKey("wf-1"),
    ]);
  });

  it("deduplicates settings visits across category changes", () => {
    const initial = state([threadKey("thread-a"), settingsTabTargetKey()]);
    const next = recordTabTargetVisit(initial, settingsTabTargetKey());

    assert.deepEqual(next.recentTargetKeys, [settingsTabTargetKey(), threadKey("thread-a")]);
  });
});

describe("pruneRecentTabTargets", () => {
  it("drops ineligible target keys from recent order", () => {
    const next = pruneRecentTabTargets(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      [threadKey("thread-a"), settingsTabTargetKey()],
      threadKey("thread-a"),
    );

    assert.deepEqual(next.recentTargetKeys, [threadKey("thread-a"), settingsTabTargetKey()]);
  });

  it("prunes active cycle order and resets the index to the active highlighted target", () => {
    const initial: ThreadRecencyState = {
      recentTargetKeys: [threadKey("thread-a"), planningKey("wf-1"), codeReviewKey("review-1")],
      activeCycle: {
        order: [threadKey("thread-a"), planningKey("wf-1"), codeReviewKey("review-1")],
        index: 2,
        heldModifiers: {
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    };

    const next = pruneRecentTabTargets(
      initial,
      [threadKey("thread-a"), codeReviewKey("review-1")],
      codeReviewKey("review-1"),
    );

    assert.deepEqual(next.activeCycle, {
      order: [threadKey("thread-a"), codeReviewKey("review-1")],
      index: 1,
      heldModifiers: {
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
    });
  });

  it("terminates the cycle when the active target is no longer eligible", () => {
    const initial: ThreadRecencyState = {
      recentTargetKeys: [threadKey("thread-a"), planningKey("wf-1")],
      activeCycle: {
        order: [threadKey("thread-a"), planningKey("wf-1")],
        index: 1,
        heldModifiers: {
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    };

    const next = pruneRecentTabTargets(
      initial,
      [threadKey("thread-a"), settingsTabTargetKey()],
      planningKey("wf-1"),
    );

    assert.isNull(next.activeCycle);
  });
});

describe("cycle flow", () => {
  it("starts forward cycling from the second MRU target", () => {
    const result = beginCycle(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      {
        direction: "next",
        activeTargetKey: threadKey("thread-a"),
        eligibleTargetKeys: [threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")],
        shortcut: ctrlTabShortcut,
        platform: "Linux",
      },
    );

    assert.strictEqual(result.targetKey, settingsTabTargetKey());
    assert.deepEqual(result.state.activeCycle?.order, [
      threadKey("thread-a"),
      settingsTabTargetKey(),
      planningKey("wf-1"),
    ]);
    assert.strictEqual(result.state.activeCycle?.index, 1);
  });

  it("advances forward through the frozen order and wraps", () => {
    const started = beginCycle(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      {
        direction: "next",
        activeTargetKey: threadKey("thread-a"),
        eligibleTargetKeys: [threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")],
        shortcut: ctrlTabShortcut,
        platform: "Linux",
      },
    );
    const second = advanceCycle(started.state, "next");
    const third = advanceCycle(second.state, "next");

    assert.strictEqual(started.targetKey, settingsTabTargetKey());
    assert.strictEqual(second.targetKey, planningKey("wf-1"));
    assert.strictEqual(third.targetKey, threadKey("thread-a"));
  });

  it("moves backward through the same frozen order", () => {
    const started = beginCycle(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      {
        direction: "next",
        activeTargetKey: threadKey("thread-a"),
        eligibleTargetKeys: [threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")],
        shortcut: ctrlTabShortcut,
        platform: "Linux",
      },
    );

    const previous = advanceCycle(started.state, "previous");
    assert.strictEqual(previous.targetKey, threadKey("thread-a"));
  });

  it("commits the final target when ending a cycle", () => {
    const started = beginCycle(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      {
        direction: "next",
        activeTargetKey: threadKey("thread-a"),
        eligibleTargetKeys: [threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")],
        shortcut: ctrlTabShortcut,
        platform: "Linux",
      },
    );

    const ended = endCycle(started.state, settingsTabTargetKey());

    assert.deepEqual(ended.state.recentTargetKeys, [
      settingsTabTargetKey(),
      threadKey("thread-a"),
      planningKey("wf-1"),
    ]);
    assert.isNull(ended.state.activeCycle);
    assert.strictEqual(ended.commitTargetKey, settingsTabTargetKey());
  });

  it("returns the highlighted target during an active cycle", () => {
    const started = beginCycle(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      {
        direction: "next",
        activeTargetKey: threadKey("thread-a"),
        eligibleTargetKeys: [threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")],
        shortcut: ctrlTabShortcut,
        platform: "Linux",
      },
    );

    assert.strictEqual(getCycleTargetKey(started.state), settingsTabTargetKey());
  });

  it("returns null when no cycle is active", () => {
    assert.isNull(getCycleTargetKey(state([threadKey("thread-a"), settingsTabTargetKey()])));
  });

  it("uses the first MRU target when cycling from a non-switchable route", () => {
    const result = beginCycle(state([settingsTabTargetKey(), threadKey("thread-b")]), {
      direction: "previous",
      activeTargetKey: null,
      eligibleTargetKeys: [settingsTabTargetKey(), threadKey("thread-b")],
      shortcut: ctrlTabShortcut,
      platform: "Linux",
    });

    assert.strictEqual(result.targetKey, settingsTabTargetKey());
    assert.strictEqual(result.state.activeCycle?.index, 0);
  });

  it("keeps the active cycle snapshot frozen across unrelated recent ordering", () => {
    const started = beginCycle(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      {
        direction: "next",
        activeTargetKey: threadKey("thread-a"),
        eligibleTargetKeys: [threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")],
        shortcut: ctrlTabShortcut,
        platform: "Linux",
      },
    );

    const visited = recordTabTargetVisit(started.state, planningKey("wf-1"));
    assert.deepEqual(visited.activeCycle?.order, [
      threadKey("thread-a"),
      settingsTabTargetKey(),
      planningKey("wf-1"),
    ]);
  });

  it("treats no-modifier shortcuts as single-step switches", () => {
    const result = beginCycle(
      state([threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")]),
      {
        direction: "next",
        activeTargetKey: threadKey("thread-a"),
        eligibleTargetKeys: [threadKey("thread-a"), settingsTabTargetKey(), planningKey("wf-1")],
        shortcut: plainTabShortcut,
        platform: "Linux",
      },
    );

    assert.strictEqual(result.targetKey, settingsTabTargetKey());
    assert.strictEqual(result.commitTargetKey, settingsTabTargetKey());
    assert.isNull(result.state.activeCycle);
    assert.deepEqual(result.state.recentTargetKeys, [
      settingsTabTargetKey(),
      threadKey("thread-a"),
      planningKey("wf-1"),
    ]);
  });
});
