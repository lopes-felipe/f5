import { ThreadId, TurnId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useProactivePanels } from "./useProactivePanels";
import { useRightPanelStore } from "../rightPanelStore";

const threadId = ThreadId.makeUnsafe("proactive");
const turnId = TurnId.makeUnsafe("turn");
const completed = {
  turnId,
  completedAt: "2026-11-14T00:00:00Z",
  status: "ready",
  files: [{ path: "a.ts" }],
};
const openTurnDiff = vi.fn();
const base: Parameters<typeof useProactivePanels>[0] = {
  threadId,
  enabled: true,
  ready: true,
  runningTurnId: null,
  completedTurnId: null,
  checkpoints: [],
  isRepo: true,
  linkedPullRequest: null,
  openTurnDiff,
};
function Harness({ input }: { input: typeof base }) {
  useProactivePanels(input);
  return null;
}
beforeEach(() => {
  useRightPanelStore.setState({
    byThreadId: {},
    closedHistory: [],
    userActionRevisionByThreadId: {},
    proactiveDiffTurnIdByThreadId: {},
    proactiveTurnBaselineByThreadId: {},
    proactivePullRequestKeyByThreadId: {},
    pendingProactiveDiffNavigationByThreadId: {},
  });
  openTurnDiff.mockClear();
});

it("waits for a checkpoint and does not reopen a dismissed diff after remount", async () => {
  const view = await render(<Harness input={{ ...base, runningTurnId: turnId }} />);
  await view.rerender(<Harness input={{ ...base, completedTurnId: turnId }} />);
  expect(openTurnDiff).not.toHaveBeenCalled();
  await view.rerender(
    <Harness input={{ ...base, completedTurnId: turnId, checkpoints: [completed] }} />,
  );
  expect(openTurnDiff).toHaveBeenCalledExactlyOnceWith(turnId);
  useRightPanelStore.getState().closeAllSurfaces(threadId);
  await view.unmount();
  await render(<Harness input={{ ...base, completedTurnId: turnId, checkpoints: [completed] }} />);
  expect(openTurnDiff).toHaveBeenCalledTimes(1);
});

it("honors manual choices made while a turn or its checkpoint is pending", async () => {
  const view = await render(<Harness input={{ ...base, runningTurnId: turnId }} />);
  await view.rerender(<Harness input={{ ...base, completedTurnId: turnId }} />);
  useRightPanelStore.getState().open(threadId, "files");
  await view.rerender(
    <Harness input={{ ...base, completedTurnId: turnId, checkpoints: [completed] }} />,
  );
  expect(openTurnDiff).not.toHaveBeenCalled();
  expect(useRightPanelStore.getState().byThreadId[threadId]?.activeSurfaceId).toBe("files");
});

it.each([true, false])(
  "preserves a manual choice across visits while a turn settles (running on return: %s)",
  async (runningOnReturn) => {
    const view = await render(<Harness input={{ ...base, runningTurnId: turnId }} />);
    useRightPanelStore.getState().open(threadId, "files");
    await view.unmount();
    const other = await render(
      <Harness input={{ ...base, threadId: ThreadId.makeUnsafe("other") }} />,
    );
    await other.unmount();
    const returned = await render(
      <Harness
        input={{
          ...base,
          runningTurnId: runningOnReturn ? turnId : null,
          completedTurnId: runningOnReturn ? null : turnId,
          checkpoints: [completed],
        }}
      />,
    );
    await returned.rerender(
      <Harness input={{ ...base, completedTurnId: turnId, checkpoints: [completed] }} />,
    );
    expect(openTurnDiff).not.toHaveBeenCalled();
    expect(useRightPanelStore.getState().byThreadId[threadId]?.activeSurfaceId).toBe("files");
  },
);

it("leaves panels closed while disabled and prioritizes a linked PR over a diff", async () => {
  const link: ThreadPullRequestLink = {
    provider: "github",
    host: "github.com",
    repository: "a/b",
    number: 1,
    title: "Change",
    url: "https://github.com/a/b/pull/1",
  };
  const input = {
    ...base,
    completedTurnId: turnId,
    checkpoints: [completed],
    linkedPullRequest: link,
  };
  const view = await render(<Harness input={{ ...input, enabled: false }} />);
  expect(useRightPanelStore.getState().byThreadId[threadId]).toBeUndefined();
  // A newly linked PR is observed while enabled.
  await view.rerender(<Harness input={base} />);
  await view.rerender(<Harness input={input} />);
  expect(useRightPanelStore.getState().byThreadId[threadId]?.activeSurfaceId).toMatch(/^pr:/);
  expect(openTurnDiff).not.toHaveBeenCalled();
  useRightPanelStore.getState().close(threadId);
  await view.unmount();
  await render(<Harness input={input} />);
  expect(useRightPanelStore.getState().byThreadId[threadId]?.isOpen).toBe(false);
});
