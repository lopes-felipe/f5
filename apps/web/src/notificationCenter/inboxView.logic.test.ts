import { describe, expect, it } from "vitest";

import type { ThreadStatus } from "../threadStatus";
import type { InboxEntry } from "./inboxStore";
import { buildInboxSections, isNeedsYouEntry } from "./inboxView.logic";

const NOW = new Date(2026, 10, 10, 15, 0, 0);
const TODAY = NOW.getTime() - 60_000;
const YESTERDAY = NOW.getTime() - 24 * 60 * 60 * 1000;

function entry(overrides: Partial<InboxEntry> & { id: string }): InboxEntry {
  return {
    source: "thread",
    severity: "info",
    title: overrides.id,
    target: { kind: "none" },
    count: 1,
    createdAt: TODAY,
    readAt: null,
    ...overrides,
  };
}

function approval(id: string, threadId: string, extra: Partial<InboxEntry> = {}): InboxEntry {
  return entry({
    id,
    severity: "attention",
    threadId,
    threadStatus: "pending-approval",
    approval: { threadId, requestId: `req-${id}`, requestKind: "command" },
    ...extra,
  });
}

function statuses(pairs: Record<string, ThreadStatus>): ReadonlyMap<string, ThreadStatus> {
  return new Map(Object.entries(pairs));
}

describe("isNeedsYouEntry", () => {
  it("keeps an unanswered approval while its thread waits on approval", () => {
    expect(isNeedsYouEntry(approval("a", "t1"), statuses({ t1: "pending-approval" }))).toBe(true);
  });

  it("drops an answered approval", () => {
    const answered = approval("a", "t1", { resolved: { label: "Answered", at: TODAY } });
    expect(isNeedsYouEntry(answered, statuses({ t1: "pending-approval" }))).toBe(false);
  });

  it("drops an approval whose thread moved on", () => {
    expect(isNeedsYouEntry(approval("a", "t1"), statuses({ t1: "working" }))).toBe(false);
    expect(isNeedsYouEntry(approval("a", "t1"), statuses({}))).toBe(false);
  });

  it("keeps an input request while the thread still awaits input", () => {
    const input = entry({ id: "i", threadId: "t2", threadStatus: "awaiting-input" });
    expect(isNeedsYouEntry(input, statuses({ t2: "awaiting-input" }))).toBe(true);
    expect(isNeedsYouEntry(input, statuses({ t2: "completed" }))).toBe(false);
  });

  it("never pins completions, errors or entries without a thread", () => {
    const done = entry({ id: "d", threadId: "t3", threadStatus: "completed" });
    expect(isNeedsYouEntry(done, statuses({ t3: "completed" }))).toBe(false);
    expect(isNeedsYouEntry(entry({ id: "e", source: "errors" }), statuses({}))).toBe(false);
  });
});

describe("buildInboxSections", () => {
  const entries: InboxEntry[] = [
    approval("appr", "t1"),
    entry({ id: "done", threadId: "t2", threadStatus: "completed", readAt: TODAY }),
    entry({ id: "pr", source: "pr", severity: "attention" }),
    entry({ id: "old-err", source: "errors", severity: "error", createdAt: YESTERDAY }),
  ];
  const threadStatusById = statuses({ t1: "pending-approval", t2: "completed" });
  const base = { source: null, threadStatusById, now: NOW } as const;

  it("pins what needs you above the day groups and leaves it out of them", () => {
    const sections = buildInboxSections(entries, { ...base, view: "all" });
    expect(sections.needsYou.map((item) => item.id)).toEqual(["appr"]);
    expect(sections.groups.map((group) => [group.label, group.entries.map((e) => e.id)])).toEqual([
      ["Today", ["done", "pr"]],
      ["Yesterday", ["old-err"]],
    ]);
  });

  it("shows only pinned entries in the Needs you view", () => {
    const sections = buildInboxSections(entries, { ...base, view: "needs-you" });
    expect(sections.needsYou.map((item) => item.id)).toEqual(["appr"]);
    expect(sections.groups).toEqual([]);
  });

  it("shows only unread entries in the Unread view", () => {
    const sections = buildInboxSections(entries, { ...base, view: "unread" });
    expect(sections.needsYou.map((item) => item.id)).toEqual(["appr"]);
    expect(sections.groups.flatMap((group) => group.entries.map((e) => e.id))).toEqual([
      "pr",
      "old-err",
    ]);
  });

  it("applies the source filter before the view and the counts", () => {
    const sections = buildInboxSections(entries, { ...base, source: "pr", view: "unread" });
    expect(sections.needsYou).toEqual([]);
    expect(sections.groups.flatMap((group) => group.entries.map((e) => e.id))).toEqual(["pr"]);
    expect(sections.counts).toEqual({ needsYou: 0, unread: 1 });
  });

  it("counts needs-you and unread entries regardless of the view", () => {
    for (const view of ["all", "needs-you", "unread"] as const) {
      expect(buildInboxSections(entries, { ...base, view }).counts).toEqual({
        needsYou: 1,
        unread: 3,
      });
    }
  });
});
