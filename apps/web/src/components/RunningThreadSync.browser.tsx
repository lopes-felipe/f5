import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { RunningThreadSync } from "./RunningThreadSync";
import { updateAppSettings } from "../appSettings";
import { useStore } from "../store";
import { DEFAULT_RUNTIME_MODE, DEFAULT_INTERACTION_MODE, type Thread } from "../types";
import { createEmptyThreadHistoryState } from "../lib/threadHistory";

const mocks = vi.hoisted(() => ({ preload: vi.fn() }));
vi.mock("../env", async (original) => ({
  ...(await original<typeof import("../env")>()),
  isElectron: true,
}));
vi.mock("../lib/threadPreload", () => ({ preloadRecentThreadDetails: mocks.preload }));
const thread: Thread = {
  id: ThreadId.makeUnsafe("background"),
  projectId: ProjectId.makeUnsafe("project"),
  codexThreadId: null,
  title: "Background",
  model: "gpt-5",
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_INTERACTION_MODE,
  createdAt: "2026-11-14T00:00:00Z",
  archivedAt: null,
  lastInteractionAt: "2026-11-14T00:00:00Z",
  session: {
    provider: "codex",
    status: "running",
    orchestrationStatus: "running",
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-14T00:00:00Z",
  },
  latestTurn: null,
  messages: [],
  commandExecutions: [],
  proposedPlans: [],
  activities: [],
  error: null,
  estimatedContextTokens: null,
  estimatedThinkingTokens: null,
  modelContextWindowTokens: null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  detailsLoaded: false,
  history: createEmptyThreadHistoryState(),
  tasks: [],
  tasksTurnId: null,
  tasksUpdatedAt: null,
  sessionNotes: null,
  threadReferences: [],
};
function Harness() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <RunningThreadSync />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  updateAppSettings({ keepRunningThreadsSynced: false });
  useStore.setState({ threads: [thread] });
  mocks.preload.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  updateAppSettings({ keepRunningThreadsSynced: false });
  useStore.setState({ threads: [] });
});
it("backs off repeated failures instead of retrying every five seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mocks.preload.mockResolvedValue(undefined);
  updateAppSettings({ keepRunningThreadsSynced: true });
  const view = await render(<Harness />);
  expect(mocks.preload).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.preload).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.preload).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.preload).toHaveBeenCalledTimes(3);
  await view.unmount();
});

it("does no work until opted in, and does not reload an already synchronized running thread", async () => {
  mocks.preload.mockImplementation(async () => {
    useStore.setState({ threads: [{ ...thread, detailsLoaded: true }] });
  });
  const view = await render(<Harness />);
  expect(mocks.preload).not.toHaveBeenCalled();
  updateAppSettings({ keepRunningThreadsSynced: true });
  await vi.waitFor(() => expect(mocks.preload).toHaveBeenCalledTimes(1));
  expect(mocks.preload.mock.calls[0]?.[1]).toMatchObject({ runningOnly: true });
  useStore.setState({ threads: [{ ...thread, detailsLoaded: true, title: "Updated" }] });
  expect(mocks.preload).toHaveBeenCalledTimes(1);
  await view.unmount();
});

it("aborts a pending warm when disabled", async () => {
  mocks.preload.mockImplementation(() => new Promise(() => {}));
  updateAppSettings({ keepRunningThreadsSynced: true });
  const view = await render(<Harness />);
  await vi.waitFor(() => expect(mocks.preload).toHaveBeenCalledTimes(1));
  const signal = mocks.preload.mock.calls[0]?.[1].signal as AbortSignal;
  updateAppSettings({ keepRunningThreadsSynced: false });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  await view.unmount();
});
