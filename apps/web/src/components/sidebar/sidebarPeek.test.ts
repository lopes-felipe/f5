import type { MessageId, PendingUserInput, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadStatusPill } from "../../threadStatus";
import type { ChatMessage, Thread } from "../../types";
import {
  contextUsagePercent,
  firstPendingQuestion,
  localThreadPeek,
  resolveSidebarPeekStatus,
  stripMarkdownToPlainText,
} from "./sidebarPeek";

const pill = (label: ThreadStatusPill["label"]) => ({ label }) as ThreadStatusPill;
const NOW = Date.parse("2026-11-03T12:00:00.000Z");

describe("stripMarkdownToPlainText", () => {
  it("keeps the words and drops the markup", () => {
    expect(
      stripMarkdownToPlainText(
        [
          "## Summary",
          "",
          "- **Fixed** the `retry_count` bug in [the loop](https://x.test)",
          "> _quoted_ ~~old~~ text",
          "```ts",
          "const snake_case_name = 1;",
          "```",
          "![diagram](a.png) <br/>",
          "1. done",
        ].join("\n"),
      ),
    ).toBe(
      "Summary Fixed the retry_count bug in the loop quoted old text const snake_case_name = 1; diagram done",
    );
  });
});

describe("firstPendingQuestion", () => {
  it("returns the first non-empty question across pending requests", () => {
    const input = (questions: string[]) =>
      ({ questions: questions.map((question) => ({ question })) }) as unknown as PendingUserInput;
    expect(firstPendingQuestion(undefined)).toBeNull();
    expect(firstPendingQuestion([input([]), input(["Deploy now?", "Later?"])])).toBe("Deploy now?");
  });
});

describe("contextUsagePercent", () => {
  it("needs both counts and clamps to 0-100", () => {
    expect(contextUsagePercent(50_000, 200_000)).toBe(25);
    expect(contextUsagePercent(300_000, 200_000)).toBe(100);
    expect(contextUsagePercent(null, 200_000)).toBeNull();
    expect(contextUsagePercent(10, 0)).toBeNull();
  });
});

describe("resolveSidebarPeekStatus", () => {
  const latestTurn = {
    requestedAt: "2026-11-03T11:50:00.000Z",
    startedAt: "2026-11-03T11:55:00.000Z",
    completedAt: "2026-11-03T11:57:00.000Z",
  };
  const base = { latestTurn, error: null, isUnread: false, now: NOW };

  it("shows how long a turn has been working", () => {
    expect(resolveSidebarPeekStatus({ ...base, pill: pill("Working") })).toEqual({
      label: "Working",
      detail: "for 5m",
    });
  });

  it("shows when a done turn finished and whether it is unread", () => {
    expect(resolveSidebarPeekStatus({ ...base, pill: pill("Completed"), isUnread: true })).toEqual({
      label: "Done",
      detail: "3m ago · unread",
    });
  });

  it("shows the first line of an error", () => {
    const error = "\nRate limited\nstack trace";
    expect(resolveSidebarPeekStatus({ ...base, pill: pill("Failed"), error })).toEqual({
      label: "Failed",
      detail: "Rate limited",
    });
    expect(resolveSidebarPeekStatus({ ...base, pill: null, error })).toEqual({
      label: "Failed",
      detail: "Rate limited",
    });
    expect(resolveSidebarPeekStatus({ ...base, pill: null })).toBeNull();
  });
});

describe("localThreadPeek", () => {
  const message = (
    id: string,
    role: ChatMessage["role"],
    text: string,
    turnId: string,
    streaming = false,
  ): ChatMessage => ({
    id: id as MessageId,
    role,
    text,
    turnId: turnId as TurnId,
    createdAt: "2026-11-03T11:00:00.000Z",
    streaming,
  });
  const thread = (overrides: Partial<Thread>) =>
    ({
      id: "thread" as ThreadId,
      detailsLoaded: true,
      messages: [],
      latestTurn: null,
      turnDiffSummaries: [],
      ...overrides,
    }) as Thread;

  it("skips threads whose details are not loaded", () => {
    expect(localThreadPeek(thread({ detailsLoaded: false }))).toBeNull();
  });

  it("uses the last prompt, the newest settled reply outside a running turn, and the latest diff", () => {
    const peek = localThreadPeek(
      thread({
        latestTurn: { turnId: "t2", state: "running" } as Thread["latestTurn"],
        messages: [
          message("u1", "user", "First", "t1"),
          message("a1", "assistant", "Settled reply", "t1"),
          message("u2", "user", "Second", "t2"),
          message("a2", "assistant", "Commentary in the running turn", "t2"),
          message("a3", "assistant", "Streaming", "t2", true),
        ],
        turnDiffSummaries: [
          { turnId: "t0" as TurnId, completedAt: "", files: [{ path: "old.ts", additions: 9 }] },
          {
            turnId: "t1" as TurnId,
            completedAt: "",
            files: [
              { path: "a.ts", additions: 4, deletions: 1 },
              { path: "b.ts", additions: 2 },
            ],
          },
        ],
      }),
    );
    expect(peek).toEqual({
      threadId: "thread",
      lastUserText: "Second",
      lastAssistantText: "Settled reply",
      latestTurnDiff: { files: 2, additions: 6, deletions: 1 },
    });
  });
});
