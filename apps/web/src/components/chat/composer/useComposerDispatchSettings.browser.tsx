import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { AppSettingsSchema } from "~/appSettings";
import { type ComposerThreadDraftState, useComposerDraftStore } from "~/composerDraftStore";
import { resetProtocolStateForTests, setServerBootstrap } from "~/protocolState";
import { serverBootstrapFixture } from "~/test/serverBootstrap";
import { resetThreadModelOptionsSeedsForTests } from "~/threadModelOptionsSeeds";
import type { Thread } from "~/types";

import {
  type ComposerDispatchSettingsInput,
  useComposerDispatchSettings,
} from "./useComposerDispatchSettings";

const THREAD_ID = ThreadId.makeUnsafe("thread-dispatch");
const NOW = "2026-11-14T12:00:00.000Z";
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX_ID = defaultInstanceIdForDriver(CODEX);
const CLAUDE_ID = defaultInstanceIdForDriver(CLAUDE);
const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");

function provider(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

const CODEX_PROVIDER = provider(CODEX, CODEX_ID, ["gpt-5.4", "gpt-5.4-mini"]);
const CLAUDE_PROVIDER = provider(CLAUDE, CLAUDE_ID, ["claude-opus-4-6"]);
const PROVIDERS = [CODEX_PROVIDER, CLAUDE_PROVIDER];

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Dispatch",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: NOW,
    archivedAt: null,
    lastInteractionAt: NOW,
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    compaction: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

/** A thread with a live Codex session: it has started. */
const STARTED_ON_CODEX = thread({
  session: {
    provider: "codex",
    providerInstanceId: CODEX_ID,
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    orchestrationStatus: "ready",
  },
});

const HIGH_EFFORT: ModelSelection = {
  instanceId: CODEX_ID,
  model: "gpt-5.4",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const EMPTY_DRAFT: ComposerDispatchSettingsInput["composerDraft"] = {
  provider: null,
  providerInstanceId: null,
  model: null,
  modelOptions: null,
};

function input(
  overrides: Partial<ComposerDispatchSettingsInput> = {},
): ComposerDispatchSettingsInput {
  const providerStatuses = overrides.providerStatuses ?? PROVIDERS;
  return {
    threadId: THREAD_ID,
    composerDraft: EMPTY_DRAFT,
    serverThread: undefined,
    localDraftThread: undefined,
    project: undefined,
    providerStatuses,
    serverConfig: { providers: [...providerStatuses], settings: DEFAULT_SERVER_SETTINGS },
    settings: AppSettingsSchema.makeUnsafe({}),
    modelCatalogSettings: DEFAULT_UNIFIED_SETTINGS,
    seedsModelOptions: true,
    ...overrides,
  };
}

/** The hook over an input whose draft follows the composer draft store, as ChatView's does. */
async function mount(overrides: Partial<ComposerDispatchSettingsInput> = {}) {
  const base = input(overrides);
  return renderHook(() => {
    const stored = useComposerDraftStore((store) => store.draftsByThreadId[THREAD_ID]) as
      | Partial<ComposerThreadDraftState>
      | undefined;
    return useComposerDispatchSettings({
      ...base,
      composerDraft: {
        ...base.composerDraft,
        modelOptions: stored?.modelOptions ?? base.composerDraft.modelOptions,
      },
    });
  });
}

function seededOptions() {
  return useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelOptions ?? null;
}

describe("useComposerDispatchSettings", () => {
  beforeEach(() => {
    setServerBootstrap(serverBootstrapFixture);
    resetThreadModelOptionsSeedsForTests();
    useComposerDraftStore.setState({ draftsByThreadId: {} });
  });

  afterEach(() => {
    resetProtocolStateForTests();
    vi.restoreAllMocks();
  });

  it("starts a new thread on the draft's instance and model", async () => {
    const hook = await mount({
      localDraftThread: thread(),
      composerDraft: {
        ...EMPTY_DRAFT,
        providerInstanceId: CLAUDE_ID,
        model: "claude-opus-4-6",
      },
    });
    expect(hook.result.current).toMatchObject({
      hasThreadStarted: false,
      providerLocked: false,
      noProviderAvailable: false,
      selectedProvider: "claudeAgent",
      selectedProviderInstanceId: CLAUDE_ID,
      selectedModel: "claude-opus-4-6",
    });
    expect(hook.result.current.selectedModelSelectionForDispatch).toMatchObject({
      instanceId: CLAUDE_ID,
      model: "claude-opus-4-6",
    });
  });

  it("keeps a started thread on its session's provider when the server cannot hand it off", async () => {
    const hook = await mount({
      serverThread: STARTED_ON_CODEX,
      // The picker cannot offer it, but a stale draft may still name another instance.
      composerDraft: { ...EMPTY_DRAFT, provider: "claudeAgent", providerInstanceId: CLAUDE_ID },
    });
    expect(hook.result.current).toMatchObject({
      hasThreadStarted: true,
      providerContextHandoff: false,
      providerLocked: true,
      lockedProvider: "codex",
      sessionInstanceId: CODEX_ID,
      selectedProvider: "codex",
      selectedProviderInstanceId: CODEX_ID,
      selectedModel: "gpt-5.4",
    });
  });

  it("lets a started thread switch providers when the server hands the conversation off", async () => {
    setServerBootstrap({
      ...serverBootstrapFixture,
      capabilities: [...serverBootstrapFixture.capabilities, "provider-context-handoff"],
    });
    const hook = await mount({
      serverThread: STARTED_ON_CODEX,
      composerDraft: {
        ...EMPTY_DRAFT,
        provider: "claudeAgent",
        providerInstanceId: CLAUDE_ID,
        model: "claude-opus-4-6",
      },
    });
    expect(hook.result.current).toMatchObject({
      hasThreadStarted: true,
      providerContextHandoff: true,
      providerLocked: false,
      lockedProvider: null,
      // The session is still Codex's: a send naming Claude switches providers.
      sessionInstanceId: CODEX_ID,
      requestedInstanceId: CLAUDE_ID,
      selectedProvider: "claudeAgent",
      selectedProviderInstanceId: CLAUDE_ID,
      selectedModel: "claude-opus-4-6",
    });
  });

  it("falls back to another instance of the same driver and keeps the draft's model", async () => {
    const providerStatuses = [
      CODEX_PROVIDER,
      provider(CODEX, CODEX_WORK_ID, ["gpt-5.4", "gpt-5.4-mini"], { enabled: false }),
      CLAUDE_PROVIDER,
    ];
    const hook = await mount({
      localDraftThread: thread(),
      providerStatuses,
      composerDraft: {
        ...EMPTY_DRAFT,
        provider: "codex",
        providerInstanceId: CODEX_WORK_ID,
        model: "gpt-5.4-mini",
      },
    });
    expect(hook.result.current).toMatchObject({
      requestedInstanceId: CODEX_WORK_ID,
      noProviderAvailable: false,
      selectedProvider: "codex",
      selectedProviderInstanceId: CODEX_ID,
      selectedModel: "gpt-5.4-mini",
    });
  });

  it("takes the instance's own model when the requested instance is gone", async () => {
    const hook = await mount({
      localDraftThread: thread(),
      // No snapshot for the requested instance, and its model belongs to another driver.
      providerStatuses: [CLAUDE_PROVIDER],
      composerDraft: {
        ...EMPTY_DRAFT,
        providerInstanceId: CODEX_WORK_ID,
        model: "gpt-5.4-mini",
      },
    });
    expect(hook.result.current).toMatchObject({
      requestedInstanceId: CODEX_WORK_ID,
      selectedProvider: "claudeAgent",
      selectedProviderInstanceId: CLAUDE_ID,
      selectedModel: "claude-opus-4-6",
    });
  });

  it("reports no provider when a started thread's instance is unavailable", async () => {
    const hook = await mount({
      serverThread: STARTED_ON_CODEX,
      providerStatuses: [CLAUDE_PROVIDER],
    });
    // Nothing is substituted: the conversation is not handed to a provider nobody picked.
    expect(hook.result.current).toMatchObject({
      noProviderAvailable: true,
      selectedProvider: "codex",
    });
  });

  it("seeds the draft's options from the server thread's selection", async () => {
    const hook = await mount({ serverThread: thread({ modelSelection: HIGH_EFFORT }) });
    await vi.waitFor(() => expect(seededOptions()).toEqual({ codex: { reasoningEffort: "high" } }));
    expect(hook.result.current.selectedModelSelectionForDispatch).toMatchObject({
      instanceId: CODEX_ID,
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("seeds nothing for a thread whose options a workflow owns", async () => {
    const hook = await mount({
      serverThread: thread({ modelSelection: HIGH_EFFORT }),
      seedsModelOptions: false,
    });
    expect(hook.result.current.selectedProviderInstanceId).toBe(CODEX_ID);
    await hook.act(() => {});
    expect(seededOptions()).toBeNull();
  });

  it("seeds nothing from a local draft's placeholder selection", async () => {
    const hook = await mount({ localDraftThread: thread({ modelSelection: HIGH_EFFORT }) });
    expect(hook.result.current.selectedProviderInstanceId).toBe(CODEX_ID);
    await hook.act(() => {});
    expect(seededOptions()).toBeNull();
  });
});
