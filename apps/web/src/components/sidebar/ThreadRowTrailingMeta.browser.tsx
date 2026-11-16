import { ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { terminalStatusFromRunningIds } from "./sidebarLists";
import { ThreadRowTrailingMeta } from "./SidebarThreadRow";

const threadId = ThreadId.makeUnsafe("terminal-thread");

afterEach(() => {
  useTerminalStateStore.getState().clearTerminalState(threadId);
});

it("opens the drawer on the running terminal, including one in a split", async () => {
  const store = useTerminalStateStore.getState();
  store.ensureTerminal(threadId, "default");
  store.splitTerminal(threadId, "setup");
  store.setActiveTerminal(threadId, "default");
  store.setTerminalActivity(threadId, "setup", true);
  store.setTerminalOpen(threadId, false);
  const state = () =>
    selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, threadId);
  const screen = await render(
    <ThreadRowTrailingMeta
      thread={{ id: threadId, branch: null, worktreePath: null, titleRegeneration: null }}
      lastInteractionAt="2026-10-01T00:00:00.000Z"
      terminalStatus={terminalStatusFromRunningIds(state().runningTerminalIds)}
      isHighlighted={false}
    />,
  );
  try {
    await page.getByRole("button", { name: "Terminal process running. Show terminal" }).click();
    expect(state()).toMatchObject({ terminalOpen: true, activeTerminalId: "setup" });
  } finally {
    await screen.unmount();
  }
});
