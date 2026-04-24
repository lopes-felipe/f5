import { beforeEach, describe, expect, it } from "vitest";

import {
  recordModelSelection,
  RECENT_MODEL_SELECTIONS_MAX_LENGTH,
  useModelPreferencesStore,
} from "./modelPreferencesStore";

type ModelPreferencesStoreState = ReturnType<typeof useModelPreferencesStore.getState>;

function getPersistApi() {
  return useModelPreferencesStore.persist as unknown as {
    getOptions: () => {
      partialize: (state: ModelPreferencesStoreState) => unknown;
      merge: (
        persistedState: unknown,
        currentState: ReturnType<typeof useModelPreferencesStore.getInitialState>,
      ) => ReturnType<typeof useModelPreferencesStore.getInitialState>;
    };
  };
}

describe("modelPreferencesStore", () => {
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
  });

  it("starts empty", () => {
    expect(useModelPreferencesStore.getState().lastProvider).toBeNull();
    expect(useModelPreferencesStore.getState().lastModelByProvider).toEqual({});
    expect(useModelPreferencesStore.getState().lastModelOptions).toBeNull();
    expect(useModelPreferencesStore.getState().lastWorkflowProviderBySlot).toEqual({});
  });

  it("updates the last selected provider", () => {
    useModelPreferencesStore.getState().setLastProvider("claudeAgent");

    expect(useModelPreferencesStore.getState().lastProvider).toBe("claudeAgent");
  });

  it("stores the last selected workflow provider per slot", () => {
    const store = useModelPreferencesStore.getState();

    store.setLastWorkflowProvider("merge", "claudeAgent");
    store.setLastWorkflowProvider("branchA", "claudeAgent");

    expect(useModelPreferencesStore.getState().lastWorkflowProviderBySlot).toEqual({
      branchA: "claudeAgent",
      merge: "claudeAgent",
    });
  });

  it("stores the last selected model per provider", () => {
    const store = useModelPreferencesStore.getState();

    store.setLastModel("codex", "gpt-5.4-mini");
    store.setLastModel("claudeAgent", "claude-opus-4-7");

    expect(useModelPreferencesStore.getState().lastModelByProvider).toEqual({
      codex: "gpt-5.4-mini",
      claudeAgent: "claude-opus-4-7",
    });
  });

  it("merges provider-specific model options without clobbering other providers", () => {
    const store = useModelPreferencesStore.getState();

    store.setLastModelOptions("codex", {
      codex: { reasoningEffort: "xhigh", fastMode: true },
    });
    store.setLastModelOptions("claudeAgent", {
      claudeAgent: { effort: "max" },
    });

    expect(useModelPreferencesStore.getState().lastModelOptions).toEqual({
      codex: { reasoningEffort: "xhigh", fastMode: true },
      claudeAgent: { effort: "max" },
    });
  });

  it("removes a provider's remembered options when the selection resets to defaults", () => {
    const store = useModelPreferencesStore.getState();

    store.setLastModelOptions("codex", {
      codex: { reasoningEffort: "xhigh", fastMode: true },
    });
    store.setLastModelOptions("claudeAgent", {
      claudeAgent: { effort: "max" },
    });
    store.setLastModelOptions("codex", undefined);

    expect(useModelPreferencesStore.getState().lastModelOptions).toEqual({
      claudeAgent: { effort: "max" },
    });
  });

  it("round-trips persisted state through partialize and merge", () => {
    const store = useModelPreferencesStore.getState();
    store.setLastProvider("claudeAgent");
    store.setLastModel("codex", "gpt-5.4-mini");
    store.setLastModel("claudeAgent", "claude-opus-4-6");
    store.setLastModelOptions("codex", {
      codex: { reasoningEffort: "xhigh" },
    });
    store.setLastModelOptions("claudeAgent", {
      claudeAgent: { effort: "max" },
    });
    store.setLastWorkflowProvider("merge", "claudeAgent");

    const persistApi = getPersistApi();
    const persistedState = persistApi.getOptions().partialize(useModelPreferencesStore.getState());
    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useModelPreferencesStore.getInitialState());

    expect(mergedState.lastProvider).toBe("claudeAgent");
    expect(mergedState.lastModelByProvider).toEqual({
      codex: "gpt-5.4-mini",
      claudeAgent: "claude-opus-4-6",
    });
    expect(mergedState.lastModelOptions).toEqual({
      codex: { reasoningEffort: "xhigh" },
      claudeAgent: { effort: "max" },
    });
    expect(mergedState.lastWorkflowProviderBySlot).toEqual({
      merge: "claudeAgent",
    });
  });

  it("round-trips claude fast mode for remembered Opus 4.6 selections", () => {
    const store = useModelPreferencesStore.getState();
    store.setLastModel("claudeAgent", "claude-opus-4-6");
    store.setLastModelOptions("claudeAgent", {
      claudeAgent: { effort: "max", fastMode: true },
    });

    const persistApi = getPersistApi();
    const persistedState = persistApi.getOptions().partialize(useModelPreferencesStore.getState());
    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useModelPreferencesStore.getInitialState());

    expect(mergedState.lastModelByProvider).toEqual({
      claudeAgent: "claude-opus-4-6",
    });
    expect(mergedState.lastModelOptions).toEqual({
      claudeAgent: { effort: "max", fastMode: true },
    });
  });

  it("round-trips explicit Opus 4.7 xhigh effort selections", () => {
    const store = useModelPreferencesStore.getState();
    store.setLastModel("claudeAgent", "claude-opus-4-7");
    store.setLastModelOptions("claudeAgent", {
      claudeAgent: { effort: "xhigh" },
    });

    const persistApi = getPersistApi();
    const persistedState = persistApi.getOptions().partialize(useModelPreferencesStore.getState());
    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useModelPreferencesStore.getInitialState());

    expect(mergedState.lastModelByProvider).toEqual({
      claudeAgent: "claude-opus-4-7",
    });
    expect(mergedState.lastModelOptions).toEqual({
      claudeAgent: { effort: "xhigh" },
    });
  });

  it("drops corrupted persisted state back to safe defaults", () => {
    const persistApi = getPersistApi();
    const mergedState = persistApi.getOptions().merge(
      {
        lastProvider: "unknown",
        lastModelByProvider: {
          codex: 42,
          claudeAgent: "",
        },
        lastModelOptions: {
          codex: {
            reasoningEffort: "nope",
            fastMode: "yes",
          },
        },
        lastWorkflowProviderBySlot: {
          merge: "bad-provider",
        },
      },
      useModelPreferencesStore.getInitialState(),
    );

    expect(mergedState.lastProvider).toBeNull();
    expect(mergedState.lastModelByProvider).toEqual({});
    expect(mergedState.lastModelOptions).toBeNull();
    expect(mergedState.lastWorkflowProviderBySlot).toEqual({});
  });

  it("records recent model selections most-recent-first and caps the list length", () => {
    recordModelSelection("codex", "gpt-5.4-mini", {
      codex: { reasoningEffort: "xhigh" },
    });
    recordModelSelection("claudeAgent", "claude-opus-4-7", {
      claudeAgent: { effort: "max" },
    });
    recordModelSelection("codex", "gpt-5.4", undefined);

    const { recentModelSelections } = useModelPreferencesStore.getState();
    expect(recentModelSelections).toHaveLength(RECENT_MODEL_SELECTIONS_MAX_LENGTH);
    expect(recentModelSelections[0]).toMatchObject({ provider: "codex", model: "gpt-5.4" });
    expect(recentModelSelections[1]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-7",
    });
  });

  it("dedupes recent selections by the full (provider, model, options) triple", () => {
    recordModelSelection("codex", "gpt-5.4-mini", {
      codex: { reasoningEffort: "low" },
    });
    recordModelSelection("codex", "gpt-5.4-mini", {
      codex: { reasoningEffort: "xhigh" },
    });
    // Different options → distinct entry.
    expect(useModelPreferencesStore.getState().recentModelSelections).toHaveLength(2);

    // Re-recording the head selection is a no-op.
    recordModelSelection("codex", "gpt-5.4-mini", {
      codex: { reasoningEffort: "xhigh" },
    });
    expect(useModelPreferencesStore.getState().recentModelSelections).toHaveLength(2);
    expect(useModelPreferencesStore.getState().recentModelSelections[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "xhigh" },
    });

    // Re-recording a later entry re-promotes it to the head.
    recordModelSelection("codex", "gpt-5.4-mini", {
      codex: { reasoningEffort: "low" },
    });
    expect(useModelPreferencesStore.getState().recentModelSelections).toHaveLength(2);
    expect(useModelPreferencesStore.getState().recentModelSelections[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "low" },
    });
    expect(useModelPreferencesStore.getState().recentModelSelections[1]).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "xhigh" },
    });
  });

  it("round-trips recentModelSelections through partialize and merge", () => {
    recordModelSelection("codex", "gpt-5.4-mini", {
      codex: { reasoningEffort: "xhigh" },
    });
    recordModelSelection("claudeAgent", "claude-opus-4-7", {
      claudeAgent: { effort: "max" },
    });

    const persistApi = getPersistApi();
    const persistedState = persistApi.getOptions().partialize(useModelPreferencesStore.getState());
    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useModelPreferencesStore.getInitialState());

    expect(mergedState.recentModelSelections).toHaveLength(2);
    expect(mergedState.recentModelSelections[0]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-7",
      options: { effort: "max" },
    });
    expect(mergedState.recentModelSelections[1]).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "xhigh" },
    });
  });

  it("drops corrupted persisted recentModelSelections back to an empty list", () => {
    const persistApi = getPersistApi();
    const mergedState = persistApi.getOptions().merge(
      {
        recentModelSelections: [
          { provider: "unknown", model: "x" },
          { provider: "codex", model: "" },
          "not-an-object",
          { provider: "codex", model: "gpt-5.4-mini", options: { reasoningEffort: "nope" } },
        ],
      },
      useModelPreferencesStore.getInitialState(),
    );

    // The first three entries are rejected; the fourth is kept with invalid
    // options normalized away.
    expect(mergedState.recentModelSelections).toEqual([
      { provider: "codex", model: "gpt-5.4-mini", options: null },
    ]);
  });

  it("preserves custom model slugs as-is", () => {
    const customModel = "my-company/custom-codex";
    const store = useModelPreferencesStore.getState();
    store.setLastModel("codex", customModel);

    const persistApi = getPersistApi();
    const persistedState = persistApi.getOptions().partialize(useModelPreferencesStore.getState());
    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useModelPreferencesStore.getInitialState());

    expect(mergedState.lastModelByProvider.codex).toBe(customModel);
  });
});
