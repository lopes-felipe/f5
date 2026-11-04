const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("../components/ui/toast", () => ({ toastManager: { add: toastAdd } }));
vi.mock("../lib/serverHttpOrigin", () => ({ getServerHttpOrigin: () => "http://localhost" }));

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetComposerDraftBaseStorageForTesting,
  setComposerDraftBaseStorageForTesting,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore } from "../store";
import type { Project } from "../types";
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

function makeDeps(overrides: Partial<SwitchDraftProjectDeps> = {}) {
  const navigateToThread = vi.fn(async (_threadId: ThreadId) => {});
  const createDraftThread = vi.fn(async (projectId: ProjectId) => {
    const threadId = projectId === TARGET_PROJECT ? TARGET_THREAD : SCRATCH_THREAD;
    if (!useComposerDraftStore.getState().getDraftThread(threadId)) openDraft(projectId, threadId);
    return { projectId, threadId };
  });
  const startScratchThread = vi.fn(async () => createDraftThread(SCRATCH_PROJECT));
  return {
    navigateToThread,
    createDraftThread,
    startScratchThread,
    ...overrides,
  };
}

const draftOf = (threadId: ThreadId) => useComposerDraftStore.getState().draftsByThreadId[threadId];

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
    });
    openDraft(SOURCE_PROJECT, SOURCE_THREAD);
    toastAdd.mockClear();
  });

  afterEach(() => {
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
    const outcome = await switchDraftProject(
      SOURCE_THREAD,
      { kind: "project", projectId: TARGET_PROJECT },
      deps,
    );
    expect(outcome).toBe("moved");
    expect(useComposerDraftStore.getState().promptStashes).toEqual([]);
    expect(deps.navigateToThread).toHaveBeenCalledWith(TARGET_THREAD);
    expect(useComposerDraftStore.getState().getDraftThread(SOURCE_THREAD)).toBeNull();
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

    const outcome = await switchDraftProject(
      SOURCE_THREAD,
      { kind: "project", projectId: TARGET_PROJECT },
      deps,
    );

    expect(outcome).toBe("moved");
    expect(draftOf(TARGET_THREAD)?.prompt).toBe("Fix the login redirect");
    expect(draftOf(TARGET_THREAD)?.model).toBe("claude-opus-5-5");
    // The source file is outside the target workspace.
    expect(draftOf(TARGET_THREAD)?.filePaths).toEqual([]);
    expect(draftOf(SOURCE_THREAD)).toBeUndefined();
    expect(useComposerDraftStore.getState().promptStashes).toEqual([]);
    expect(deps.navigateToThread).toHaveBeenCalledWith(TARGET_THREAD);
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", title: "Prompt moved to Target" }),
    );
  });

  it("keeps the prompt in the stash when the target already has a draft", async () => {
    openDraft(TARGET_PROJECT, TARGET_THREAD);
    useComposerDraftStore.getState().setPrompt(TARGET_THREAD, "Existing target draft");
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Moved prompt");
    const deps = makeDeps();

    const outcome = await switchDraftProject(
      SOURCE_THREAD,
      { kind: "project", projectId: TARGET_PROJECT },
      deps,
    );

    expect(outcome).toBe("stashed");
    expect(draftOf(TARGET_THREAD)?.prompt).toBe("Existing target draft");
    expect(useComposerDraftStore.getState().promptStashes.map((s) => s.draft.prompt)).toEqual([
      "Moved prompt",
    ]);
    expect(deps.navigateToThread).toHaveBeenCalledWith(TARGET_THREAD);
    expect(useComposerDraftStore.getState().getDraftThread(SOURCE_THREAD)).toBeNull();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "Prompt saved to the prompt stash" }),
    );
  });

  it("returns the prompt to the source draft when the target cannot be opened", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Do not lose me");
    const deps = makeDeps({ createDraftThread: vi.fn(async () => null) });

    const outcome = await switchDraftProject(
      SOURCE_THREAD,
      { kind: "project", projectId: TARGET_PROJECT },
      deps,
    );

    expect(outcome).toBe("failed");
    expect(draftOf(SOURCE_THREAD)?.prompt).toBe("Do not lose me");
    expect(useComposerDraftStore.getState().promptStashes).toEqual([]);
    expect(deps.navigateToThread).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not change project" }),
    );
  });

  it("uses the scratch path for No project", async () => {
    useComposerDraftStore.getState().setPrompt(SOURCE_THREAD, "Quick question");
    const deps = makeDeps();

    const outcome = await switchDraftProject(SOURCE_THREAD, { kind: "none" }, deps);

    expect(outcome).toBe("moved");
    expect(deps.startScratchThread).toHaveBeenCalledTimes(1);
    expect(deps.createDraftThread).toHaveBeenCalledWith(SCRATCH_PROJECT);
    expect(draftOf(SCRATCH_THREAD)?.prompt).toBe("Quick question");
    expect(deps.navigateToThread).toHaveBeenCalledWith(SCRATCH_THREAD);
  });

  it("treats No project as unchanged for a scratch draft", async () => {
    openDraft(SCRATCH_PROJECT, SCRATCH_THREAD);
    const deps = makeDeps();
    expect(await switchDraftProject(SCRATCH_THREAD, { kind: "none" }, deps)).toBe("unchanged");
    expect(deps.startScratchThread).not.toHaveBeenCalled();
  });
});
