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
  },
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

const linked = (...ids: string[]) =>
  ids.map((id) => ({ threadId: ThreadId.makeUnsafe(id), title: `Thread ${id}`, archived: false }));

beforeEach(() => {
  vi.clearAllMocks();
  api.git.listBranches.mockResolvedValue({
    isRepo: true,
    hasOriginRemote: false,
    branches: [
      { name: "fix/sidebar", current: true, isDefault: false, worktreePath: "/repo" },
      { name: "main", current: false, isDefault: true, worktreePath: null },
      { name: "fix/route", current: false, isDefault: false, worktreePath: "/wt/route" },
    ],
  });
  api.git.status.mockResolvedValue({ branch: "fix/sidebar" });
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
    });
    expect(api.git.checkout).not.toHaveBeenCalled();
    expect(api.git.prepareWorktree).not.toHaveBeenCalled();
    expect(page.getByRole("dialog").elements()).toHaveLength(0);
  });

  it("joins an open worktree, its thread count standing in for the sharing confirmation", async () => {
    await open();
    await option(/fix\/route.*1 thread there/).click();
    expect(onDraftChange).toHaveBeenCalledWith({
      envMode: "worktree",
      branch: "fix/route",
      worktreePath: "/wt/route",
      sharedFilesystemConfirmed: true,
    });
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
    expect(
      useComposerDraftStore.getState().getDraftThread(threadId)?.worktreeBranchName,
    ).toBeFalsy();
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

  it("explains a missing worktree and offers no in-place switch", async () => {
    api.git.listBranches.mockResolvedValue({
      isRepo: false,
      hasOriginRemote: false,
      branches: [],
      worktreeMissing: true,
    });
    api.git.status.mockRejectedValue(new Error("missing"));
    await open(
      {
        isDraft: false,
        activeWorktreePath: "/wt/gone",
        activeThreadBranch: "gone",
        branchCwd: "/wt/gone",
        effectiveEnvMode: "worktree",
      },
      "gone · missing",
    );
    await expect
      .element(page.getByText("Worktree missing. Send a message to recreate it on gone."))
      .toBeVisible();
    await expect.element(option("Switch branch here…")).not.toBeInTheDocument();
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
