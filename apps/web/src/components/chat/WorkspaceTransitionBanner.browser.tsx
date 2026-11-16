import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, type WorkspaceTransitionSnapshot } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { WorkspaceTransitionBanner } from "./WorkspaceTransitionBanner";

const api = vi.hoisted(() => ({
  getTransition: vi.fn(),
  previewTransitionRecovery: vi.fn(),
  resolveTransition: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ worktrees: api }) }));
vi.mock("../../nextTurnQueueStore", () => ({
  useNextTurnQueueStore: (select: (state: { byThreadId: Record<string, never> }) => unknown) =>
    select({ byThreadId: {} }),
}));
let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.resetAllMocks();
});
const threadId = ThreadId.makeUnsafe("switch-thread");
const source = { path: "/project", repository: "/project/.git", branch: "main", headSha: "base" };
const transition: WorkspaceTransitionSnapshot = {
  operationId: "switch",
  threadId,
  version: 5,
  intent: "attach_existing",
  phase: "needs_recovery",
  source,
  target: { ...source, path: "/worktrees/topic", branch: "topic" },
  observed: null,
  result: null,
  error: "Switching was interrupted.",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
async function mount() {
  mounted = await render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <WorkspaceTransitionBanner threadId={threadId} />
    </QueryClientProvider>,
  );
}
it("shows inspected identities and disables retry for ambiguous Git outcomes", async () => {
  api.getTransition.mockResolvedValue(transition);
  api.previewTransitionRecovery.mockResolvedValue({
    transition,
    actual: transition.target,
    original: source,
    projectCheckout: source,
    acceptanceToken: "token",
    canRetry: false,
    blockedReasons: [],
  });
  await mount();
  await expect
    .element(page.getByText("Workspace switching needs attention. Your files have been kept."))
    .toBeVisible();
  await page.getByRole("button", { name: "Inspect workspace" }).click();
  await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Accept inspected workspace" }))
    .toBeEnabled();
  await expect.element(page.getByText(/Inspected: topic/)).toBeVisible();
});
it("rejects stale inspection visibly and requires a new preview before retrying acceptance", async () => {
  api.getTransition.mockResolvedValue(transition);
  api.previewTransitionRecovery.mockResolvedValue({
    transition,
    actual: transition.target,
    original: source,
    projectCheckout: source,
    acceptanceToken: "stale",
    canRetry: false,
    blockedReasons: [],
  });
  api.resolveTransition.mockRejectedValue(
    new Error("The checkout changed. Preview recovery again."),
  );
  await mount();
  await page.getByRole("button", { name: "Inspect workspace" }).click();
  await page.getByRole("button", { name: "Accept inspected workspace" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("The checkout changed.");
  await expect
    .element(page.getByRole("button", { name: "Accept inspected workspace" }))
    .not.toBeInTheDocument();
  expect(api.resolveTransition).toHaveBeenCalledWith({
    operationId: "switch",
    version: 5,
    acceptanceToken: "stale",
    action: "accept_inspected_workspace",
  });
});
it("reports an active switch without offering recovery actions", async () => {
  api.getTransition.mockResolvedValue({ ...transition, phase: "stopping", error: null });
  await mount();
  await expect
    .element(page.getByText("Switching workspace. Sending is blocked until it finishes."))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Inspect workspace" }))
    .not.toBeInTheDocument();
});

it("offers the inspected project checkout when a failed recreation left neither recorded checkout available", async () => {
  api.getTransition
    .mockResolvedValueOnce(transition)
    .mockResolvedValue({ ...transition, phase: "completed" });
  api.previewTransitionRecovery.mockResolvedValue({
    transition,
    actual: null,
    original: null,
    projectCheckout: source,
    acceptanceToken: "root-token",
    canRetry: false,
    blockedReasons: ["The target checkout could not be verified."],
  });
  api.resolveTransition.mockResolvedValue({ ...transition, phase: "completed" });
  await mount();
  await page.getByRole("button", { name: "Inspect workspace" }).click();
  await expect
    .element(page.getByRole("button", { name: "Accept inspected workspace" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Keep original workspace" }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Continue in project checkout" }).click();
  expect(api.resolveTransition).toHaveBeenCalledWith({
    operationId: "switch",
    version: 5,
    acceptanceToken: "root-token",
    action: "use_project_checkout",
  });
});

it("reports retained move checkouts after cancellation without blocking sending", async () => {
  api.getTransition.mockResolvedValue({
    ...transition,
    intent: "move_to_new_worktree",
    phase: "cancelled",
    error: "Retained checkout /worktrees/topic and branch topic.",
  });
  await mount();
  await expect.element(page.getByRole("status")).toHaveTextContent("does not block sending");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Retained checkout /worktrees/topic");
  await expect
    .element(page.getByRole("button", { name: "Inspect workspace" }))
    .not.toBeInTheDocument();
});
