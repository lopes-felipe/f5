import "../index.css";
import { ProjectId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { WorktreeRemovalDialog } from "./WorktreeRemovalDialog";

const api = vi.hoisted(() => ({
  worktrees: { inspect: vi.fn(), remove: vi.fn() },
}));
vi.mock("../nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));
afterEach(() => vi.resetAllMocks());
const projectId = ProjectId.makeUnsafe("project");
const inspection = (branch: string, options = {}) => ({
  exists: true,
  registration: null,
  blockedReasons: [],
  linkedThreads: [],
  deletedThreadClaims: [],
  branch,
  headSha: "abc",
  branchExists: true,
  branchMerged: true,
  branchPushed: false,
  branchUpstreamGone: false,
  branchDeletable: true,
  branchBlockedReason: null,
  ...options,
});
const mount = (children: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>,
  );
it("defaults merged branches on, keeps pushed branches optional, and disables blocked rows", async () => {
  api.worktrees.inspect.mockImplementation(async ({ path }: { path: string }) =>
    path === "/blocked"
      ? inspection("protected", {
          blockedReasons: ["Ignored .env must be kept"],
          branchDeletable: false,
          branchBlockedReason: "A conversation references this branch",
        })
      : inspection(path.slice(1), {
          branchMerged: path === "/merged",
          branchPushed: path === "/pushed",
          linkedThreads:
            path === "/merged" ? [{ threadId: "idle", title: "Review", archived: true }] : [],
        }),
  );
  api.worktrees.remove.mockResolvedValue({
    removed: false,
    branchDeleted: false,
    blockedReasons: ["HEAD changed since inspection"],
  });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog
      rows={["/merged", "/pushed", "/blocked"].map((path) => ({ projectId, path }))}
      onClose={close}
    />,
  );
  await expect
    .element(screen.getByRole("checkbox", { name: "/merged", exact: true }))
    .toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "Also delete branch merged" }))
    .toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "Also delete branch pushed" }))
    .not.toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "/blocked", exact: true }))
    .toBeDisabled();
  await expect.element(screen.getByText(/Linked idle conversations will recreate/)).toBeVisible();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.remove.mock.calls.length).toBe(2);
  expect(api.worktrees.remove.mock.calls[0]?.[0]).toMatchObject({
    expectedHead: "abc",
    deleteBranch: true,
  });
  expect(api.worktrees.remove.mock.calls[1]?.[0]).toMatchObject({ deleteBranch: false });
  expect(close).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Keep all" }).click();
  expect(close).toHaveBeenCalledOnce();
});
it("shows all ignored paths and requires explicit confirmation before sending their approval", async () => {
  const entries = [
    "apps/desktop/.turbo/",
    "apps/desktop/dist-electron/",
    "apps/desktop/dist-native/",
    "docs/ci-issue-drafts/",
    ".env",
    "node_modules/",
  ];
  const blockedReason = "Ignored files and folders require explicit deletion confirmation.";
  api.worktrees.inspect.mockResolvedValue(
    inspection("feature", {
      branchMerged: false,
      blockedReasons: [blockedReason],
      ignoredFiles: {
        entries,
        truncated: false,
        requiresApproval: true,
        canRemoveAfterApproval: true,
      },
    }),
  );
  api.worktrees.remove.mockResolvedValue({
    removed: true,
    branchDeleted: false,
    blockedReasons: [],
  });
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/ignored" }]} onClose={vi.fn()} />,
  );
  const select = screen.getByRole("checkbox", { name: "/ignored", exact: true });
  await expect.element(select).toBeDisabled();
  for (const entry of entries)
    await expect.element(screen.getByText(entry, { exact: true })).toBeVisible();
  const approval = screen.getByRole("checkbox", {
    name: /Also delete the ignored files and folders/,
  });
  await expect.element(approval).not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await approval.click();
  await expect.element(select).toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeEnabled();
  await approval.click();
  await expect.element(select).not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await approval.click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.remove.mock.calls.length).toBe(1);
  expect(api.worktrees.remove.mock.calls[0]?.[0]).toMatchObject({
    approvedIgnoredEntries: entries,
    deleteBranch: false,
    expectedHead: "abc",
  });
});

it.each(["local changes", "truncated"])(
  "keeps ignored approval from bypassing %s",
  async (condition) => {
    const truncated = condition === "truncated";
    const ignoredReason = truncated
      ? "too many ignored files to check"
      : "Ignored files and folders require explicit deletion confirmation.";
    api.worktrees.inspect.mockResolvedValue(
      inspection("feature", {
        blockedReasons: truncated ? [ignoredReason] : [ignoredReason, "it has uncommitted changes"],
        ignoredFiles: {
          entries: [".env"],
          truncated,
          requiresApproval: !truncated,
          canRemoveAfterApproval: false,
        },
      }),
    );
    const screen = await mount(
      <WorktreeRemovalDialog rows={[{ projectId, path: "/blocked" }]} onClose={vi.fn()} />,
    );
    await expect.element(screen.getByText(".env", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("checkbox", { name: "/blocked", exact: true }))
      .toBeDisabled();
    if (truncated)
      await expect.element(screen.getByText(/ignored-file list is incomplete/)).toBeVisible();
    else
      await expect
        .element(
          screen.getByRole("checkbox", { name: /Also delete the ignored files and folders/ }),
        )
        .toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
    expect(api.worktrees.remove).not.toHaveBeenCalled();
  },
);

it("refreshes a rejected approval and requires confirmation of the new list", async () => {
  const blockedReason = "Ignored files need review.";
  const inspected = (entries: string[], headSha: string) =>
    inspection("feature", {
      headSha,
      branchMerged: false,
      blockedReasons: [blockedReason],
      ignoredFiles: {
        entries,
        truncated: false,
        requiresApproval: true,
        canRemoveAfterApproval: true,
      },
    });
  api.worktrees.inspect
    .mockResolvedValueOnce(inspected([".env"], "old"))
    .mockResolvedValue(inspected([".env", ".env.local"], "fresh"));
  api.worktrees.remove
    .mockResolvedValueOnce({
      removed: false,
      branchDeleted: false,
      blockedReasons: ["Ignored files changed since review. Inspect this checkout again."],
    })
    .mockResolvedValue({ removed: true, branchDeleted: false, blockedReasons: [] });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/stale" }]} onClose={close} />,
  );
  const approval = screen.getByRole("checkbox", {
    name: /Also delete the ignored files and folders/,
  });
  await approval.click();
  await expect
    .element(screen.getByText("Ready to remove (ignored files will be deleted)", { exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.inspect.mock.calls.length).toBe(2);
  await expect.element(screen.getByText(".env.local", { exact: true })).toBeVisible();
  await expect.element(approval).not.toBeChecked();
  await expect
    .element(screen.getByRole("checkbox", { name: "/stale", exact: true }))
    .not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await expect
    .element(screen.getByText("Ready to remove (ignored files will be deleted)", { exact: true }))
    .not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  await approval.click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => api.worktrees.remove.mock.calls.length).toBe(2);
  expect(api.worktrees.remove.mock.calls[1]?.[0]).toMatchObject({
    expectedHead: "fresh",
    approvedIgnoredEntries: [".env", ".env.local"],
    deleteBranch: false,
  });
  await expect.poll(() => close.mock.calls.length).toBe(1);
});

it("offers inspection retry after rejection recovery fails without retaining old approval", async () => {
  const inspected = inspection("feature", {
    blockedReasons: ["Review ignored files."],
    ignoredFiles: {
      entries: [".env"],
      truncated: false,
      requiresApproval: true,
      canRemoveAfterApproval: true,
    },
  });
  api.worktrees.inspect
    .mockResolvedValueOnce(inspected)
    .mockRejectedValueOnce(new Error("Inspection temporarily unavailable"))
    .mockResolvedValue(inspected);
  api.worktrees.remove.mockRejectedValue(new Error("Removal rejected"));
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/retry" }]} onClose={vi.fn()} />,
  );
  await screen.getByRole("checkbox", { name: /Also delete the ignored files and folders/ }).click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Inspection temporarily unavailable");
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
  await expect
    .element(screen.getByRole("checkbox", { name: "/retry", exact: true }))
    .toBeDisabled();
  await screen.getByRole("button", { name: "Inspect again" }).click();
  await expect
    .element(screen.getByRole("checkbox", { name: /Also delete the ignored files and folders/ }))
    .not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeDisabled();
});

it("closes after every removal succeeds", async () => {
  api.worktrees.inspect.mockResolvedValue(inspection("feature"));
  api.worktrees.remove.mockResolvedValue({
    removed: true,
    branchDeleted: true,
    blockedReasons: [],
  });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog rows={[{ projectId, path: "/safe" }]} onClose={close} />,
  );
  await expect.element(screen.getByRole("button", { name: "Remove selected" })).toBeEnabled();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => close.mock.calls.length).toBe(1);
});
it("closes when selected removals succeed even when other rows are kept or blocked", async () => {
  api.worktrees.inspect.mockImplementation(async ({ path }: { path: string }) =>
    inspection(path, path === "/blocked" ? { blockedReasons: ["Protected files"] } : {}),
  );
  api.worktrees.remove.mockResolvedValue({
    removed: true,
    branchDeleted: false,
    blockedReasons: [],
  });
  const close = vi.fn();
  const screen = await mount(
    <WorktreeRemovalDialog
      rows={["/selected", "/kept", "/blocked"].map((path) => ({ projectId, path }))}
      onClose={close}
    />,
  );
  const kept = screen.getByRole("checkbox", { name: "/kept", exact: true });
  await expect.element(kept).toBeChecked();
  await kept.click();
  await screen.getByRole("button", { name: "Remove selected" }).click();
  await expect.poll(() => close.mock.calls.length).toBe(1);
  expect(api.worktrees.remove).toHaveBeenCalledOnce();
});
