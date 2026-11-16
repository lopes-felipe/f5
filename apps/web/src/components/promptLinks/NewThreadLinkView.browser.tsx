import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";

import { NewThreadLinkView } from "./NewThreadLinkView";

const api = vi.hoisted(() => ({
  projects: { findByRepository: vi.fn() },
  prHub: { getThreadsForPr: vi.fn(), peek: vi.fn() },
  git: {
    preparePullRequestThread: vi.fn(),
    resolvePullRequest: vi.fn(async (_input: unknown) => ({
      changeRequest: { isCrossRepository: false },
    })),
  },
  server: { getConfig: vi.fn(async () => ({ providers: [] })) },
  orchestration: { dispatchCommand: vi.fn(async (_command: unknown) => ({ sequence: 1 })) },
  nextTurnQueue: { submit: vi.fn() },
}));
const createDraftThread = vi.hoisted(() => vi.fn());
const startScratchThread = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn(async () => {}));
const openClone = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn() }));
const readiness = vi.hoisted(() => ({ startup: true, mutations: true }));
vi.mock("~/lib/startupReady", () => ({ useStartupReady: () => readiness.startup }));
vi.mock("~/wsConnectionState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/wsConnectionState")>()),
  useServerMutationsAvailable: () => readiness.mutations,
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("~/hooks/useCreateProjectBackedDraftThread", () => ({
  useCreateProjectBackedDraftThread: () => createDraftThread,
}));
vi.mock("~/hooks/useStartScratchThread", () => ({
  useStartScratchThread: () => startScratchThread,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("../ProjectCloneController", () => ({ openProjectCloneDialog: openClone }));
vi.mock("../ui/toast", () => ({ toastManager: toast }));
afterEach(() => {
  vi.clearAllMocks();
  readiness.startup = true;
  readiness.mutations = true;
  useComposerDraftStore.setState({ draftsByThreadId: {} });
});

const search = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;
const draftPrompt = (threadId: ThreadId) =>
  useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt;
const project = {
  projectId: ProjectId.makeUnsafe("project-f5"),
  title: "f5",
  workspaceRoot: "/code/f5",
};

it("puts a link without a repository in a new thread without a project and never sends it", async () => {
  const threadId = ThreadId.makeUnsafe("scratch-draft");
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  const hidden = String.fromCodePoint(0x200b);
  await render(<NewThreadLinkView search={search({ prompt: `Fix the${hidden} build` })} />);

  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Fix the build"));
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({ type: "warning", title: expect.stringContaining("hidden") }),
  );
  expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
  expect(api.nextTurnQueue.submit).not.toHaveBeenCalled();
});

it("waits for the server connection before opening a link on a cold start", async () => {
  readiness.mutations = false;
  const threadId = ThreadId.makeUnsafe("cold-start-draft");
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  const screen = await render(<NewThreadLinkView search={search({ prompt: "After sync" })} />);
  await expect.element(screen.getByText("Opening the link…")).toBeInTheDocument();
  expect(startScratchThread).not.toHaveBeenCalled();

  readiness.mutations = true;
  await screen.rerender(<NewThreadLinkView search={search({ prompt: "After sync" })} />);
  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("After sync"));
  expect(startScratchThread).toHaveBeenCalledTimes(1);
});

it("explains a link whose thread could not be created instead of waiting forever", async () => {
  startScratchThread.mockResolvedValueOnce(null);
  const screen = await render(<NewThreadLinkView search={search({ prompt: "Fix it" })} />);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("F5 could not create a thread for this prompt.");
});

it("still places the prompt when the link names a malformed provider", async () => {
  const threadId = ThreadId.makeUnsafe("malformed-provider-draft");
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  await render(
    <NewThreadLinkView search={search({ prompt: "Fix the build", provider: "foo.bar" })} />,
  );

  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Fix the build"));
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({
      description: expect.stringContaining("foo.bar, which is not set up"),
    }),
  );
});

const codexWithModel = (slug: string) => ({
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      models: [{ slug, name: slug, isCustom: false }],
    },
  ],
});

it("changes neither the draft nor its model when the user keeps an existing draft", async () => {
  const threadId = ThreadId.makeUnsafe("existing-draft");
  useComposerDraftStore.getState().setPrompt(threadId, "My own draft");
  const before = useComposerDraftStore.getState().draftsByThreadId[threadId];
  api.server.getConfig.mockResolvedValueOnce(codexWithModel("gpt-linked") as never);
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  await render(
    <NewThreadLinkView
      search={search({ prompt: "Linked", provider: "codex", model: "gpt-linked" })}
    />,
  );

  await vi.waitFor(() =>
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Linked prompt ready" }),
    ),
  );
  // Dismissing the question leaves the user's draft as it was, model included.
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toEqual(before);

  const replace = (
    toast.add.mock.calls as unknown as Array<[{ actionProps?: { onClick: () => void } }]>
  ).find(([options]) => options.actionProps)![0].actionProps!;
  replace.onClick();
  const after = useComposerDraftStore.getState().draftsByThreadId[threadId];
  expect(after).toMatchObject({ prompt: "Linked", provider: "codex", model: "gpt-linked" });
});

it("uses the provider's default model when the link names one it does not offer", async () => {
  const threadId = ThreadId.makeUnsafe("unknown-model-draft");
  api.server.getConfig.mockResolvedValueOnce(codexWithModel("gpt-offered") as never);
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  await render(
    <NewThreadLinkView
      search={search({ prompt: "Fix it", provider: "codex", model: "anything-the-link-says" })}
    />,
  );

  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Fix it"));
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  expect(draft?.provider).toBe("codex");
  expect(draft?.model).not.toBe("anything-the-link-says");
  expect(toast.add).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("does not offer here") }),
  );
});

it("drops a lookup that finishes after a newer link arrived", async () => {
  let finishLookup: (projects: (typeof project)[]) => void = () => {};
  api.projects.findByRepository.mockReturnValueOnce(
    new Promise((resolve) => (finishLookup = resolve)),
  );
  const threadId = ThreadId.makeUnsafe("newer-link-draft");
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  const screen = await render(
    <NewThreadLinkView search={search({ prompt: "Old", repo: "lopes-felipe/f5" })} />,
  );
  await vi.waitFor(() => expect(api.projects.findByRepository).toHaveBeenCalled());

  await screen.rerender(<NewThreadLinkView search={search({ prompt: "New" })} />);
  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("New"));
  finishLookup([project]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(createDraftThread).not.toHaveBeenCalled();
});

it("handles the same link again when it is opened again, for example after cloning", async () => {
  const link = search({ prompt: "Add tests", repo: "octo/tools" });
  api.projects.findByRepository.mockResolvedValueOnce([]);
  const screen = await render(<NewThreadLinkView search={link} delivery="first" />);
  await expect
    .element(screen.getByRole("button", { name: "Clone https://github.com/octo/tools" }))
    .toBeInTheDocument();

  const threadId = ThreadId.makeUnsafe("after-clone-draft");
  api.projects.findByRepository.mockResolvedValueOnce([project]);
  createDraftThread.mockResolvedValueOnce({ threadId, projectId: project.projectId });
  await screen.rerender(<NewThreadLinkView search={link} delivery="second" />);
  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Add tests"));
  expect(createDraftThread).toHaveBeenCalledWith(project.projectId, expect.anything());
});

it("opens a link in the project whose remote matches its repository", async () => {
  const threadId = ThreadId.makeUnsafe("project-draft");
  api.projects.findByRepository.mockResolvedValueOnce([project]);
  createDraftThread.mockResolvedValueOnce({ threadId, projectId: project.projectId });
  await render(
    <NewThreadLinkView search={search({ prompt: "Add tests", repo: "lopes-felipe/f5" })} />,
  );

  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Add tests"));
  expect(api.projects.findByRepository).toHaveBeenCalledWith({ owner: "lopes-felipe", name: "f5" });
  // The draft is filled before it opens: opening it leaves this view.
  const [, options] = createDraftThread.mock.calls[0]!;
  expect(options.canNavigate()).toBe(false);
  expect(navigate).toHaveBeenCalledWith({ to: "/$threadId", params: { threadId } });
  expect(startScratchThread).not.toHaveBeenCalled();
});

it("offers to clone a repository no project uses, or to go on without a project", async () => {
  const threadId = ThreadId.makeUnsafe("fallback-draft");
  api.projects.findByRepository.mockResolvedValueOnce([]);
  startScratchThread.mockResolvedValueOnce({ threadId, projectId: "scratch" });
  const screen = await render(
    <NewThreadLinkView search={search({ prompt: "Add tests", repo: "octo/tools" })} />,
  );

  await screen.getByRole("button", { name: "Clone https://github.com/octo/tools" }).click();
  expect(openClone).toHaveBeenCalledWith("", "https://github.com/octo/tools");
  expect(createDraftThread).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Use without a project" }).click();
  await vi.waitFor(() => expect(draftPrompt(threadId)).toBe("Add tests"));
});

it("checks out a pull request in a new worktree only after the user confirms", async () => {
  api.prHub.getThreadsForPr.mockResolvedValueOnce([]);
  api.projects.findByRepository.mockResolvedValueOnce([project]);
  api.prHub.peek.mockResolvedValueOnce({ title: "Speed up search" });
  api.git.preparePullRequestThread.mockResolvedValueOnce({
    pullRequest: { title: "Speed up search" },
    branch: "pr-42",
    worktreePath: "/code/f5-worktrees/pr-42",
  });
  const screen = await render(
    <NewThreadLinkView search={search({ pr: "lopes-felipe/f5#42", prompt: "Review it" })} />,
  );

  const confirm = screen.getByRole("button", { name: "Check out in a new worktree" });
  await expect.element(confirm).toBeInTheDocument();
  expect(api.prHub.getThreadsForPr).toHaveBeenCalledWith({
    key: "github:github.com/lopes-felipe/f5#42",
  });
  expect(api.git.preparePullRequestThread).not.toHaveBeenCalled();

  await confirm.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(api.git.preparePullRequestThread).toHaveBeenCalledWith({
    cwd: "/code/f5",
    reference: "https://github.com/lopes-felipe/f5/pull/42",
    mode: "worktree",
    runSetupScript: false,
  });
  const command = api.orchestration.dispatchCommand.mock.calls[0]![0] as {
    type: string;
    threadId: ThreadId;
    worktreePath: string;
    pullRequest: { number: number };
  };
  expect(command).toMatchObject({
    type: "thread.create",
    worktreePath: "/code/f5-worktrees/pr-42",
    pullRequest: { number: 42 },
  });
  expect(draftPrompt(command.threadId)).toBe("Review it");
  expect(api.nextTurnQueue.submit).not.toHaveBeenCalled();
});

it("reports a failed thread lookup instead of opening a second thread for the pull request", async () => {
  api.prHub.getThreadsForPr.mockRejectedValueOnce(new Error("PR hub is unavailable"));
  const screen = await render(<NewThreadLinkView search={search({ pr: "lopes-felipe/f5#42" })} />);

  await expect.element(screen.getByRole("alert")).toHaveTextContent("PR hub is unavailable");
  expect(api.projects.findByRepository).not.toHaveBeenCalled();
  expect(api.git.preparePullRequestThread).not.toHaveBeenCalled();
});

it("prepares no worktree when it cannot read the server configuration", async () => {
  api.prHub.getThreadsForPr.mockResolvedValueOnce([]);
  api.projects.findByRepository.mockResolvedValueOnce([project]);
  api.server.getConfig.mockRejectedValueOnce(new Error("Server unavailable"));
  const screen = await render(<NewThreadLinkView search={search({ pr: "lopes-felipe/f5#42" })} />);

  await screen.getByRole("button", { name: "Check out in a new worktree" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Server unavailable");
  expect(api.git.preparePullRequestThread).not.toHaveBeenCalled();
});

it("refuses to check out a pull request from a fork", async () => {
  api.prHub.getThreadsForPr.mockResolvedValueOnce([]);
  api.projects.findByRepository.mockResolvedValueOnce([project]);
  api.git.resolvePullRequest.mockResolvedValueOnce({ changeRequest: { isCrossRepository: true } });
  const screen = await render(
    <NewThreadLinkView search={search({ pr: "lopes-felipe/f5#42", prompt: "Review it" })} />,
  );

  await expect.element(screen.getByRole("alert")).toHaveTextContent("comes from a fork");
  expect(api.git.resolvePullRequest).toHaveBeenCalledWith({
    cwd: "/code/f5",
    reference: "https://github.com/lopes-felipe/f5/pull/42",
  });
  expect(screen.getByRole("button", { name: "Check out in a new worktree" }).query()).toBeNull();
  expect(api.git.preparePullRequestThread).not.toHaveBeenCalled();
});

it("opens the thread a pull request already has instead of checking it out again", async () => {
  const threadId = ThreadId.makeUnsafe("pr-thread");
  api.prHub.getThreadsForPr.mockResolvedValueOnce([{ threadId, title: "PR #42" }]);
  await render(<NewThreadLinkView search={search({ pr: "lopes-felipe/f5#42" })} />);

  await vi.waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({ to: "/$threadId", params: { threadId } }),
  );
  expect(api.git.preparePullRequestThread).not.toHaveBeenCalled();
});

it("explains a link it cannot open", async () => {
  const screen = await render(<NewThreadLinkView search={search({ repo: "octo/tools" })} />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("This link has no prompt.");
  expect(startScratchThread).not.toHaveBeenCalled();
});
