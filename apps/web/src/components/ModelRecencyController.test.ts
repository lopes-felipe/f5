import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { recordModelSelection, useModelPreferencesStore } from "../modelPreferencesStore";
import { useStore } from "../store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../types";
import { applyRecentModelSwap } from "./ModelRecencyController";

const THREAD_ID = ThreadId.makeUnsafe("thread-swap-test");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5.4",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    error: null,
    createdAt: "2026-04-16T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-04-16T00:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("applyRecentModelSwap", () => {
  beforeEach(() => {
    if (
      typeof localStorage === "undefined" ||
      typeof localStorage.clear !== "function" ||
      typeof localStorage.setItem !== "function" ||
      typeof localStorage.getItem !== "function" ||
      typeof localStorage.removeItem !== "function"
    ) {
      let storage = new Map<string, string>();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
          removeItem: (key: string) => {
            storage.delete(key);
          },
          clear: () => {
            storage = new Map<string, string>();
          },
        },
      });
    }

    localStorage.clear();
    useModelPreferencesStore.setState({
      lastProvider: null,
      lastModelByProvider: {},
      lastModelOptions: null,
      lastWorkflowProviderBySlot: {},
      recentModelSelections: [],
    });
    useComposerDraftStore.setState({ draftsByThreadId: {} });
    useStore.setState({ threads: [] });
  });

  it("swaps the composer draft to the previously-used model and flips the MRU", () => {
    recordModelSelection("claudeAgent", "claude-opus-4-7", {
      claudeAgent: { effort: "max" },
    });
    recordModelSelection("codex", "gpt-5.4", {
      codex: { reasoningEffort: "xhigh" },
    });

    // Composer starts matching the current head selection.
    const composer = useComposerDraftStore.getState();
    composer.setProvider(THREAD_ID, "codex");
    composer.setModel(THREAD_ID, "gpt-5.4");
    composer.setModelOptions(THREAD_ID, { codex: { reasoningEffort: "xhigh" } });

    expect(applyRecentModelSwap(THREAD_ID)).toBe(true);

    const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
    expect(draft?.provider).toBe("claudeAgent");
    expect(draft?.model).toBe("claude-opus-4-7");
    expect(draft?.modelOptions).toEqual({ claudeAgent: { effort: "max" } });

    // MRU is now [claudeAgent, codex] — the next press swaps back.
    const { recentModelSelections } = useModelPreferencesStore.getState();
    expect(recentModelSelections).toHaveLength(2);
    expect(recentModelSelections[0]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-7",
    });
    expect(recentModelSelections[1]).toMatchObject({
      provider: "codex",
      model: "gpt-5.4",
    });

    expect(applyRecentModelSwap(THREAD_ID)).toBe(true);
    const flippedDraft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
    expect(flippedDraft?.provider).toBe("codex");
    expect(flippedDraft?.model).toBe("gpt-5.4");
    expect(flippedDraft?.modelOptions).toEqual({ codex: { reasoningEffort: "xhigh" } });
  });

  it("is a no-op when fewer than two selections are remembered", () => {
    recordModelSelection("codex", "gpt-5.4", undefined);

    expect(applyRecentModelSwap(THREAD_ID)).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
  });

  it("is a no-op when nothing has been remembered yet", () => {
    expect(applyRecentModelSwap(THREAD_ID)).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
  });

  it("refuses to swap across providers once the thread's session is bound", () => {
    // Session is active on codex — the server can't hot-swap to claudeAgent.
    useStore.setState({
      threads: [
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ],
    });

    recordModelSelection("claudeAgent", "claude-opus-4-7", {
      claudeAgent: { effort: "max" },
    });
    recordModelSelection("codex", "gpt-5.4", {
      codex: { reasoningEffort: "xhigh" },
    });

    expect(applyRecentModelSwap(THREAD_ID)).toBe(false);

    // Draft untouched — no cross-provider write.
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
    // MRU order preserved — a blocked press must not re-record.
    const { recentModelSelections } = useModelPreferencesStore.getState();
    expect(recentModelSelections[0]).toMatchObject({ provider: "codex", model: "gpt-5.4" });
    expect(recentModelSelections[1]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-7",
    });
  });

  it("refuses to swap across providers when the thread has prior turns but no session", () => {
    // `hasThreadStarted` also fires on `latestTurn !== null` — covers the case
    // where the session was torn down but the thread is still provider-pinned.
    useStore.setState({
      threads: [
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "completed",
            requestedAt: "2026-04-16T00:00:00.000Z",
            startedAt: "2026-04-16T00:00:30.000Z",
            completedAt: "2026-04-16T00:01:00.000Z",
            assistantMessageId: null,
          },
        }),
      ],
    });
    // No session, so the lock derives from the composer draft's provider.
    useComposerDraftStore.getState().setProvider(THREAD_ID, "codex");

    recordModelSelection("claudeAgent", "claude-opus-4-7", undefined);
    recordModelSelection("codex", "gpt-5.4", undefined);

    expect(applyRecentModelSwap(THREAD_ID)).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.provider).toBe("codex");
  });

  it("allows same-provider swaps within an ongoing thread", () => {
    useStore.setState({
      threads: [
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ],
    });

    recordModelSelection("codex", "gpt-5.3-codex", undefined);
    recordModelSelection("codex", "gpt-5.4", undefined);

    expect(applyRecentModelSwap(THREAD_ID)).toBe(true);
    const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
    expect(draft?.provider).toBe("codex");
    expect(draft?.model).toBe("gpt-5.3-codex");
  });
});
