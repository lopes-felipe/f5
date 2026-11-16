import "../../index.css";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useStore } from "../../store";
import type { Thread } from "../../types";
import { ThreadSettlementControl } from "./ThreadSettlementControl";
import { ThreadSettlementFields } from "../settings/ThreadSettlementSettings";

const api = vi.hoisted(() => ({ dispatchCommand: vi.fn() }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ orchestration: api }) }));
const threadId = ThreadId.makeUnsafe("settlement-browser");
const at = "2026-10-19T12:00:00.000Z";
const thread: Thread = {
  id: threadId,
  codexThreadId: null,
  projectId: "project" as Thread["projectId"],
  title: "Finished work",
  model: "gpt-5",
  runtimeMode: "full-access",
  interactionMode: "default",
  session: null,
  messages: [],
  commandExecutions: [],
  proposedPlans: [],
  error: null,
  createdAt: at,
  archivedAt: null,
  lastInteractionAt: at,
  estimatedContextTokens: null,
  estimatedThinkingTokens: null,
  modelContextWindowTokens: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
  detailsLoaded: true,
  tasks: [],
  tasksTurnId: null,
  tasksUpdatedAt: null,
  settledAt: at,
  settledBy: "user",
  autoSettleDisabled: false,
};
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  useStore.setState({ threads: [thread] });
  api.dispatchCommand.mockReset().mockResolvedValue({ sequence: 2 });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  useStore.setState({ threads: [] });
});
it("keeps settled work reachable and sends an explicit wake without starting a turn", async () => {
  active = await render(<ThreadSettlementControl threadId={threadId} />);
  await page.getByRole("button", { name: "Unsettle", exact: true }).click();
  expect(api.dispatchCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ type: "thread.unsettle", threadId }),
  );
  useStore.setState({ threads: [{ ...thread, settledAt: null, settledBy: null }] });
  await expect
    .element(page.getByRole("button", { name: "Unsettle", exact: true }))
    .not.toBeInTheDocument();
});
it("renders nothing in the header for unsettled threads", async () => {
  useStore.setState({ threads: [{ ...thread, settledAt: null, settledBy: null }] });
  active = await render(<ThreadSettlementControl threadId={threadId} />);
  await expect
    .element(page.getByRole("button", { name: "Unsettle", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("switch", { name: "Auto-settle this thread" }))
    .not.toBeInTheDocument();
});
it("bounds idle settlement to 365 days and leaves clearing the rule explicit", async () => {
  const change = vi.fn();
  active = await render(
    <ThreadSettlementFields
      settings={{
        autoSettleOnPullRequestMerge: false,
        autoSettleAfterDays: null,
        autoSettleKeepPullRequests: true,
      }}
      onChange={change}
    />,
  );
  const days = page.getByRole("textbox", { name: "Automatically settle idle threads after" });
  await days.fill("366");
  await userEvent.keyboard("{Enter}");
  expect(change).not.toHaveBeenCalled();
  await expect.element(days).toHaveAttribute("aria-invalid", "true");
  await days.fill("365");
  await userEvent.keyboard("{Enter}");
  expect(change).toHaveBeenCalledWith({ autoSettleAfterDays: 365 });
  await expect
    .element(page.getByRole("switch", { name: "Automatically settle resolved PR threads" }))
    .not.toBeChecked();
});
