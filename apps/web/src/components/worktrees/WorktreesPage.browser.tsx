import "../../index.css";
import { ProjectId, ThreadId, type WorktreeListEntry } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { WorktreesPage } from "./WorktreesPage";
import { useWorktreeRemovalDialogStore } from "../../worktreeRemovalDialogStore";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  inspect: vi.fn(),
  confirm: vi.fn(),
  navigate: vi.fn(),
  switchWorkspace: vi.fn(),
  newThread: vi.fn(),
  toast: vi.fn(),
  store: { projects: [{ id: "project", name: "Repository" }] },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    worktrees: { list: mocks.list, inspect: mocks.inspect },
    dialogs: { confirm: mocks.confirm },
  }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: mocks.newThread }),
}));
vi.mock("../../lib/workspaceTransitions", () => ({
  switchConversationWorkspace: mocks.switchWorkspace,
}));
vi.mock("../../store", () => ({
  useStore: Object.assign(
    (select: (s: { projects: { id: string; name: string }[] }) => unknown) => select(mocks.store),
    { getState: () => mocks.store },
  ),
}));
vi.mock("../../threadSelectors", () => ({
  useThreadSummaries: () => [
    { id: "current", projectId: "project", title: "Current conversation", archivedAt: null },
  ],
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const projectId = ProjectId.makeUnsafe("project");
const threadId = ThreadId.makeUnsafe("current");
const registration = (path: string, branch: string) => ({
  path,
  canonicalPath: path,
  branch,
  headSha: "base",
  bare: false,
  detached: false,
  locked: null,
  prunable: null,
  isMain: false,
});
const row = (
  path: string,
  branch: string,
  patch: Partial<WorktreeListEntry> = {},
): WorktreeListEntry => ({
  path,
  canonicalPath: path,
  branch,
  registration: registration(path, branch),
  classification: "managed",
  missing: false,
  locked: false,
  detached: false,
  hasChanges: false,
  linkedThreads: [],
  ...patch,
});
const linked = row("/managed/shared ", "topic", {
  hasChanges: true,
  linkedThreads: [
    { threadId: ThreadId.makeUnsafe("other"), title: "Archived review", archived: true },
  ],
});
let screen: Awaited<ReturnType<typeof render>> | undefined;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.store.projects = [{ id: "project", name: "Repository" }];
  useComposerDraftStore.setState({
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    draftsByThreadId: {},
  });
  mocks.list.mockResolvedValue({
    projects: [
      {
        projectId,
        name: "Repository",
        workspaceRoot: "/repo",
        error: null,
        entries: [
          row("/repo", "main", {
            classification: "projectCheckout",
            linkedThreads: [
              {
                threadId: ThreadId.makeUnsafe("local-other"),
                title: "Local conversation",
                archived: false,
              },
            ],
          }),
          linked,
          row("/external", "external", { classification: "external" }),
          row("/other-profile", "other", { classification: "otherProfile" }),
          row("/detached", "detached", { detached: true }),
          row("/managed/gone", "gone", { missing: true, hasChanges: null, registration: null }),
        ],
      },
    ],
  });
  mocks.inspect.mockResolvedValue({
    blockedReasons: ["Ignored .env must be kept"],
    branchDeletable: false,
    branchBlockedReason: "Conversation still references this branch",
    headSha: "base",
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await screen?.unmount();
  client.clear();
  useWorktreeRemovalDialogStore.setState({ requests: [] });
});
async function mount(selectedThread = threadId) {
  screen = await render(
    <QueryClientProvider client={client}>
      <WorktreesPage search={{ projectId, threadId: selectedThread }} onProjectChange={vi.fn()} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "Repository" })).toBeVisible();
}
it("searches paths and conversations, limits actions for inspect-only rows, and inspects on demand", async () => {
  await mount();
  expect(mocks.list).toHaveBeenCalledWith({ projectId });
  expect(mocks.inspect).not.toHaveBeenCalled();
  for (const name of [
    "external /external",
    "other /other-profile",
    "detached /detached",
    "main /repo",
  ]) {
    const article = page.getByRole("article", { name, exact: true });
    await expect.element(article.getByRole("button", { name: "Remove…" })).not.toBeInTheDocument();
    if (!name.startsWith("main"))
      await expect
        .element(article.getByRole("button", { name: "New conversation here" }))
        .not.toBeInTheDocument();
  }
  await expect.element(page.getByRole("button", { name: "Remove stale entry" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search worktrees" }).fill("Archived review");
  await expect.element(page.getByRole("article")).toHaveLength(1);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Ignored .env must be kept");
  expect(mocks.inspect).toHaveBeenCalledWith({ projectId, path: linked.path });
  await page.getByRole("button", { name: "Remove…" }).click();
  expect(useWorktreeRemovalDialogStore.getState().requests[0]?.rows).toEqual([
    { projectId, path: linked.path },
  ]);
});
it.each([["node_modules/"], ["dist/", ".env"]])(
  "shows ignored paths and directs confirmation to Remove (%j)",
  async (...entries) => {
    mocks.inspect.mockResolvedValue({
      blockedReasons: ["Ignored files require confirmation."],
      ignoredFiles: {
        entries,
        truncated: false,
        requiresApproval: true,
        canRemoveAfterApproval: true,
      },
      branchDeletable: false,
      branchBlockedReason: "Conversation still references this branch",
      headSha: "base",
    });
    await mount();
    await page.getByRole("textbox", { name: "Search worktrees" }).fill("topic");
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    for (const entry of entries)
      await expect.element(page.getByText(entry, { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(
        "Choose Remove… to review these paths and explicitly confirm their deletion.",
      );
    await page.getByRole("button", { name: "Remove…" }).click();
    expect(useWorktreeRemovalDialogStore.getState().requests[0]?.rows).toEqual([
      { projectId, path: linked.path },
    ]);
  },
);

it("requires shared-filesystem confirmation and uses a server transition for a persisted conversation", async () => {
  await mount();
  await page.getByRole("textbox", { name: "Search worktrees" }).fill("topic");
  mocks.confirm.mockResolvedValueOnce(false);
  await page.getByRole("button", { name: "Use for this conversation" }).click();
  expect(mocks.switchWorkspace).not.toHaveBeenCalled();
  mocks.confirm.mockResolvedValueOnce(true);
  mocks.switchWorkspace.mockResolvedValue({ phase: "completed" });
  await page.getByRole("button", { name: "Use for this conversation" }).click();
  await expect.poll(() => mocks.switchWorkspace.mock.calls.length).toBe(1);
  expect(mocks.switchWorkspace).toHaveBeenCalledWith(threadId, {
    intent: "attach_existing",
    targetPath: linked.path,
    branch: "topic",
    sharedFilesystemConfirmed: true,
  });
});
it("shows server failures and stops inventory work when unmounted", async () => {
  mocks.list.mockResolvedValue({
    projects: [
      {
        projectId,
        name: "Repository",
        workspaceRoot: "/repo",
        error: "Repository identity unreadable",
        entries: [],
      },
    ],
  });
  await mount();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Repository identity unreadable");
  await screen?.unmount();
  screen = undefined;
  await client.invalidateQueries({ queryKey: ["worktrees"] });
  expect(mocks.list).toHaveBeenCalledOnce();
});

it("keeps full paths and actions inside a narrow viewport", async () => {
  await page.viewport(375, 812);
  try {
    await mount();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const article = page.getByRole("article", { name: "topic /managed/shared" });
    await expect
      .element(article.getByRole("button", { name: "Copy path", exact: true }))
      .toBeVisible();
  } finally {
    await page.viewport(1280, 800);
  }
});

it("uses the project checkout for a worktree-mode draft instead of preparing a new worktree", async () => {
  const draftId = ThreadId.makeUnsafe("draft-current");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(projectId, draftId, { envMode: "worktree", branch: "topic" });
  await mount(draftId);
  await page
    .getByRole("article", { name: "main /repo", exact: true })
    .getByRole("button", { name: "Use for this conversation" })
    .click();
  await expect
    .poll(() => useComposerDraftStore.getState().getDraftThread(draftId))
    .toMatchObject({ envMode: "local", worktreePath: null, branch: "main" });
  expect(mocks.switchWorkspace).not.toHaveBeenCalled();
});
it("attaches a new draft to the selected worktree after confirming sharing", async () => {
  const draftId = ThreadId.makeUnsafe("new-draft");
  mocks.confirm.mockResolvedValue(true);
  mocks.newThread.mockImplementation(async () => {
    useComposerDraftStore.getState().setProjectDraftThreadId(projectId, draftId, {
      envMode: "worktree",
      branch: "topic",
      worktreePath: linked.path,
    });
    return { threadId: draftId };
  });
  await mount();
  await page
    .getByRole("article", { name: "topic /managed/shared" })
    .getByRole("button", { name: "New conversation here" })
    .click();
  await expect
    .poll(() => useComposerDraftStore.getState().getDraftThread(draftId))
    .toMatchObject({
      envMode: "worktree",
      branch: "topic",
      worktreePath: linked.path,
      sharedFilesystemConfirmed: true,
    });
  expect(mocks.newThread).toHaveBeenCalledWith(projectId, {
    branch: "topic",
    worktreePath: linked.path,
    envMode: "worktree",
    forceNonDefaultEnvMode: true,
  });
});
it("opens no draft when the project is removed while the sharing dialog is open", async () => {
  mocks.confirm.mockImplementation(async () => {
    mocks.store.projects = [];
    return true;
  });
  await mount();
  await page
    .getByRole("article", { name: "topic /managed/shared" })
    .getByRole("button", { name: "New conversation here" })
    .click();
  await expect.poll(() => mocks.confirm.mock.calls.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mocks.newThread).not.toHaveBeenCalled();
});
it("follows the conversation URL and clears the visible selection for another project", async () => {
  const draftId = ThreadId.makeUnsafe("draft-url");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(projectId, draftId, { envMode: "local", branch: "main" });
  await mount();
  await screen!.rerender(
    <QueryClientProvider client={client}>
      <WorktreesPage search={{ projectId, threadId: draftId }} onProjectChange={vi.fn()} />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByRole("combobox", { name: "Conversation to switch" }))
    .toHaveValue(draftId);
  await screen!.rerender(
    <QueryClientProvider client={client}>
      <WorktreesPage
        search={{ projectId: ProjectId.makeUnsafe("other-project"), threadId: draftId }}
        onProjectChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByRole("combobox", { name: "Conversation to switch" }))
    .toHaveValue("");
});

it("does not ask a local conversation to confirm the project checkout it already shares", async () => {
  await mount();
  await page
    .getByRole("article", { name: "main /repo", exact: true })
    .getByRole("button", { name: "Use for this conversation" })
    .click();
  await expect.poll(() => mocks.switchWorkspace.mock.calls.length).toBe(1);
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("still confirms shared project files when a draft leaves a different checkout", async () => {
  const draftId = ThreadId.makeUnsafe("shared-project-draft");
  useComposerDraftStore.getState().setProjectDraftThreadId(projectId, draftId, {
    envMode: "worktree",
    branch: "topic",
    worktreePath: "/managed/original",
  });
  mocks.confirm.mockResolvedValue(true);
  await mount(draftId);
  await page
    .getByRole("article", { name: "main /repo", exact: true })
    .getByRole("button", { name: "Use for this conversation" })
    .click();
  await expect
    .poll(() => useComposerDraftStore.getState().getDraftThread(draftId)?.envMode)
    .toBe("local");
  expect(mocks.confirm).toHaveBeenCalledOnce();
});
