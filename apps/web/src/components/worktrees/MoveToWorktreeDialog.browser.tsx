import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { discardMovedChanges, MoveToWorktreeDialog } from "./MoveToWorktreeDialog";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  move: vi.fn(),
  discard: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    git: { status: mocks.status },
    dialogs: { confirm: mocks.confirm },
    worktrees: { moveThread: mocks.move, discardMovedChanges: mocks.discard },
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
let screen: Awaited<ReturnType<typeof render>> | undefined;
const threadId = ThreadId.makeUnsafe("move");
const close = vi.fn();
beforeEach(() => {
  mocks.status.mockResolvedValue({ workingTree: { files: ["tracked", "untracked"] } });
});
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  vi.clearAllMocks();
});
const dialog = (disabled = false) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MoveToWorktreeDialog
      threadId={threadId}
      projectCwd="/repo"
      disabled={disabled}
      onClose={close}
    />
  </QueryClientProvider>
);
it("explains project-wide copying, submits an optional branch and offers reversible discard", async () => {
  mocks.move.mockResolvedValue({
    operationId: "move-op",
    branch: "feature/copied",
    worktreePath: "/managed/copied",
    copiedFileCount: 2,
  });
  mocks.discard.mockResolvedValue({ discarded: true });
  mocks.confirm.mockResolvedValue(true);
  screen = await render(dialog());
  await expect.element(page.getByRole("dialog")).toHaveTextContent("2 files");
  await expect
    .element(page.getByRole("dialog"))
    .toHaveTextContent("including changes made outside this conversation");
  await expect
    .element(page.getByRole("dialog"))
    .toHaveTextContent("Ignored files such as .env are not copied");
  await expect.element(page.getByRole("textbox", { name: "Branch name (optional)" })).toHaveFocus();
  await page.getByRole("textbox", { name: "Branch name (optional)" }).fill("feature/copied");
  await page.getByRole("button", { name: "Move conversation" }).click();
  await expect
    .poll(() => mocks.move.mock.calls)
    .toEqual([[{ threadId, branch: "feature/copied" }]]);
  await expect.poll(() => close.mock.calls.length).toBe(1);
  expect(mocks.toast.mock.calls[0]?.[0].actionProps.children).toBe("Discard originals…");
  mocks.toast.mock.calls[0]?.[0].actionProps.onClick();
  await expect
    .poll(() => mocks.discard.mock.calls)
    .toEqual([[{ threadId, operationId: "move-op" }]]);
});
it("keeps the dialog and branch after a server error", async () => {
  mocks.move.mockRejectedValue(new Error("Commit or stash submodule changes first."));
  screen = await render(dialog());
  await expect.element(page.getByRole("button", { name: "Move conversation" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Branch name (optional)" }).fill("feature/retry");
  await page.getByRole("button", { name: "Move conversation" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Commit or stash submodule changes first.");
  await expect
    .element(page.getByRole("textbox", { name: "Branch name (optional)" }))
    .toHaveValue("feature/retry");
  expect(close).not.toHaveBeenCalled();
});
it("disables moving while a turn runs and supports cancelling by keyboard", async () => {
  screen = await render(dialog(true));
  await expect.element(page.getByRole("button", { name: "Move conversation" })).toBeDisabled();
  await expect.element(page.getByRole("status")).toHaveTextContent("Wait for the active turn");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.move).not.toHaveBeenCalled();
});

it("does not discard when the shared-checkout confirmation is cancelled", async () => {
  mocks.confirm.mockResolvedValue(false);
  expect(await discardMovedChanges(threadId, "cancel-op", "/repo", "topic")).toBe(false);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.stringContaining("f5: copied to topic (cancel-op)"),
  );
  expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("every conversation sharing"));
  expect(mocks.discard).not.toHaveBeenCalled();
});
