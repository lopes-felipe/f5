import { beforeEach, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { useStore } from "../store";
import { useRightPanelStore } from "../rightPanelStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useComposerMentionHistoryStore } from "../composerMentionHistoryStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { cleanupDeletedThread, cleanupDeletedThreadsFromSnapshot } from "./deletedThreadCleanup";

const close = vi.hoisted(() => vi.fn());
vi.mock("../nativeApi", () => ({ readNativeApi: () => ({ terminal: { close } }) }));
const id = ThreadId.makeUnsafe("retained");
beforeEach(() => {
  close.mockReset().mockResolvedValue(undefined);
  useStore.setState({ backendGeneration: (useStore.getState().backendGeneration ?? 0) + 1 });
  useRightPanelStore.setState({ byThreadId: {}, closedHistory: [] });
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useComposerMentionHistoryStore.setState({ entries: [] });
  useTerminalStateStore.setState({ terminalStateByThreadId: {} });
});
it("cleans result/event duplicates once and skips historical tombstones on reconnect", async () => {
  let resolveClose!: () => void;
  close.mockReturnValue(
    new Promise<void>((resolve) => {
      resolveClose = resolve;
    }),
  );
  useRightPanelStore.getState().open(id, "files");
  const first = cleanupDeletedThread(id);
  const duplicate = cleanupDeletedThread(id);
  expect(close).toHaveBeenCalledOnce();
  resolveClose();
  await Promise.all([first, duplicate]);
  const tombstones = Array.from({ length: 10_000 }, (_, index) => ({
    id: ThreadId.makeUnsafe("old-" + index),
    deletedAt: "2026-01-01T00:00:00Z",
  }));
  tombstones.push({ id, deletedAt: "2026-01-01T00:00:00Z" });
  await cleanupDeletedThreadsFromSnapshot(tombstones);
  await cleanupDeletedThreadsFromSnapshot(tombstones);
  expect(close).toHaveBeenCalledOnce();
  expect(useRightPanelStore.getState().byThreadId[id]).toBeUndefined();
});
it("cleans retained startup state, preserves local drafts without tombstones and retries failures", async () => {
  const local = ThreadId.makeUnsafe("unpromoted-local");
  useRightPanelStore.getState().open(id, "files");
  useRightPanelStore.getState().open(local, "files");
  close.mockRejectedValueOnce(new Error("Terminal unavailable"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const snapshot = [{ id, deletedAt: "2026-01-01T00:00:00Z" }];
    await cleanupDeletedThreadsFromSnapshot(snapshot);
    expect(close).toHaveBeenCalledOnce();
    expect(useRightPanelStore.getState().byThreadId[id]).toBeUndefined();
    expect(useRightPanelStore.getState().byThreadId[local]).toBeDefined();
    await cleanupDeletedThreadsFromSnapshot(snapshot);
    expect(close).toHaveBeenCalledTimes(2);
    await cleanupDeletedThreadsFromSnapshot(snapshot);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});

it("stops a snapshot cleanup batch when the backend changes", async () => {
  let resolveClose!: () => void;
  close.mockReturnValue(
    new Promise<void>((resolve) => {
      resolveClose = resolve;
    }),
  );
  const snapshot = Array.from({ length: 9 }, (_, index) => ({
    id: ThreadId.makeUnsafe("batch-" + index),
    deletedAt: "2026-01-01T00:00:00Z",
  }));
  for (const thread of snapshot) useRightPanelStore.getState().open(thread.id, "files");
  const pending = cleanupDeletedThreadsFromSnapshot(snapshot);
  expect(close).toHaveBeenCalledTimes(8);
  useStore.setState({ backendGeneration: (useStore.getState().backendGeneration ?? 0) + 1 });
  resolveClose();
  await pending;
  expect(close).toHaveBeenCalledTimes(8);
  expect(useRightPanelStore.getState().byThreadId[snapshot[8]!.id]).toBeDefined();
});
