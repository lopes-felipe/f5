import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warmThreadBundle = vi.hoisted(() => vi.fn());
vi.mock("./threadPreload", () => ({ warmThreadBundle }));

import { useStore } from "../store";
import type { Thread } from "../types";
import { hydrateOmittedThreadPlans, hydrateUnarchivedThreadPlans } from "./useThreadPlansHydrated";

const archivedId = ThreadId.makeUnsafe("thread-archived");
const liveId = ThreadId.makeUnsafe("thread-live");
const initialState = useStore.getState();

const setThreads = (threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlansOmitted">>) =>
  useStore.setState({ threads: threads as Thread[] });
const clearOmission = (threadId: ThreadId) =>
  setThreads(
    useStore
      .getState()
      .threads.map((thread) =>
        thread.id === threadId ? { id: thread.id, proposedPlansOmitted: false } : thread,
      ),
  );
const unarchived = (threadId: ThreadId) =>
  ({
    type: "thread.unarchived",
    payload: { threadId, unarchivedAt: "2026-04-02T00:00:00.000Z" },
  }) as OrchestrationEvent;

describe("omitted plan hydration", () => {
  beforeEach(() => {
    warmThreadBundle.mockReset();
    setThreads([
      { id: archivedId, proposedPlansOmitted: true },
      { id: liveId, proposedPlansOmitted: false },
    ]);
  });
  afterEach(() => useStore.setState(initialState, true));

  it("loads the omitted plans of an unarchived thread once while the load is in flight", async () => {
    let finish!: () => void;
    warmThreadBundle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            clearOmission(archivedId);
            resolve();
          };
        }),
    );
    const queryClient = new QueryClient();
    hydrateUnarchivedThreadPlans(queryClient, [
      unarchived(archivedId),
      unarchived(liveId),
      unarchived(archivedId),
    ]);
    expect(warmThreadBundle).toHaveBeenCalledTimes(1);
    expect(warmThreadBundle).toHaveBeenCalledWith(queryClient, archivedId, {
      forceThreadDetails: true,
    });
    const joined = hydrateOmittedThreadPlans(queryClient, archivedId);
    finish();
    await expect(joined).resolves.toBe(true);
  });

  it("reports a load that finished with the plans still omitted", async () => {
    warmThreadBundle.mockResolvedValueOnce(undefined);
    await expect(hydrateOmittedThreadPlans(new QueryClient(), archivedId)).resolves.toBe(false);
    // The next attempt starts a new load rather than reusing the finished one.
    warmThreadBundle.mockRejectedValueOnce(new Error("offline"));
    await expect(hydrateOmittedThreadPlans(new QueryClient(), archivedId)).rejects.toThrow(
      "offline",
    );
    expect(warmThreadBundle).toHaveBeenCalledTimes(2);
  });
});
