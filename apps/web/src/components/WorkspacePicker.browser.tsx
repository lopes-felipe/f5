import "../index.css";

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useWorktreeRemovalDialogStore } from "../worktreeRemovalDialogStore";
import { WsRequestError } from "../wsTransport";
import { WorkspacePicker, type WorkspacePickerProps } from "./WorkspacePicker";

const api = vi.hoisted(() => ({
  git: {
    listBranches: vi.fn(),
    status: vi.fn(),
    checkout: vi.fn(),
    createBranch: vi.fn(),
    prepareWorktree: vi.fn(),
  },
  worktrees: {
    list: vi.fn(),
    switchAvailability: vi.fn(),
    getTransition: vi.fn(),
    discardMovedChanges: vi.fn(),
    recover: vi.fn(),
  },
  nextTurnQueue: { list: vi.fn() },
  shell: { openInEditor: vi.fn(), openExternal: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  copy: vi.fn(),
  editor: vi.fn(),
  switchWorkspace: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../appSettings", () => {
  const settings = { gitStatusAutoRefreshIntervalSeconds: 0 };
  return {
    useAppSettings: () => ({ settings }),
    useAppSettingsSelector: <T,>(selector: (value: typeof settings) => T) => selector(settings),
  };
});
vi.mock("../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.copy }));
vi.mock("../editorPreferences", () => ({ openInPreferredEditor: mocks.editor }));
vi.mock("../lib/workspaceTransitions", () => ({
  switchConversationWorkspace: mocks.switchWorkspace,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const threadId = ThreadId.makeUnsafe("picker");
const projectId = ProjectId.makeUnsafe("project");
const onSetThreadBranch = vi.fn();
const onDraftChange = vi.fn();
let screen: Awaited<ReturnType<typeof render>> | undefined;
let client: QueryClient;
/** The branch each worktree folder is on; the project folder is on fix/sidebar. */
const checkouts = new Map<string, string>();

const linked = (...ids: string[]) =>
  ids.map((id) => ({ threadId: ThreadId.makeUnsafe(id), title: `Thread ${id}`, archived: false }));

beforeEach(() => {
  vi.clearAllMocks();
  // Git answers per checkout: the trigger shows the branch its folder is on.
  checkouts.clear();
  checkouts.set("/wt/route", "fix/route");
  const head = (cwd: string) => checkouts.get(cwd) ?? "fix/sidebar";
  api.git.listBranches.mockImplementation(async ({ cwd }: { cwd: string }) => ({
    isRepo: true,
    hasOriginRemote: false,
    branches: [
      { name: "fix/sidebar", isDefault: false, worktreePath: "/repo" },
      { name: "main", isDefault: true, worktreePath: null },
      { name: "fix/route", isDefault: false, worktreePath: "/wt/route" },
      ...(["fix/sidebar", "fix/route"].includes(head(cwd))
        ? []
        : [{ name: head(cwd), isDefault: false, worktreePath: cwd }]),
    ].map((branch) => ({ ...branch, current: branch.name === head(cwd) })),
  }));
  api.git.status.mockImplementation(async ({ cwd }: { cwd: string }) => ({ branch: head(cwd) }));
  api.git.checkout.mockResolvedValue(undefined);
  api.worktrees.list.mockResolvedValue({
    projects: [
      {
        projectId,
        name: "f5",
        workspaceRoot: "/repo",
        error: null,
        entries: [
          { path: "/repo", canonicalPath: "/repo", linkedThreads: linked("a", "b", "c") },
          { path: "/wt/route", canonicalPath: "/wt/route", linkedThreads: linked("d") },
        ],
      },
    ],
  });
  api.worktrees.switchAvailability.mockResolvedValue({ blockers: [] });
  api.worktrees.getTransition.mockResolvedValue(null);
  mocks.switchWorkspace.mockResolvedValue({ phase: "completed" });
  useComposerDraftStore.setState({
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  useWorktreeRemovalDialogStore.setState({ requests: [] });
});
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  client?.clear();
});

const picker = (overrides: Partial<WorkspacePickerProps> = {}) => (
  <QueryClientProvider client={client}>
    <WorkspacePicker
      threadId={threadId}
      projectId={projectId}
      projectCwd="/repo"
      hasSetupScript={false}
      isDraft
      creatingWorktree={false}
      multiModel={false}
      activeThreadBranch={null}
      activeWorktreePath={null}
      branchCwd="/repo"
      effectiveEnvMode="local"
      workspaceVersion="null"
      canApplyWorkspace={() => true}
      canMove={false}
      moveDisabled={false}
      onSetThreadBranch={onSetThreadBranch}
      onDraftChange={onDraftChange}
      {...overrides}
    />
  </QueryClientProvider>
);

async function open(overrides: Partial<WorkspacePickerProps> = {}, label = "Local · fix/sidebar") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (overrides.activeWorktreePath && overrides.activeThreadBranch)
    checkouts.set(overrides.activeWorktreePath, overrides.activeThreadBranch);
  screen = await render(picker(overrides));
  const trigger = page.getByLabelText(`Workspace: ${label}`, { exact: true });
  await trigger.click();
  return trigger;
}

const option = (name: string | RegExp) => page.getByRole("option", { name });

describe("drafts", () => {
  it("starts a new worktree from the default branch with no dialog and no Git call", async () => {
    await open();
    await expect.element(option(/Local · fix\/sidebar.*3 threads here/)).toBeVisible();
    await option(/^main\s*default/).click();
    expect(onDraftChange).toHaveBeenCalledWith({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      sharedFilesystemConfirmed: false,
      worktreeBranchName: null,
    });
    expect(api.git.checkout).not.toHaveBeenCalled();
    expect(api.git.prepareWorktree).not.toHaveBeenCalled();
    expect(page.getByRole("dialog").elements()).toHaveLength(0);
  });

  it("joins an open worktree, its thread count standing in for the sharing confirmation", async () => {
    await open();
    await option(/fix\/route.*1 thread there/).click();
    await expect
      .poll(() => onDraftChange.mock.calls)
      .toEqual([
        [
          {
            envMode: "worktree",
            branch: "fix/route",
            worktreePath: "/wt/route",
            sharedFilesystemConfirmed: true,
            worktreeBranchName: null,
          },
        ],
      ]);
    expect(api.dialogs.confirm).not.toHaveBeenCalled();
  });

  it("names a new branch for the worktree from a typed query, keeping the chosen base", async () => {
    await open(
      { effectiveEnvMode: "worktree", activeThreadBranch: "fix/sidebar" },
      "New worktree · from fix/sidebar",
    );
    await page.getByPlaceholder("Search branches and worktrees…").fill("feature/login");
    await option(/New worktree on new branch "feature\/login"/).click();
    expect(onDraftChange).toHaveBeenCalledWith({
      envMode: "worktree",
      branch: "fix/sidebar",
      worktreePath: null,
      sharedFilesystemConfirmed: false,
      worktreeBranchName: "feature/login",
    });
  });

  it("returns a new-worktree draft to Local", async () => {
    await open(
      { effectiveEnvMode: "worktree", activeThreadBranch: "main" },
      "New worktree · from main",
    );
    await expect.element(option(/^main\s*default/)).toHaveAttribute("aria-selected", "true");
    await option(/Local · fix\/sidebar/).click();
    expect(onDraftChange).toHaveBeenCalledWith({
      envMode: "local",
      branch: "fix/sidebar",
      worktreePath: null,
      sharedFilesystemConfirmed: false,
      worktreeBranchName: null,
    });
  });

  it("edits the new worktree's branch name and setup script in the footer", async () => {
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(projectId, threadId, { envMode: "worktree", branch: "main" });
    await open(
      { effectiveEnvMode: "worktree", activeThreadBranch: "main", hasSetupScript: true },
      "New worktree · from main",
    );
    const name = page.getByRole("textbox", { name: "Branch name" });
    await name.fill("bad name");
    await expect.element(page.getByRole("alert")).toHaveTextContent("cannot contain spaces");
    // Kept as typed, so send is rejected by the server instead of creating "bad".
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBranchName).toBe(
      "bad name",
    );
    await name.fill("feature/named");
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBranchName).toBe(
      "feature/named",
    );
    await name.fill("");
    expect(
      useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBranchName,
    ).toBeNull();
    await page.getByRole("checkbox", { name: "Run setup script" }).click();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.runSetupScript).toBe(false);
  });

  it("disables naming for a fan-out send", async () => {
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(projectId, threadId, { envMode: "worktree", branch: "main" });
    await open(
      { effectiveEnvMode: "worktree", activeThreadBranch: "main", multiModel: true },
      "New worktree · from main",
    );
    await expect.element(page.getByRole("textbox", { name: "Branch name" })).toBeDisabled();
    await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("switching the branch in place", () => {
  it("switches Local's branch when nothing live uses it", async () => {
    await open();
    await option("Switch branch here…").click();
    await expect
      .poll(() => api.worktrees.switchAvailability.mock.calls)
      .toEqual([[{ projectId, path: "/repo" }]]);
    await option(/^main$/).click();
    await expect
      .poll(() => api.git.checkout.mock.calls)
      .toEqual([[{ cwd: "/repo", branch: "main" }]]);
    await expect.poll(() => onSetThreadBranch.mock.calls).toEqual([["main", null]]);
  });

  it("disables the switch and names who is using the folder", async () => {
    api.worktrees.switchAvailability.mockResolvedValue({
      blockers: [{ kind: "turn", threadId: "t-1", title: "Review PR 719" }],
    });
    await open();
    await option("Switch branch here…").click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("In use by Review PR 719 (running turn). Start a new worktree instead.");
    await expect.element(option(/^main$/)).toHaveAttribute("aria-disabled", "true");
    await option("Back").click();
    await expect.element(option(/^main\s*default/)).toBeVisible();
  });

  it("offers a lazy new worktree when Git reports files that would be overwritten", async () => {
    api.git.checkout.mockRejectedValue(
      new WsRequestError("Blocked", "GitCheckoutConflict", {
        cwd: "/repo",
        branch: "main",
        files: ["index.css"],
      }),
    );
    await open();
    await option("Switch branch here…").click();
    await option(/^main$/).click();
    await expect
      .element(page.getByRole("heading", { name: "Local changes block branch switch" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Start in a new worktree" }).click();
    expect(onDraftChange).toHaveBeenCalledWith({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      sharedFilesystemConfirmed: false,
      worktreeBranchName: null,
    });
    expect(api.git.prepareWorktree).not.toHaveBeenCalled();
  });

  it("uses the workspace transition for a started thread", async () => {
    await open({ isDraft: false });
    await option("Switch branch here…").click();
    await expect
      .poll(() => api.worktrees.switchAvailability.mock.calls)
      .toEqual([[{ projectId, path: "/repo", threadId }]]);
    await page.getByPlaceholder("Search branches…").fill("topic");
    await option('Create branch "topic" here').click();
    await expect
      .poll(() => mocks.switchWorkspace.mock.calls)
      .toEqual([[threadId, { intent: "create_branch_and_checkout", branch: "topic" }]]);
    expect(api.git.createBranch).not.toHaveBeenCalled();
  });
});

describe("started threads and managing worktrees", () => {
  it("moves a started worktree thread back to Local, confirming the shared folder", async () => {
    await open(
      {
        isDraft: false,
        activeWorktreePath: "/wt/route",
        activeThreadBranch: "fix/route",
        branchCwd: "/wt/route",
        effectiveEnvMode: "worktree",
      },
      "fix/route",
    );
    await expect.element(option(/^main/)).not.toBeInTheDocument();
    await option(/Local · fix\/sidebar/).click();
    expect(onSetThreadBranch).toHaveBeenCalledWith(null, null, true);
  });

  it("acts on the current checkout from the header and the Manage group", async () => {
    const terminal = vi.fn();
    mocks.copy.mockResolvedValue(undefined);
    api.shell.openInEditor.mockResolvedValue(undefined);
    const trigger = await open(
      {
        activeWorktreePath: "/wt/route",
        activeThreadBranch: "fix/route",
        branchCwd: "/wt/route",
        effectiveEnvMode: "worktree",
        onOpenTerminal: terminal,
      },
      "fix/route",
    );
    await page.getByRole("button", { name: "Copy path" }).click();
    expect(mocks.copy).toHaveBeenCalledWith("/wt/route");
    await trigger.click();
    await page.getByRole("button", { name: "Reveal" }).click();
    expect(api.shell.openInEditor).toHaveBeenCalledWith("/wt/route", "file-manager");
    await trigger.click();
    await page.getByRole("button", { name: "Open terminal here" }).click();
    expect(terminal).toHaveBeenCalledOnce();
    await trigger.click();
    await option("Remove worktree…").click();
    expect(useWorktreeRemovalDialogStore.getState().requests[0]?.rows).toEqual([
      { projectId, path: "/wt/route" },
    ]);
    await trigger.click();
    await option("Manage worktrees…").click();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/worktrees",
      search: { projectId, threadId },
    });
  });

  describe("long worktree paths", () => {
    const root =
      "/Users/someone/.f5/userdata-profiles/1e371049feb34fafbb0e46fccbeb6912/worktrees/f5-3fb59513056d";
    const branch = "refactor/wave-2c-marketing-refresh-with-an-unusually-long-branch-name";
    let restoreViewport: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await restoreViewport?.();
      restoreViewport = undefined;
    });

    async function openAt(width: number, path: string) {
      const previous = { width: window.innerWidth, height: window.innerHeight };
      restoreViewport = () => page.viewport(previous.width, previous.height);
      await page.viewport(width, 800);
      mockWorktree(path);
      await open(
        {
          activeWorktreePath: path,
          activeThreadBranch: branch,
          branchCwd: path,
          effectiveEnvMode: "worktree",
        },
        branch,
      );
      await expect.element(option(/Local · fix\/sidebar.*3 threads here/)).toBeVisible();
      const frame = document
        .querySelector<HTMLElement>('[data-slot="combobox-frame"]')!
        .getBoundingClientRect();
      const header = document.querySelector<HTMLElement>('[data-slot="workspace-path"]')!;
      return {
        popup: document.querySelector<HTMLElement>('[data-slot="combobox-popup"]')!,
        frame,
        header,
        head: header.querySelector<HTMLElement>('[data-slot="middle-truncate-head"]')!,
        tail: header.querySelector<HTMLElement>('[data-slot="middle-truncate-tail"]')!,
        copy: page.getByRole("button", { name: "Copy path" }).element().getBoundingClientRect(),
        within: (element: Element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= frame.left - 0.5 && rect.right <= frame.right + 0.5;
        },
      };
    }

    it("keeps the popup's content inside its frame and the folder name visible", async () => {
      const path = `${root}/t3code-57b01760-355254f9`;
      const { popup, frame, header, head, tail, copy, within } = await openAt(1280, path);
      expect(popup.getBoundingClientRect().width).toBeLessThanOrEqual(frame.width + 0.5);
      expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
      expect(copy.right).toBeLessThanOrEqual(frame.right + 0.5);
      expect(within(page.getByPlaceholder("Search branches and worktrees…").element())).toBe(true);
      expect(within(page.getByText("3 threads here").element())).toBe(true);

      expect(header.title).toBe(path);
      expect(header.textContent).toBe(path);
      // The middle truncates; the folder name stays whole at the visible end.
      expect(head.scrollWidth).toBeGreaterThan(head.clientWidth);
      expect(tail.textContent).toBe("/t3code-57b01760-355254f9");
      expect(tail.scrollWidth).toBeLessThanOrEqual(tail.clientWidth);
      expect(tail.getBoundingClientRect().right).toBeLessThanOrEqual(copy.left + 0.5);
    });

    it("clips a maximum-length folder name before the header buttons on a phone", async () => {
      // allocateWorktreePath: slug(branch).slice(0, 32) + "-" + 8 hex = 41 characters.
      const path = `${root}/refactor-wave-2c-marketing-refre-57b01760`;
      const { popup, header, tail, copy } = await openAt(390, path);
      expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
      expect(tail.getBoundingClientRect().right).toBeLessThanOrEqual(copy.left + 0.5);
      expect(header.getBoundingClientRect().right).toBeLessThanOrEqual(copy.left + 0.5);
    });
  });

  function mockWorktree(path: string) {
    const branch = "refactor/wave-2c-marketing-refresh-with-an-unusually-long-branch-name";
    api.git.listBranches.mockResolvedValue({
      isRepo: true,
      hasOriginRemote: false,
      branches: [
        { name: "fix/sidebar", current: true, isDefault: false, worktreePath: "/repo" },
        { name: "main", current: false, isDefault: true, worktreePath: null },
        { name: branch, current: false, isDefault: false, worktreePath: path },
      ],
    });
    api.worktrees.list.mockResolvedValue({
      projects: [
        {
          projectId,
          name: "f5",
          workspaceRoot: "/repo",
          error: null,
          entries: [
            { path: "/repo", canonicalPath: "/repo", linkedThreads: linked("a", "b", "c") },
            { path, canonicalPath: path, linkedThreads: linked("d") },
          ],
        },
      ],
    });
  }

  it("disables moving a local conversation while its turn runs", async () => {
    await open({ isDraft: false, canMove: true, moveDisabled: true });
    await expect
      .element(option("Move to a new worktree…"))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("loads a completed move on open and discards its originals through the server", async () => {
    api.worktrees.getTransition.mockResolvedValue({
      operationId: "done-move",
      intent: "move_to_new_worktree",
      phase: "completed",
      source: { path: "/repo" },
      target: { path: "/wt/route", branch: "fix/route" },
      move: { copiedFileCount: 2, discarded: false },
    });
    api.worktrees.discardMovedChanges.mockResolvedValue({ discarded: true });
    api.dialogs.confirm.mockResolvedValue(true);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    screen = await render(
      picker({
        isDraft: false,
        activeWorktreePath: "/wt/route",
        activeThreadBranch: "fix/route",
        branchCwd: "/wt/route",
        effectiveEnvMode: "worktree",
      }),
    );
    expect(api.worktrees.getTransition).not.toHaveBeenCalled();
    await page.getByLabelText("Workspace: fix/route", { exact: true }).click();
    await option("Discard originals from move…").click();
    await expect
      .poll(() => api.worktrees.discardMovedChanges.mock.calls)
      .toEqual([[{ threadId, operationId: "done-move" }]]);
  });

  it("says a worktree that is not on disk restores on send, and restores it now when asked", async () => {
    api.git.listBranches.mockResolvedValue({
      isRepo: false,
      hasOriginRemote: false,
      branches: [],
      worktreeMissing: true,
    });
    api.git.status.mockRejectedValue(new Error("missing"));
    api.worktrees.recover.mockResolvedValue({
      kind: "ready",
      location: "worktree",
      path: "/wt/gone",
      branch: "gone",
    });
    api.nextTurnQueue.list.mockResolvedValue({ threadId, items: [], workspace: null });
    await open(
      {
        isDraft: false,
        activeWorktreePath: "/wt/gone",
        activeThreadBranch: "gone",
        branchCwd: "/wt/gone",
        effectiveEnvMode: "worktree",
      },
      "gone · restores on send",
    );
    await expect
      .element(
        page.getByText("This worktree is not on disk. Your next message restores it on gone."),
      )
      .toBeVisible();
    await expect.element(option("Switch branch here…")).not.toBeInTheDocument();
    await option("Restore worktree now").click();
    await expect
      .poll(() => api.worktrees.recover.mock.calls)
      .toEqual([[{ threadId, action: "restore" }]]);
  });

  it("does not call a restore failed because the queue could not be read afterwards", async () => {
    api.git.listBranches.mockResolvedValue({
      isRepo: false,
      hasOriginRemote: false,
      branches: [],
      worktreeMissing: true,
    });
    api.git.status.mockRejectedValue(new Error("missing"));
    api.worktrees.recover.mockResolvedValue({
      kind: "ready",
      location: "worktree",
      path: "/wt/gone",
      branch: "gone",
    });
    api.nextTurnQueue.list.mockRejectedValue(new Error("offline"));
    await open(
      {
        isDraft: false,
        activeWorktreePath: "/wt/gone",
        activeThreadBranch: "gone",
        branchCwd: "/wt/gone",
        effectiveEnvMode: "worktree",
      },
      "gone · restores on send",
    );
    const refreshed = vi.spyOn(client, "invalidateQueries");
    await option("Restore worktree now").click();
    await expect.poll(() => api.nextTurnQueue.list.mock.calls.length).toBeGreaterThan(0);
    // The worktree is back, so what shows it refreshes and nothing reports a failure.
    await expect
      .poll(() => refreshed.mock.calls.map(([filters]) => filters?.queryKey))
      .toEqual(expect.arrayContaining([["worktrees"], ["git"]]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("names the worktree being created instead of the branch it starts from", async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    screen = await render(
      picker({ isDraft: false, creatingWorktree: true, activeThreadBranch: "main" }),
    );
    await expect
      .element(page.getByLabelText("Workspace: Creating worktree…", { exact: true }))
      .toBeVisible();
  });
});

describe("keyboard", () => {
  it("opens from the keyboard and picks with Enter", async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    screen = await render(picker());
    const trigger = page.getByLabelText("Workspace: Local · fix/sidebar", { exact: true });
    await expect.element(trigger).toBeEnabled();
    (trigger.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    await page.getByPlaceholder("Search branches and worktrees…").fill("main");
    await expect.element(option(/^main\s*default/)).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => onDraftChange.mock.calls.at(-1)?.[0]?.branch).toBe("main");
  });
});

describe("review follow-ups", () => {
  const settle = () =>
    new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

  it("switches to the typed branch on Enter instead of going Back", async () => {
    await open();
    await option("Switch branch here…").click();
    await expect.poll(() => api.worktrees.switchAvailability.mock.calls.length).toBe(1);
    await page.getByPlaceholder("Search branches…").fill("main");
    await expect.element(option("Back")).not.toBeInTheDocument();
    await expect.element(option(/^main$/)).toBeEnabled();
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => api.git.checkout.mock.calls)
      .toEqual([[{ cwd: "/repo", branch: "main" }]]);
  });

  it("reads thread counts before applying a pick made while they are still loading", async () => {
    let resolveList!: (value: unknown) => void;
    const inventory = await api.worktrees.list();
    api.worktrees.list.mockImplementation(
      () =>
        new Promise((done) => {
          resolveList = done;
        }),
    );
    await open();
    await option(/^fix\/route/).click();
    await settle();
    expect(onDraftChange).not.toHaveBeenCalled();
    resolveList(inventory);
    await expect
      .poll(() => onDraftChange.mock.calls.at(-1)?.[0])
      .toMatchObject({ worktreePath: "/wt/route", sharedFilesystemConfirmed: true });
  });

  it("offers a separate worktree when the checkout became busy after the check", async () => {
    api.git.checkout.mockRejectedValue(
      new WsRequestError(
        "In use by Review (running turn). Start a new worktree instead.",
        "WorkspaceRequiresNewWorktree",
      ),
    );
    await open();
    await option("Switch branch here…").click();
    await option(/^main$/).click();
    await expect
      .element(page.getByRole("heading", { name: "Open branch in a separate worktree" }))
      .toBeVisible();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("creates a draft's branch through the atomic switch and reports a failure as such", async () => {
    api.git.checkout.mockRejectedValue(new Error("fatal: invalid ref"));
    await open();
    await option("Switch branch here…").click();
    await page.getByPlaceholder("Search branches…").fill("topic");
    await option(/Create branch "topic" here/).click();
    await expect
      .poll(() => api.git.checkout.mock.calls)
      .toEqual([[{ cwd: "/repo", branch: "topic", create: true }]]);
    expect(api.git.createBranch).not.toHaveBeenCalled();
    await expect
      .poll(() => mocks.toast.mock.calls.at(-1)?.[0])
      .toMatchObject({ type: "error", title: "Failed to create branch." });
  });

  it("closes an open popup when the send lock turns on", async () => {
    await open();
    await expect.element(page.getByPlaceholder("Search branches and worktrees…")).toBeVisible();
    await screen!.rerender(picker({ disabled: true }));
    await expect
      .element(page.getByPlaceholder("Search branches and worktrees…"))
      .not.toBeInTheDocument();
  });

  it("checks the live store before applying a switch that resolves late", async () => {
    let current = true;
    let finish!: () => void;
    api.git.checkout.mockImplementation(
      () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    );
    await open({ canApplyWorkspace: () => current });
    await option("Switch branch here…").click();
    await option(/^main$/).click();
    await expect.poll(() => api.git.checkout.mock.calls.length).toBe(1);
    current = false;
    finish();
    await settle();
    expect(onSetThreadBranch).not.toHaveBeenCalled();
  });

  it("keeps the remote ref as the base of the new worktree a conflict offers", async () => {
    api.git.listBranches.mockResolvedValue({
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        { name: "fix/sidebar", current: true, isDefault: false, worktreePath: "/repo" },
        {
          name: "origin/feature",
          current: false,
          isDefault: false,
          isRemote: true,
          remoteName: "origin",
          worktreePath: null,
        },
      ],
    });
    api.git.checkout.mockRejectedValue(
      new WsRequestError("Blocked", "GitCheckoutConflict", {
        cwd: "/repo",
        branch: "origin/feature",
        files: ["index.css"],
      }),
    );
    await open();
    await option("Switch branch here…").click();
    await expect.poll(() => api.worktrees.switchAvailability.mock.calls.length).toBe(1);
    await page.getByPlaceholder("Search branches…").fill("origin/feature");
    await expect
      .element(page.getByRole("option").filter({ hasText: "origin/feature" }))
      .toBeEnabled();
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => api.git.checkout.mock.calls)
      .toEqual([[{ cwd: "/repo", branch: "origin/feature" }]]);
    await page.getByRole("button", { name: "Start in a new worktree" }).click();
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ envMode: "worktree", branch: "origin/feature" }),
    );
  });

  it("returns focus to the trigger after Escape", async () => {
    const trigger = await open();
    await expect.element(page.getByPlaceholder("Search branches and worktrees…")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger, { timeout: 1000 }).toHaveFocus();
  });

  it("shows the change request of the branch the thread works on, not the folder's", async () => {
    api.git.status.mockResolvedValue({
      branch: "fix/sidebar",
      changeRequest: {
        provider: { kind: "github", host: "github.com" },
        id: "1",
        displayNumber: "#77",
        title: "Sidebar",
        url: "https://github.com/o/f5/pull/77",
        baseRefName: "main",
        headRefName: "fix/sidebar",
        state: "open",
        updatedAt: null,
        isCrossRepository: false,
      },
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    screen = await render(picker());
    await expect.element(page.getByLabelText("Open change request #77")).toBeVisible();
    await screen.rerender(picker({ effectiveEnvMode: "worktree", activeThreadBranch: "main" }));
    await expect.element(page.getByLabelText("Open change request #77")).not.toBeInTheDocument();
  });
});
