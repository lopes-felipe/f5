import "../../index.css";
import { CommandId, ThreadId, type ThreadWorkspaceStatus } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { WorkspaceStatusCard } from "./WorkspaceStatusCard";

const api = vi.hoisted(() => ({
  worktrees: { recover: vi.fn() },
  nextTurnQueue: { list: vi.fn(), cancel: vi.fn() },
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => api, readNativeApi: () => api }));

const threadId = ThreadId.makeUnsafe("workspace-thread");
let revision = 0;
const snapshot = (workspace: ThreadWorkspaceStatus | null, items: ReadonlyArray<string> = []) => ({
  threadId,
  revision: ++revision,
  paused: false,
  blockedKind: null,
  reasonCode: null,
  reasonDetail: null,
  maxItems: 20,
  quarantinedCount: 0,
  items: items.map((id) => ({ itemId: CommandId.makeUnsafe(id) })) as never,
  workspace,
});
const show = (workspace: ThreadWorkspaceStatus | null) =>
  useNextTurnQueueStore.getState().applySnapshot(snapshot(workspace));
const mount = (props: Partial<Parameters<typeof WorkspaceStatusCard>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceStatusCard threadId={threadId} {...props} />
    </QueryClientProvider>,
  );
const buttons = () =>
  [...document.querySelectorAll("button")].map((button) => button.textContent?.trim());

beforeEach(() => {
  useNextTurnQueueStore.setState({ byThreadId: {} });
  // After an action the card reads the queue again; by default nothing changed.
  api.nextTurnQueue.list.mockImplementation(async () => snapshot(null));
  api.worktrees.recover.mockResolvedValue({});
  api.nextTurnQueue.cancel.mockResolvedValue({});
});
afterEach(() => vi.resetAllMocks());

it.each([
  null,
  { kind: "ready", location: "worktree", path: "/worktrees/topic", branch: "topic" },
  { kind: "ready", location: "projectFolder", path: "/repo", branch: "main" },
  // Cleaned up to save disk: the next message brings it back, so there is nothing to say.
  { kind: "dormant", path: "/worktrees/topic", branch: "topic" },
] as const)("says nothing while the workspace needs nothing: %o", async (workspace) => {
  show(workspace);
  await mount();
  expect(document.body.textContent?.trim()).toBe("");
});

it.each([
  ["restoring", true, "Restoring the worktree…", ["Cancel"]],
  ["switching", true, "Switching workspace…", ["Cancel"]],
  ["moving", true, "Moving this thread to a new worktree…", ["Cancel"]],
  // Preparing a worktree that was just restored has nothing to cancel.
  ["restoring", false, "Restoring the worktree…", []],
  // A first-send setup is cancelled from its own card.
  ["creating", true, "Setting up the worktree…", []],
] as const)(
  "shows one line while the workspace is %s (cancellable: %s)",
  async (activity, cancellable, text, expected) => {
    show({ kind: "working", activity, cancellable });
    const screen = await mount();
    await expect.element(screen.getByRole("status")).toHaveTextContent(text);
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Messages wait until it finishes.");
    expect(buttons()).toEqual(expected);
    if (expected.length === 0) return;
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() =>
      expect(api.worktrees.recover).toHaveBeenCalledWith({ threadId, action: "cancel" }),
    );
  },
);

it("offers exactly the actions the server lists, the first as the primary one", async () => {
  show({
    kind: "attention",
    reason: "branch_in_use",
    message:
      "topic is checked out in the project folder, so this thread's worktree cannot be restored on it.",
    actions: ["attach", "newWorktree"],
  });
  const screen = await mount();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("topic is checked out in the project folder");
  expect(buttons()).toEqual(["Continue there", "New worktree"]);
  await screen.getByRole("button", { name: "New worktree" }).click();
  await vi.waitFor(() =>
    expect(api.worktrees.recover).toHaveBeenCalledWith({ threadId, action: "newWorktree" }),
  );
  // The card follows the status the queue reports afterwards.
  await vi.waitFor(() => expect(document.body.textContent?.trim()).toBe(""));
});

it("retries a failed restore, shows why it failed again, and keeps the other way out", async () => {
  show({
    kind: "attention",
    reason: "restore_failed",
    message: "Git said no",
    actions: ["retry", "useProjectFolder"],
  });
  api.worktrees.recover.mockRejectedValueOnce(new Error("Git still says no"));
  const screen = await mount();
  expect(buttons()).toEqual(["Try again", "Continue in Local"]);
  await screen.getByRole("button", { name: "Try again" }).click();
  expect(api.worktrees.recover).toHaveBeenCalledWith({ threadId, action: "restore" });
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Git still says no");
  await screen.getByRole("button", { name: "Continue in Local" }).click();
  await vi.waitFor(() =>
    expect(api.worktrees.recover).toHaveBeenLastCalledWith({
      threadId,
      action: "useProjectFolder",
    }),
  );
});

it("discards the waiting message instead of recovering, and never shows more than three actions", async () => {
  show({
    kind: "attention",
    reason: "setup_failed",
    message: "Worktree setup did not finish.",
    actions: ["retry", "useProjectFolder", "discard", "newWorktree"],
  });
  api.nextTurnQueue.list.mockImplementation(async () => snapshot(null, ["waiting", "later"]));
  const screen = await mount();
  expect(buttons()).toEqual(["Try again", "Continue in Local", "Discard message"]);
  await screen.getByRole("button", { name: "Discard message" }).click();
  await vi.waitFor(() =>
    expect(api.nextTurnQueue.cancel).toHaveBeenCalledWith({ itemId: "waiting" }),
  );
  expect(api.worktrees.recover).not.toHaveBeenCalled();
});

it("holds its actions while a turn is running", async () => {
  show({
    kind: "attention",
    reason: "restore_failed",
    message: "The worktree could not be restored.",
    actions: ["retry", "useProjectFolder"],
  });
  const screen = await mount({ turnActive: true });
  await expect.element(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Continue in Local" })).toBeDisabled();
  await expect
    .element(screen.getByText("Available after the current turn finishes."))
    .toBeVisible();
});

it("lets the first-send setup card stand in for the summary", async () => {
  show({ kind: "working", activity: "creating", cancellable: true });
  const screen = await mount({ setup: <section aria-label="Worktree setup">stages</section> });
  await expect.element(screen.getByLabelText("Worktree setup")).toBeVisible();
  // One workspace surface, not two.
  expect(screen.getByLabelText("Workspace status").query()).toBeNull();
});
