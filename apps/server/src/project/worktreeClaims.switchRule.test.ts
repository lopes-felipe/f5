import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  formatInPlaceSwitchBlockers,
  inPlaceSwitchBlockers,
  type WorktreeClaims,
} from "./worktreeClaims.ts";

const own = ThreadId.makeUnsafe("own");
const idle = ThreadId.makeUnsafe("idle");
const archived = ThreadId.makeUnsafe("archived");
const busy = ThreadId.makeUnsafe("busy");

const claims = (overrides: Partial<WorktreeClaims> = {}): WorktreeClaims => ({
  unknown: false,
  activeThreadIds: [],
  setupThreadIds: [],
  transitionThreadIds: [],
  deletedThreadIds: [],
  threadIds: [own, idle, archived],
  queuedThreadIds: [],
  terminals: [],
  sessions: [],
  ...overrides,
});

// One rule for the project folder and for worktrees: only live use blocks.
const projectFolder = { requester: own } as const;

describe("inPlaceSwitchBlockers", () => {
  it("lets idle and archived threads and their idle sessions through", () => {
    expect(
      inPlaceSwitchBlockers(
        claims({ sessions: [{ threadId: idle, cwd: "/repo" }] }),
        projectFolder,
      ),
    ).toEqual([]);
  });

  it.each([
    ["running or pending turn", { activeThreadIds: [busy] }, "turn"],
    ["queued work", { queuedThreadIds: [busy] }, "queued"],
    ["setup or transition owner", { setupThreadIds: [busy], transitionThreadIds: [busy] }, "setup"],
  ] as const)("blocks on another thread's %s", (_label, overrides, kind) => {
    const usage = claims({ threadIds: [own, busy], ...overrides });
    expect(inPlaceSwitchBlockers(usage, projectFolder)).toEqual([{ kind, threadId: busy }]);
  });

  it("never blocks on the requester's own turn, queue or setup", () => {
    expect(
      inPlaceSwitchBlockers(
        claims({ activeThreadIds: [own], queuedThreadIds: [own], setupThreadIds: [own] }),
        projectFolder,
      ),
    ).toEqual([]);
  });

  it("blocks on any live terminal, including the requester's own", () => {
    expect(
      inPlaceSwitchBlockers(
        claims({
          terminals: [
            { threadId: own, terminalId: "a", cwd: "/repo" },
            { threadId: own, terminalId: "b", cwd: "/repo/src" },
          ],
        }),
        projectFolder,
      ),
    ).toEqual([{ kind: "terminal", threadId: own }]);
  });

  it("blocks on a session whose thread is not a known reference of the folder", () => {
    expect(
      inPlaceSwitchBlockers(
        claims({ sessions: [{ threadId: "deleted", cwd: "/repo" }] }),
        projectFolder,
      ),
    ).toEqual([{ kind: "session", threadId: "deleted" }]);
  });

  it("fails closed when usage could not be read", () => {
    expect(inPlaceSwitchBlockers(claims({ unknown: true }), projectFolder)).toEqual([
      { kind: "unknown", threadId: null },
    ]);
  });

  it("fails closed when pending turn starts were not checked", () => {
    expect(inPlaceSwitchBlockers(claims({ pendingTurnsChecked: false }), projectFolder)).toEqual([
      { kind: "unknown", threadId: null },
    ]);
  });

  it("blocks on a known thread's starting, connecting or running session", () => {
    expect(
      inPlaceSwitchBlockers(
        claims({ sessions: [{ threadId: idle, cwd: "/repo", live: true }] }),
        projectFolder,
      ),
    ).toEqual([{ kind: "session", threadId: idle }]);
  });
});

describe("formatInPlaceSwitchBlockers", () => {
  const titles: Record<string, string> = {
    a: "Review PR 719",
    b: "Fix login",
    c: "Docs",
    d: "Ops",
  };
  const titleOf = (id: string) => titles[id] ?? null;

  it("names up to three conversations and what they are doing", () => {
    expect(
      formatInPlaceSwitchBlockers(
        [
          { kind: "turn", threadId: "a" },
          { kind: "terminal", threadId: "b" },
          { kind: "queued", threadId: "c" },
          { kind: "setup", threadId: "d" },
          { kind: "otherProfile", threadId: null },
        ],
        titleOf,
      ),
    ).toBe(
      "In use by Review PR 719 (running turn), Fix login (open terminal), Docs (queued messages) and 2 more. Start a new worktree instead.",
    );
  });

  it("falls back for unknown titles and unverifiable usage", () => {
    expect(formatInPlaceSwitchBlockers([{ kind: "session", threadId: "x" }], titleOf)).toBe(
      "In use by another conversation (agent session). Start a new worktree instead.",
    );
    expect(formatInPlaceSwitchBlockers([{ kind: "unknown", threadId: null }], titleOf)).toBe(
      "Workspace usage could not be verified. Start a new worktree instead.",
    );
  });
});
