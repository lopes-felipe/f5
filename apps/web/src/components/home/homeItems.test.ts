import type { OrchestrationThreadPeek } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../types";
import {
  deriveHomeThreadDecision,
  firstErrorLine,
  formatPeekDiff,
  homeRowSummary,
  homeSettleBlocker,
  pendingUserInputsOf,
  runningTurnElapsed,
} from "./homeItems";
import { homeComposerDraft } from "./homeComposerDraft";
import {
  appendQuickStartText,
  quickStartEnterAction,
  quickStartNeedsFullComposer,
} from "./HomeQuickStart";
import { nextScheduledRunAt } from "./HomeStatusStrip";
import { mergeHomeThreadTail, tailFromMessages } from "./useHomeThreadTail";

const NOW = Date.parse("2026-03-09T12:00:00.000Z");

type RowThread = Parameters<typeof homeRowSummary>[0]["thread"];

function rowThread(overrides: Partial<RowThread> = {}): RowThread {
  return {
    activities: [],
    proposedPlans: [],
    latestTurn: null,
    error: null,
    lastInteractionAt: "2026-03-09T11:59:00.000Z",
    ...overrides,
  };
}

function approvalActivity(requestId: string, detail?: string): Thread["activities"][number] {
  return {
    id: `activity-${requestId}` as never,
    tone: "approval",
    kind: "approval.requested",
    summary: "Needs approval",
    payload: { requestId, requestKind: "command", ...(detail ? { detail } : {}) },
    turnId: null,
    createdAt: "2026-03-09T11:59:00.000Z",
  };
}

function questionActivity(requestId: string, question: string): Thread["activities"][number] {
  return {
    id: `activity-${requestId}` as never,
    tone: "info",
    kind: "user-input.requested",
    summary: "Asks a question",
    payload: {
      requestId,
      questions: [
        {
          id: "q1",
          header: "Scope",
          question,
          options: [{ label: "Yes", description: "Go ahead" }],
        },
      ],
    },
    turnId: null,
    createdAt: "2026-03-09T11:59:00.000Z",
  };
}

function peek(overrides: Partial<OrchestrationThreadPeek> = {}): OrchestrationThreadPeek {
  return {
    threadId: "thread-1" as never,
    lastUserText: null,
    lastAssistantText: null,
    latestTurnDiff: null,
    ...overrides,
  };
}

describe("appendQuickStartText", () => {
  it("uses the text as-is for an empty draft", () => {
    expect(appendQuickStartText("", "Fix the bug")).toBe("Fix the bug");
    expect(appendQuickStartText("  \n", "Fix the bug")).toBe("Fix the bug");
  });

  it("appends on a new line and keeps the existing prefix intact", () => {
    expect(appendQuickStartText("@src/app.ts ", "add tests")).toBe("@src/app.ts \nadd tests");
    expect(appendQuickStartText("first line\n", "second")).toBe("first line\nsecond");
  });
});

describe("quickStartNeedsFullComposer", () => {
  it("hands commands and skills to the thread composer", () => {
    expect(quickStartNeedsFullComposer("/review")).toBe(true);
    expect(quickStartNeedsFullComposer("  /plan the migration")).toBe(true);
    expect(quickStartNeedsFullComposer("$deploy staging")).toBe(true);
  });

  it("sends ordinary text, including a leading path", () => {
    expect(quickStartNeedsFullComposer("Fix the login bug")).toBe(false);
    expect(quickStartNeedsFullComposer("/Users/me/app.ts crashes on start")).toBe(false);
    expect(quickStartNeedsFullComposer("$ npm test fails")).toBe(false);
    expect(quickStartNeedsFullComposer("Use src/app.ts and /tmp")).toBe(false);
  });
});

describe("quickStartEnterAction", () => {
  const press = (
    shortcut: Parameters<typeof quickStartEnterAction>[0]["shortcut"],
    keys: { shiftKey?: boolean; altKey?: boolean; modifierKey?: boolean } = {},
    text = "Fix the login bug",
  ) =>
    quickStartEnterAction({
      shortcut,
      text,
      shiftKey: false,
      altKey: false,
      modifierKey: false,
      ...keys,
    });

  it("sends on Enter and opens on the modifier with the plain Enter setting", () => {
    expect(press("enter")).toBe("send");
    expect(press("enter", { modifierKey: true })).toBe("send-and-open");
    expect(press("enter", { shiftKey: true })).toBe("newline");
    expect(press("enter", { altKey: true })).toBe("newline");
    expect(press("enter", { modifierKey: true, shiftKey: true })).toBe("newline");
  });

  it("never sends on a plain Enter when the setting asks for the modifier", () => {
    expect(press("mod-enter")).toBe("newline");
    // The modifier is the send key here, so it sends and stays.
    expect(press("mod-enter", { modifierKey: true })).toBe("send");
    expect(press("mod-enter", { modifierKey: true, shiftKey: true })).toBe("newline");
  });

  it("asks for the modifier only once the text has several lines", () => {
    expect(press("mod-enter-multiline")).toBe("send");
    expect(press("mod-enter-multiline", {}, "Fix the bug\nand add a test")).toBe("newline");
    expect(press("mod-enter-multiline", { modifierKey: true }, "Fix the bug\nand a test")).toBe(
      "send",
    );
  });
});

describe("homeComposerDraft.clearSentText", () => {
  it("clears the box only while it still holds what was sent", () => {
    homeComposerDraft.setText("Fix the login bug");
    homeComposerDraft.clearSentText("Fix the login bug");
    expect(homeComposerDraft.text()).toBe("");

    // A late answer for an earlier send leaves text typed since alone.
    homeComposerDraft.setText("A newer task");
    homeComposerDraft.clearSentText("Fix the login bug");
    expect(homeComposerDraft.text()).toBe("A newer task");
    homeComposerDraft.resetForTests();
  });
});

describe("homeRowSummary", () => {
  it("shows what an approval covers and how many more wait behind it", () => {
    const one = rowThread({ activities: [approvalActivity("r1", "rm -rf build")] });
    expect(homeRowSummary({ kind: "approval", thread: one, peek: undefined, now: NOW })).toBe(
      "rm -rf build",
    );
    const two = rowThread({
      activities: [approvalActivity("r1", "rm -rf build"), approvalActivity("r2", "git push")],
    });
    expect(homeRowSummary({ kind: "approval", thread: two, peek: undefined, now: NOW })).toBe(
      "rm -rf build (+1 more)",
    );
  });

  it("falls back to the request kind when an approval carries no detail", () => {
    const thread = rowThread({ activities: [approvalActivity("r1")] });
    expect(homeRowSummary({ kind: "approval", thread, peek: undefined, now: NOW })).toBe(
      "Agent wants to run",
    );
  });

  it("leads a failure with the first line of its error", () => {
    const thread = rowThread({ error: "\nUsage limit reached\nTry again later" });
    expect(
      homeRowSummary({
        kind: "failed",
        thread,
        peek: peek({ lastAssistantText: "Working on it" }),
        now: NOW,
      }),
    ).toBe("Usage limit reached");
    expect(homeRowSummary({ kind: "failed", thread: rowThread(), peek: undefined, now: NOW })).toBe(
      "The last turn failed",
    );
  });

  it("describes finished work by its reply and diff", () => {
    const thread = rowThread();
    expect(
      homeRowSummary({
        kind: "completed",
        thread,
        peek: peek({
          lastAssistantText: "**Done.** Split the store.",
          latestTurnDiff: { files: 1, additions: 4, deletions: 0 },
        }),
        now: NOW,
      }),
    ).toBe("Done. Split the store. · 1 file +4 −0");
    // Nothing to add until the peek arrives.
    expect(homeRowSummary({ kind: "completed", thread, peek: undefined, now: NOW })).toBeNull();
  });

  it("describes running work by its prompt and how long it has run", () => {
    const thread = rowThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        requestedAt: "2026-03-09T11:45:10.000Z",
        startedAt: "2026-03-09T11:45:30.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    expect(
      homeRowSummary({
        kind: "running",
        thread,
        peek: peek({ lastUserText: "Refactor the queue" }),
        now: NOW,
      }),
    ).toBe("Refactor the queue · for 14m");
  });
});

describe("deriveHomeThreadDecision", () => {
  it("lists open approvals oldest first and no plan without one", () => {
    const decision = deriveHomeThreadDecision(
      rowThread({ activities: [approvalActivity("r1"), approvalActivity("r2")] }),
    );
    expect(decision.approvals.map((approval) => approval.requestId)).toEqual(["r1", "r2"]);
    expect(decision.userInputs).toEqual([]);
    expect(decision.plan).toBeNull();
  });
});

describe("pendingUserInputsOf", () => {
  const activities = [questionActivity("from-activities", "Ship it?")];
  const projected = {
    requestId: "from-projection" as never,
    turnId: null,
    createdAt: "2026-03-09T11:58:00.000Z",
    questions: [],
  };

  it("reads the server's projection when it lists a question", () => {
    const inputs = pendingUserInputsOf({ activities, pendingUserInputs: [projected] });
    expect(inputs.map((input) => input.requestId)).toEqual(["from-projection"]);
  });

  it("falls back to the activities, which put the thread in the queue, when the projection is empty", () => {
    for (const pendingUserInputs of [[], undefined]) {
      const inputs = pendingUserInputsOf({ activities, pendingUserInputs });
      expect(inputs.map((input) => input.requestId)).toEqual(["from-activities"]);
    }
    // The row and the preview read the same question.
    const thread = rowThread({ activities, pendingUserInputs: [] });
    expect(homeRowSummary({ kind: "question", thread, peek: undefined, now: NOW })).toBe(
      "Ship it?",
    );
    expect(deriveHomeThreadDecision(thread).userInputs).toHaveLength(1);
  });
});

describe("homeSettleBlocker", () => {
  it("blocks what the server refuses to settle", () => {
    for (const kind of ["running", "question", "approval"] as const) {
      expect(homeSettleBlocker({ kind, pinned: false })).toEqual(expect.any(String));
    }
    expect(homeSettleBlocker({ kind: "completed", pinned: true })).toBe(
      "Unpin the thread to settle it",
    );
  });

  it("lets the rest through", () => {
    for (const kind of ["plan", "queue-paused", "failed", "completed", "pinned"] as const) {
      expect(homeSettleBlocker({ kind, pinned: false })).toBeNull();
    }
  });
});

describe("thread tail", () => {
  const message = (role: string, text: string, turnId: string | null, streaming = false) => ({
    role,
    text,
    turnId,
    streaming,
  });

  it("reads the last prompt and the newest settled reply outside a running turn", () => {
    const messages = [
      message("user", "First", "t1"),
      message("assistant", "First reply", "t1"),
      message("user", "Second", "t2"),
      message("assistant", "Commentary", "t2"),
      message("assistant", "Streaming", "t2", true),
      message("user", "   ", "t2"),
    ];
    expect(tailFromMessages(messages, { turnId: "t2" as never, state: "running" })).toEqual({
      lastPrompt: "Second",
      lastReply: "First reply",
    });
    expect(tailFromMessages(messages, { turnId: "t2" as never, state: "completed" })).toEqual({
      lastPrompt: "Second",
      lastReply: "Commentary",
    });
    expect(tailFromMessages([], null)).toEqual({ lastPrompt: null, lastReply: null });
  });

  it("keeps the loaded half while the server's tail is missing or shorter", () => {
    const local = { lastPrompt: null, lastReply: "Loaded reply" };
    // Still loading, or the read failed.
    expect(mergeHomeThreadTail(local, null)).toEqual(local);
    expect(mergeHomeThreadTail(local, { lastPrompt: "Server prompt", lastReply: null })).toEqual({
      lastPrompt: "Server prompt",
      lastReply: "Loaded reply",
    });
    expect(
      mergeHomeThreadTail(local, { lastPrompt: "Server prompt", lastReply: "Server reply" }),
    ).toEqual({ lastPrompt: "Server prompt", lastReply: "Server reply" });
    expect(mergeHomeThreadTail(null, null)).toEqual({ lastPrompt: null, lastReply: null });
  });
});

describe("row helpers", () => {
  it("reads the first non-empty error line", () => {
    expect(firstErrorLine("  \n  boom  \nmore")).toBe("boom");
    expect(firstErrorLine("")).toBeNull();
    expect(firstErrorLine(null)).toBeNull();
  });

  it("formats diff totals", () => {
    expect(formatPeekDiff({ files: 3, additions: 12, deletions: 4 })).toBe("3 files +12 −4");
    expect(formatPeekDiff(null)).toBeNull();
  });

  it("measures a running turn from its start, else its request", () => {
    const turn = { startedAt: null, requestedAt: "2026-03-09T11:59:30.000Z" };
    expect(runningTurnElapsed(turn, NOW)).toBe("30s");
    expect(runningTurnElapsed(null, NOW)).toBeNull();
  });
});

describe("nextScheduledRunAt", () => {
  type Tasks = NonNullable<Parameters<typeof nextScheduledRunAt>[0]>;
  const task = (nextRunAt: string | null, overrides: object = {}) =>
    ({ task: { enabled: true, disabledReason: null, nextRunAt, ...overrides } }) as never;

  it("picks the soonest upcoming run among tasks that can run", () => {
    const tasks: Tasks = [
      task("2026-03-09T18:00:00.000Z"),
      task("2026-03-09T13:00:00.000Z"),
      task("2026-03-09T12:30:00.000Z", { enabled: false }),
      task("2026-03-09T12:15:00.000Z", { disabledReason: "project-missing" }),
      // Due already: the scheduler is about to run it, so it is not "next".
      task("2026-03-09T11:00:00.000Z"),
      task(null),
    ];
    expect(nextScheduledRunAt(tasks, NOW)).toBe("2026-03-09T13:00:00.000Z");
  });

  it("is null with nothing scheduled", () => {
    expect(nextScheduledRunAt(undefined, NOW)).toBeNull();
    expect(nextScheduledRunAt([task(null)], NOW)).toBeNull();
  });
});
