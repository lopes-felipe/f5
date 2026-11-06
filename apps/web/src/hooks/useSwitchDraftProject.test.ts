const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("../components/ui/toast", () => ({ toastManager: { add: toastAdd } }));
vi.mock("../lib/serverHttpOrigin", () => ({ getServerHttpOrigin: () => "http://localhost" }));

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createComposerMention } from "../composer-editor-mentions";
import {
  resetComposerDraftBaseStorageForTesting,
  setComposerDraftBaseStorageForTesting,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore } from "../store";
import type { Project } from "../types";
import type { CreateProjectBackedDraftThreadResult } from "./useCreateProjectBackedDraftThread";
import { type SwitchDraftProjectDeps, switchDraftProject } from "./useSwitchDraftProject";

const SOURCE_PROJECT = ProjectId.makeUnsafe("project-source");
const TARGET_PROJECT = ProjectId.makeUnsafe("project-target");
const SCRATCH_PROJECT = ProjectId.makeUnsafe("project-scratch");
const SOURCE_THREAD = ThreadId.makeUnsafe("thread-source");
const TARGET_THREAD = ThreadId.makeUnsafe("thread-target");
const SCRATCH_THREAD = ThreadId.makeUnsafe("thread-scratch");

function makeProject(id: ProjectId, name: string, cwd: string, kind?: "scratch"): Project {
  return {
    id,
    name,
    cwd,
    model: "gpt-5.1",
    createdAt: "2026-11-01T00:00:00.000Z",
    expanded: true,
    scripts: [],
    memories: [],
    ...(kind ? { kind } : {}),
  };
}

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

function openDraft(projectId: ProjectId, threadId: ThreadId) {
  useComposerDraftStore.getState().setProjectDraftThreadId(projectId, threadId, {
    createdAt: "2026-11-04T00:00:00.000Z",
    envMode: "local",
    runtimeMode: "full-access",
  });
}

function openTargetDraft(projectId: ProjectId): CreateProjectBackedDraftThreadResult {
  const threadId = projectId === TARGET_PROJECT ? TARGET_THREAD : SCRATCH_THREAD;
  if (!useComposerDraftStore.getState().getDraftThread(threadId)) openDraft(projectId, threadId);
  return { projectId, threadId };
}

function makeDeps(overrides: Partial<SwitchDraftProjectDeps> = {}) {
  const createDraftThread = vi.fn(async (projectId: ProjectId) => openTargetDraft(projectId));
  return {
    navigateToThread: vi.fn(async (_threadId: ThreadId) => {}),
    isViewingThread: vi.fn((threadId: ThreadId) => threadId === SOURCE_THREAD),
    createDraftThread,
    startScratchThread: vi.fn(async () => createDraftThread(SCRATCH_PROJECT)),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const draftOf = (threadId: ThreadId) => useComposerDraftStore.getState().draftsByThreadId[threadId];
const draftThreadOf = (threadId: ThreadId) =>
  useComposerDraftStore.getState().getDraftThread(threadId);
const stashedPrompts = () =>
  useComposerDraftStore.getState().promptStashes.map((stash) => stash.draft.prompt);
const toTarget = { kind: "project", projectId: TARGET_PROJECT } as const;

describe("switchDraftProject", () => {
  beforeEach(() => {
    setComposerDraftBaseStorageForTesting(createMockStorage());
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      promptStashes: [],
    });
    useStore.setState({
      projects: [
        makeProject(SOURCE_PROJECT, "Source", "/repo/source"),
        makeProject(TARGET_PROJECT, "Target", "/repo/target"),
        makeProject(SCRATCH_PROJECT, "Scratch", "/scratch", "scratch"),
      ],
      threads: [],
    });
    openDraft(SOURCE_PROJECT, SOURCE_THREAD);
    toastAdd.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetComposerDraftBaseStorageForTesting();
  });

  it("does nothing when the draft is already in the selected project", async () => {
    const deps = makeDeps();
    const outcome = await switchDraftProject(
      SOURCE_THREAD,
      { kind: "project", projectId: SOURCE_PROJECT },
      deps,
    );
    expect(outcome).toBe("unchanged");
    expect(deps.createDraftThread).not.toHaveBeenCalled();
    expect(deps.navigateToThread).not.toHaveBeenCalled();
  });

  it("switches an empty draft without stashing and drops the source draft", async () => {
    const deps = makeDeps();
    expect(await switchDraftProject(SOURCE_THREAD, toTarget, deps)).toBe("moved");
    expect(stashedPrompts()).toEqual([]);
    expect(deps.navigateToThread).toHaveBeenCalledWith(TARGET_THREAD);
    expect(draftThreadOf(SOURCE_THREAD)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(SOURCE_PROJECT, {
        envMode: "local",
        worktreePath: null,
      }),
    ).toBeNull();
  });

  it("moves the typed prompt into the target draft and keeps the target's model", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(SOURCE_THREAD, "Fix the login redirect");
    store.addFilePaths(SOURCE_THREAD, ["/repo/source/src/login.ts"]);
    store.setModel(SOURCE_THREAD, "gpt-5.1");
    const deps = makeDeps({
      createDraftThread: vi.fn(async (projectId: ProjectId) => {
        openDraft(projectId, TARGET_THREAD);
        useComposerDraftStore.getState().setProvider(TARGET_THREAD, "claudeAgent");
        useComposerDraftStore.getState().setModel(TARGET_THREAD, "claude-opus-5-5");
        return { projectId, threadId: TARGET_THREAD };
      }),
    });

    expect(await switchDraftProject(SOURCE_THREAD, toTarget, deps)).toBe("moved");

    expect(draftOf(TARGET_THREAD)?.prompt).toBe("Fix the login redirect");
    expect(draftOf(TARGET_THREAD)?.model).toBe("claude-opus-5-5");
    // The source file is outside the target workspace.
    expect(draftOf(TARGET_THREAD)?.filePaths).toEqual([]);
    expect(draftOf(SOURCE_THREAD)).toBeUndefined();
    expect(stashedPrompts()).toEqual([]);
    expect(deps.navigateToThread).toHaveBeenCalledWith(TARGET_THREAD);
    const [toast] = toastAdd.mock.calls.at(-1)!;
    expect(toast).toMatchObject({ type: "warning", title: "Prompt moved to Target" });
    // Re-authorization is expected when moving; only the loss is reported.
    expect(toast.description).toContain("omitted because it is outside this workspace");
    expect(toast.description).not.toContain("re-authorized");
  });

  it("turns mentions into plain text when the workspace changes", async () => {
    const prompt = "Look at @src/login.ts please";
    useComposerDraftStore
      .getState()
      .setPrompt(SOURCE_THREAD, prompt, [createComposerMention("src/login.ts", 8)]);
    expect(draftOf(SOURCE_THREAD)?.mentions).toHaveLength(1);

    expect(await switchDraftProject(SOURCE_THREAD, toTarget, makeDeps())).toBe("moved");

    expect(draftOf(TARGET_THREAD)?.prompt).toBe(prompt);
    expect(draftOf(TARGET_THREAD)?.mentions).toEqual([]);
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: expect.stringContaining("1 file mention was kept as plain text"),
      }),
    );
  });

  it("turns mentions into plain text when moving to No project", async () => {
    useComposerDraftStore
      .getState()
      .setPrompt(SOURCE_THREAD, "@src/a.ts ", [createComposerMention("src/a.ts", 0)]);

    expect(await switchDraftProject(SOURCE_THREAD, { kind: "none" }, makeDeps())).toBe("moved");

    expect(draftOf(SCRATCH_THREAD)?.prompt).toBe("@src/a.ts ");
    expect(draftOf(SCRATCH_THREAD)?.mentions).toEqual([]);
  });

  it("leaves the source composer untouched while the target is opening", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "First");
    const opening = deferred<CreateProjectBackedDraftThreadResult>();
    const deps = makeDeps({ createDraftThread: vi.fn(() => opening.promise) });

    const switching = switchDraftProject(SOURCE_THREAD, toTarget, deps);
    await Promise.resolve();
    expect(draftOf(SOURCE_THREAD)?.prompt).toBe("First");
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "First, then more");
    opening.resolve(openTargetDraft(TARGET_PROJECT));

    expect(await switching).toBe("moved");
    expect(draftOf(TARGET_THREAD)?.prompt).toBe("First, then more");
    expect(draftOf(SOURCE_THREAD)).toBeUndefined();
    expect(stashedPrompts()).toEqual([]);
  });

  it("keeps the source composer when opening the target fails", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Do not lose me");
    const opening = deferred<CreateProjectBackedDraftThreadResult | null>();
    const deps = makeDeps({ createDraftThread: vi.fn(() => opening.promise) });

    const switching = switchDraftProject(SOURCE_THREAD, toTarget, deps);
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Do not lose me, or this");
    opening.resolve(null);

    expect(await switching).toBe("failed");
    expect(draftOf(SOURCE_THREAD)?.prompt).toBe("Do not lose me, or this");
    expect(stashedPrompts()).toEqual([]);
    expect(deps.navigateToThread).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledTimes(1);
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not change project",
        description: "The project is no longer available.",
      }),
    );
  });

  it("stays put and moves the draft when the user navigated away meanwhile", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Moved in the background");
    const deps = makeDeps({ isViewingThread: vi.fn(() => false) });

    expect(await switchDraftProject(SOURCE_THREAD, toTarget, deps)).toBe("moved");

    expect(deps.navigateToThread).not.toHaveBeenCalled();
    expect(draftOf(TARGET_THREAD)?.prompt).toBe("Moved in the background");
    const [toast] = toastAdd.mock.calls.at(-1)!;
    expect(toast).toMatchObject({ type: "info", title: "Draft moved to Target" });
    toast.actionProps.onClick();
    expect(deps.navigateToThread).toHaveBeenCalledWith(TARGET_THREAD);
  });

  it("does not move a draft that was sent while the target was opening", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Sent already");
    const deps = makeDeps({
      createDraftThread: vi.fn(async (projectId: ProjectId) => {
        // A send promotes the draft into a server thread meanwhile.
        useStore.setState({
          threads: [{ id: SOURCE_THREAD, projectId: SOURCE_PROJECT } as never],
        });
        return openTargetDraft(projectId);
      }),
    });

    expect(await switchDraftProject(SOURCE_THREAD, toTarget, deps)).toBe("unchanged");
    expect(draftOf(SOURCE_THREAD)?.prompt).toBe("Sent already");
    expect(draftThreadOf(TARGET_THREAD)).toBeNull();
    expect(deps.navigateToThread).not.toHaveBeenCalled();
  });

  it("does nothing when a stale mapping resolves the target to the source thread", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Stay here");
    const deps = makeDeps({
      createDraftThread: vi.fn(async (projectId: ProjectId) => ({
        projectId,
        threadId: SOURCE_THREAD,
      })),
    });

    expect(await switchDraftProject(SOURCE_THREAD, toTarget, deps)).toBe("unchanged");
    expect(draftOf(SOURCE_THREAD)?.prompt).toBe("Stay here");
    expect(stashedPrompts()).toEqual([]);
  });

  it("keeps the prompt in the stash when the target already has a draft", async () => {
    openDraft(TARGET_PROJECT, TARGET_THREAD);
    useComposerDraftStore.getState().setPrompt(TARGET_THREAD, "Existing target draft");
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Moved prompt");
    const deps = makeDeps();

    expect(await switchDraftProject(SOURCE_THREAD, toTarget, deps)).toBe("stashed");

    expect(draftOf(TARGET_THREAD)?.prompt).toBe("Existing target draft");
    expect(stashedPrompts()).toEqual(["Moved prompt"]);
    expect(deps.navigateToThread).toHaveBeenCalledWith(TARGET_THREAD);
    expect(draftThreadOf(SOURCE_THREAD)).toBeNull();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "Prompt saved to the prompt stash" }),
    );
  });

  it("returns the prompt to the source and drops the empty target when restoring fails", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Bring me back");
    const restore = useComposerDraftStore.getState().restorePromptStash;
    useComposerDraftStore.setState({
      restorePromptStash: vi.fn(async (input) =>
        input.threadId === TARGET_THREAD
          ? { status: "failed" as const, message: "Images could not be restored." }
          : restore(input),
      ),
    });

    expect(await switchDraftProject(SOURCE_THREAD, toTarget, makeDeps())).toBe("failed");

    expect(draftOf(SOURCE_THREAD)?.prompt).toBe("Bring me back");
    expect(stashedPrompts()).toEqual([]);
    expect(draftThreadOf(TARGET_THREAD)).toBeNull();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Images could not be restored.",
      }),
    );
    useComposerDraftStore.setState({ restorePromptStash: restore });
  });

  it("uses the scratch path for No project", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Quick question");
    const deps = makeDeps();

    expect(await switchDraftProject(SOURCE_THREAD, { kind: "none" }, deps)).toBe("moved");

    expect(deps.startScratchThread).toHaveBeenCalledTimes(1);
    expect(deps.createDraftThread).toHaveBeenCalledWith(SCRATCH_PROJECT);
    expect(draftOf(SCRATCH_THREAD)?.prompt).toBe("Quick question");
    expect(deps.navigateToThread).toHaveBeenCalledWith(SCRATCH_THREAD);
  });

  it("leaves the error toast to the scratch path when it fails", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Keep me");
    const deps = makeDeps({ startScratchThread: vi.fn(async () => null) });

    expect(await switchDraftProject(SOURCE_THREAD, { kind: "none" }, deps)).toBe("failed");
    expect(toastAdd).not.toHaveBeenCalled();
    expect(draftOf(SOURCE_THREAD)?.prompt).toBe("Keep me");
  });

  it("treats No project as unchanged for a scratch draft", async () => {
    openDraft(SCRATCH_PROJECT, SCRATCH_THREAD);
    const deps = makeDeps();
    expect(await switchDraftProject(SCRATCH_THREAD, { kind: "none" }, deps)).toBe("unchanged");
    expect(deps.startScratchThread).not.toHaveBeenCalled();
  });
});
