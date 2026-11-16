import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useChatViewBranchDriftGuard } from "./ChatViewBranchDriftGuard";
import { switchConversationWorkspace } from "../lib/workspaceTransitions";

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    git: {
      listBranches: async () => ({ isRepo: true, branches: [{ current: true, name: "actual" }] }),
    },
  }),
}));
vi.mock("../lib/workspaceTransitions", () => ({
  switchConversationWorkspace: vi.fn(async () => ({})),
}));
vi.mock("~/lib/gitReactQuery", () => ({ invalidateGitQueries: vi.fn(async () => undefined) }));

const threadId = ThreadId.make("worktree-drift");
function Harness() {
  const { guardBranchDrift, branchDriftDialog } = useChatViewBranchDriftGuard(threadId);
  return (
    <>
      <button
        onClick={() =>
          void guardBranchDrift({
            threadId,
            cwd: "/repo/worktree",
            worktreePath: "/repo/worktree",
            recordedBranch: "recorded",
          })
        }
      >
        Send
      </button>
      {branchDriftDialog}
    </>
  );
}

it("warns on worktree drift, preserves its attachment, and never offers a branch switch", async () => {
  const view = await render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  try {
    await view.getByRole("button", { name: "Send", exact: true }).click();
    await expect.element(view.getByRole("dialog")).toBeVisible();
    expect(document.body.textContent).toContain("Thread branch changed");
    expect(document.body.textContent).not.toContain("Switch to recorded");
    await view.getByRole("button", { name: "Continue on actual" }).click();
    expect(switchConversationWorkspace).toHaveBeenCalledWith(threadId, {
      intent: "attach_existing",
      targetPath: "/repo/worktree",
      branch: "actual",
    });
  } finally {
    await view.unmount();
  }
});
