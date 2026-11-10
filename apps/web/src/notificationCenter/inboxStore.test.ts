import { describe, expect, it } from "vitest";

import {
  groupInboxEntries,
  INBOX_MAX_AGE_MS,
  INBOX_MAX_ENTRIES,
  pruneInboxEntries,
  recordInboxEntry,
  unreadInboxCount,
  useNotificationInbox,
  type InboxRecordInput,
} from "./inboxStore";
import { doNotDisturbUntilFor } from "./preferences";

const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();

function input(overrides: Partial<InboxRecordInput> = {}): InboxRecordInput {
  return {
    id: `n-${Math.random()}`,
    source: "errors",
    severity: "error",
    title: "Could not push",
    target: { kind: "none" },
    createdAt: NOW,
    ...overrides,
  };
}

describe("recordInboxEntry", () => {
  it("bumps an unread repeat instead of adding a row", () => {
    const first = recordInboxEntry([], input({ id: "a", dedupeKey: "k" }), NOW);
    const second = recordInboxEntry(
      first,
      input({ id: "b", dedupeKey: "k", createdAt: NOW + 5 }),
      NOW,
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ id: "a", count: 2, createdAt: NOW + 5, readAt: null });
  });

  it("adds a new row once the earlier one was read", () => {
    const first = recordInboxEntry([], input({ id: "a", dedupeKey: "k" }), NOW);
    const read = first.map((entry) => ({ ...entry, readAt: NOW }));
    expect(recordInboxEntry(read, input({ id: "b", dedupeKey: "k" }), NOW)).toHaveLength(2);
  });

  it("keeps the newest entries and drops old ones", () => {
    let entries = recordInboxEntry(
      [],
      input({ id: "old", createdAt: NOW - INBOX_MAX_AGE_MS - 1 }),
      NOW,
    );
    expect(entries).toHaveLength(0);
    for (let index = 0; index < INBOX_MAX_ENTRIES + 5; index += 1)
      entries = recordInboxEntry(entries, input({ id: `n${index}` }), NOW);
    expect(entries).toHaveLength(INBOX_MAX_ENTRIES);
    expect(entries[0]!.id).toBe(`n${INBOX_MAX_ENTRIES + 4}`);
    expect(pruneInboxEntries(entries, NOW + INBOX_MAX_AGE_MS + 1)).toHaveLength(0);
  });
});

describe("inbox store", () => {
  it("reads, resolves and removes entries", () => {
    const store = useNotificationInbox.getState();
    store.clear();
    store.record(
      input({
        id: "approval",
        source: "thread",
        severity: "attention",
        threadId: "t1",
        approval: { threadId: "t1", requestId: "r1", requestKind: "command" },
      }),
    );
    store.record(input({ id: "error" }));
    expect(unreadInboxCount(useNotificationInbox.getState().entries)).toBe(2);
    store.markThreadRead("t1");
    expect(unreadInboxCount(useNotificationInbox.getState().entries)).toBe(1);
    store.resolveApproval("r1", "Approved");
    expect(
      useNotificationInbox.getState().entries.find((e) => e.id === "approval")?.resolved?.label,
    ).toBe("Approved");
    store.markAllRead();
    expect(unreadInboxCount(useNotificationInbox.getState().entries)).toBe(0);
    store.remove("error");
    expect(useNotificationInbox.getState().entries.map((e) => e.id)).toEqual(["approval"]);
    store.clear();
  });

  it("resolves a thread's approvals when it stops waiting", () => {
    const store = useNotificationInbox.getState();
    store.clear();
    store.record(
      input({ id: "a", approval: { threadId: "t2", requestId: "r2", requestKind: "command" } }),
    );
    store.resolveThreadApprovals("t2", "Answered");
    expect(useNotificationInbox.getState().entries[0]?.resolved?.label).toBe("Answered");
    store.clear();
  });
});

describe("groupInboxEntries", () => {
  it("groups by local day", () => {
    const now = new Date(NOW);
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const groups = groupInboxEntries(
      [
        { ...input({ id: "t" }), count: 1, readAt: null },
        { ...input({ id: "y", createdAt: yesterday.getTime() }), count: 1, readAt: null },
        { ...input({ id: "e", createdAt: NOW - 3 * 86_400_000 }), count: 1, readAt: null },
      ],
      now,
    );
    expect(groups.map((group) => [group.label, group.entries.map((e) => e.id)])).toEqual([
      ["Today", ["t"]],
      ["Yesterday", ["y"]],
      ["Earlier", ["e"]],
    ]);
  });
});

describe("doNotDisturbUntilFor", () => {
  it("computes snooze ends in local time", () => {
    const now = new Date(NOW);
    expect(Date.parse(doNotDisturbUntilFor("1h", now))).toBe(NOW + 3_600_000);
    const tomorrow = new Date(doNotDisturbUntilFor("tomorrow", now));
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([11, 9, 0]);
    expect(doNotDisturbUntilFor("forever", now)).toBe("forever");
  });
});
