import { rememberDraftSettings } from "../lib/draftSettingsDefaults";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useModelPreferencesStore } from "../modelPreferencesStore";
import { useStore } from "../store";
import { seedDraftThreadFromModelPreferences } from "./useHandleNewThread";
import { createProjectBackedDraftThread } from "./useCreateProjectBackedDraftThread";

const settingsApi = vi.hoisted(() => ({ getProjectSettings: vi.fn() }));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ server: settingsApi }) }));
beforeEach(() => {
  settingsApi.getProjectSettings
    .mockReset()
    .mockResolvedValue({ settings: DEFAULT_SERVER_SETTINGS });
});

const NOW_ISO = "2026-04-22T12:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-new-thread");
const navigate = async () => undefined;

describe("seedDraftThreadFromModelPreferences", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useModelPreferencesStore.setState({
      lastProvider: null,
      lastModelByProvider: {},
      lastModelOptions: null,
      lastWorkflowProviderBySlot: {},
    });
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          name: "Project",
          cwd: "/repo/project",
          model: "gpt-5.4",
          createdAt: NOW_ISO,
          expanded: true,
          scripts: [],
          memories: [],
          skills: [],
        },
      ],
      threads: [],
    });
  });

  it("uses an explicit project default before remembered models", () => {
    useStore.setState({
      projects: useStore
        .getState()
        .projects.map((project) => ({ ...project, defaultModel: "gpt-5.4-mini" })),
    });
    useModelPreferencesStore.setState({
      lastProvider: "claudeAgent",
      lastModelByProvider: { claudeAgent: "claude-opus-4-6" },
    });
    const threadId = ThreadId.makeUnsafe("project-default");
    seedDraftThreadFromModelPreferences(threadId, PROJECT_ID);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("seeds Claude and preserves an explicit project account", () => {
    const threadId = ThreadId.makeUnsafe("claude-project");
    useStore.setState({
      projects: useStore
        .getState()
        .projects.map((project) => ({ ...project, defaultModel: "claude-opus-4-6" })),
    });
    seedDraftThreadFromModelPreferences(threadId, PROJECT_ID);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.provider).toBe(
      "claudeAgent",
    );
    useStore.setState({
      projects: useStore.getState().projects.map((project) => ({
        ...project,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.makeUnsafe("claude-work"),
          model: "claude-opus-4-6",
          options: [{ id: "effort", value: "max" }],
        },
      })),
    });
    seedDraftThreadFromModelPreferences(threadId, PROJECT_ID);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      provider: "claudeAgent",
      providerInstanceId: "claude-work",
      model: "claude-opus-4-6",
    });
  });
  it("hydrates a fresh draft thread from remembered provider, model, and options", () => {
    const threadId = ThreadId.makeUnsafe("thread-pref-seed");
    useModelPreferencesStore.setState({
      lastProvider: "claudeAgent",
      lastModelByProvider: {
        codex: "gpt-5.4-mini",
        claudeAgent: "claude-opus-4-6",
      },
      lastModelOptions: {
        claudeAgent: {
          effort: "max",
        },
      },
    });

    seedDraftThreadFromModelPreferences(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "max",
        },
      },
    });
  });

  it("does not create a composer draft when no remembered preferences exist", () => {
    const threadId = ThreadId.makeUnsafe("thread-pref-empty");

    seedDraftThreadFromModelPreferences(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("preserves remembered Claude fast mode for Opus 4.6 drafts", () => {
    const threadId = ThreadId.makeUnsafe("thread-pref-fast-mode");
    useModelPreferencesStore.setState({
      lastProvider: "claudeAgent",
      lastModelByProvider: {
        claudeAgent: "claude-opus-4-6",
      },
      lastModelOptions: {
        claudeAgent: {
          effort: "max",
          fastMode: true,
        },
      },
    });

    seedDraftThreadFromModelPreferences(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "max",
          fastMode: true,
        },
      },
    });
  });
});

describe("createProjectBackedDraftThread", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useModelPreferencesStore.setState({
      lastProvider: null,
      lastModelByProvider: {},
      lastModelOptions: null,
      lastWorkflowProviderBySlot: {},
    });
  });

  it("reuses one draft for concurrent clicks after the settings request", async () => {
    let finish!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      finish = resolve;
    });
    settingsApi.getProjectSettings.mockReturnValue(response);
    const input = {
      navigate,
      onboardingLiteStatus: "completed" as const,
      projectId: PROJECT_ID,
      routeThreadId: null,
      updateSettings: vi.fn(),
    };
    const one = createProjectBackedDraftThread(input);
    const two = createProjectBackedDraftThread(input);
    finish({ settings: DEFAULT_SERVER_SETTINGS });
    const [a, b] = await Promise.all([one, two]);
    expect(a.threadId).toBe(b.threadId);
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)).toHaveLength(1);
  });
  it("creates a draft with the last safe project mode when settings fail", async () => {
    rememberDraftSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" },
      PROJECT_ID,
    );
    rememberDraftSettings(DEFAULT_SERVER_SETTINGS);
    settingsApi.getProjectSettings.mockRejectedValue(new Error("Disconnected"));
    const result = await createProjectBackedDraftThread({
      navigate,
      onboardingLiteStatus: "completed",
      projectId: PROJECT_ID,
      routeThreadId: null,
      updateSettings: vi.fn(),
    });
    expect(useComposerDraftStore.getState().getDraftThread(result.threadId)?.runtimeMode).toBe(
      "approval-required",
    );
  });
  it("marks onboarding complete when the shared new-thread flow creates the first draft thread", async () => {
    const updateSettings = vi.fn();

    await createProjectBackedDraftThread({
      navigate,
      onboardingLiteStatus: "eligible",
      projectId: PROJECT_ID,
      routeThreadId: null,
      updateSettings,
    });

    const draftThread = useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID);
    expect(draftThread).not.toBeNull();
    expect(updateSettings).toHaveBeenCalledWith({ onboardingLiteStatus: "completed" });
  });

  it("creates worktree drafts when only worktreePath is provided", async () => {
    await createProjectBackedDraftThread({
      navigate,
      onboardingLiteStatus: "completed",
      options: { worktreePath: "/tmp/project-new-thread-worktree" },
      projectId: PROJECT_ID,
      routeThreadId: null,
      updateSettings: vi.fn(),
    });

    const draftThread = useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, {
      envMode: "worktree",
      worktreePath: "/tmp/project-new-thread-worktree",
    });
    expect(draftThread).toMatchObject({
      projectId: PROJECT_ID,
      worktreePath: "/tmp/project-new-thread-worktree",
      envMode: "worktree",
    });
  });

  it("marks onboarding complete for the sidebar entry path too", async () => {
    const updateSettings = vi.fn();
    const routeThreadId = ThreadId.makeUnsafe("sidebar-active-draft");
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, routeThreadId, {
      createdAt: NOW_ISO,
    });

    await createProjectBackedDraftThread({
      navigate,
      onboardingLiteStatus: "dismissed",
      projectId: PROJECT_ID,
      routeThreadId,
      updateSettings,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID)?.threadId).toBe(
      routeThreadId,
    );
    expect(updateSettings).toHaveBeenCalledWith({ onboardingLiteStatus: "completed" });
  });
});
