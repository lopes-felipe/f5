import { beforeEach, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import type { Thread } from "./types";
import { applyBulkThreadAction } from "./bulkThreadActions";

const state = vi.hoisted(() => ({ threads: [] as Thread[], pinRevision: 4 }));
const actions = vi.hoisted(() => ({
  archive: vi.fn(),
  replace: vi.fn(),
  snooze: vi.fn(),
  undo: vi.fn(),
}));
vi.mock("./store", () => ({ useStore: { getState: () => state } }));
vi.mock("./archiveActions", () => ({ dispatchThreadArchive: actions.archive }));
vi.mock("./threadUndo", () => ({ recordThreadUndo: actions.undo }));
vi.mock("./threadPinSnooze", async (original) => ({
  ...(await original<object>()),
  replacePinnedThreads: actions.replace,
  snoozeThread: actions.snooze,
}));
const ids = ["a", "b", "c"].map(ThreadId.makeUnsafe);
beforeEach(() => {
  vi.clearAllMocks();
  state.threads = ids.map(
    (id, index) =>
      ({
        id,
        archivedAt: null,
        snoozedUntil: null,
        pinnedAt: "2026-09-25T00:00:00Z",
        pinOrderKey: index,
      }) as Thread,
  );
  actions.archive.mockResolvedValue(undefined);
  actions.replace.mockResolvedValue(undefined);
});
it("continues after an archive failure and reports only admitted changes", async () => {
  actions.archive.mockRejectedValueOnce(new Error("Offline"));
  const result = await applyBulkThreadAction(ids, "archive");
  expect(result.succeeded).toEqual(ids.slice(1));
  expect(result.failures.map((failure) => failure.id)).toEqual([ids[0]]);
  expect(actions.archive).toHaveBeenCalledTimes(3);
});
it("restores removed pins at their former positions without resurrecting deleted threads", async () => {
  await applyBulkThreadAction([ids[0]!, ids[2]!], "unpin");
  expect(actions.replace).toHaveBeenCalledWith(
    expect.objectContaining({ pinnedThreadIds: [ids[1]], expectedRevision: 4 }),
  );
  state.threads = state.threads
    .filter((thread) => thread.id !== ids[2])
    .map((thread) =>
      thread.id === ids[0] ? { ...thread, pinnedAt: null, pinOrderKey: null } : thread,
    );
  await actions.undo.mock.calls[0]![1]();
  expect(actions.replace).toHaveBeenLastCalledWith(
    expect.objectContaining({ pinnedThreadIds: [ids[0], ids[1]] }),
  );
});
it("does not offer undo for a rejected pin transaction", async () => {
  actions.replace.mockRejectedValueOnce(new Error("Revision changed"));
  await expect(applyBulkThreadAction(ids, "unpin")).rejects.toThrow("Revision changed");
  expect(actions.undo).not.toHaveBeenCalled();
});
