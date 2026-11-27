import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, type WorkspaceTransitionSnapshot } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { WorkspaceTransitionBanner } from "./WorkspaceTransitionBanner";

const api = vi.hoisted(() => ({ getTransition: vi.fn() }));
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
  phase: "stopping",
  source,
  target: { ...source, path: "/worktrees/topic", branch: "topic" },
  observed: null,
  result: null,
  error: null,
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

it("reports a running switch by folder name, with nothing to act on", async () => {
  api.getTransition.mockResolvedValue(transition);
  await mount();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Switching to topic… Messages wait until it finishes.");
  expect(document.body.textContent).not.toContain("/worktrees/topic");
  expect(page.getByRole("button").elements()).toHaveLength(0);
});

it.each([
  ["needs_recovery", "attach_existing", "Switching was interrupted."],
  ["failed", "checkout_branch", "The checkout failed."],
  ["cancelled", "move_to_new_worktree", "The move did not finish. Kept topic on topic."],
  ["completed", "recreate", null],
] as const)("shows nothing for a switch that ended as %s", async (phase, intent, error) => {
  api.getTransition.mockResolvedValue({ ...transition, phase, intent, error });
  await mount();
  await vi.waitFor(() => expect(api.getTransition).toHaveBeenCalledWith({ threadId }));
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(page.getByRole("button").elements()).toHaveLength(0);
  expect(document.body.textContent?.trim()).toBe("");
});
