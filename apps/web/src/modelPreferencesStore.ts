import type {
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  OpenCodeModelOptions,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";
import { areProviderModelOptionsEqual } from "@t3tools/shared/providerOptions";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { normalizeProviderModelOptions } from "./providerModelOptions";

export type WorkflowCreatePreferenceSlot = "branchA" | "branchB" | "merge";

/**
 * A single (provider, model, options) triple remembered for the "switch to
 * recent model" keybinding. `options` is the provider-scoped slice — e.g. the
 * `codex` object when `provider === "codex"` — and `null` when the remembered
 * selection used defaults.
 */
export interface RecentModelSelection {
  provider: ProviderKind;
  model: string;
  options:
    | CodexModelOptions
    | ClaudeModelOptions
    | CursorModelOptions
    | OpenCodeModelOptions
    | null;
}

/**
 * Maximum number of entries kept in `recentModelSelections`. Two is enough for
 * single-press "swap between last two" semantics.
 */
export const RECENT_MODEL_SELECTIONS_MAX_LENGTH = 2;

export interface ModelPreferencesState {
  lastProvider: ProviderKind | null;
  lastModelByProvider: Partial<Record<ProviderKind, string>>;
  lastModelOptions: ProviderModelOptions | null;
  lastWorkflowProviderBySlot: Partial<Record<WorkflowCreatePreferenceSlot, ProviderKind>>;
  /**
   * Most-recent-first list of distinct model selections, capped at
   * `RECENT_MODEL_SELECTIONS_MAX_LENGTH`. Entry 0 is the active selection and
   * entry 1 (when present) is the previous one that the swap keybinding flips
   * back to.
   */
  recentModelSelections: RecentModelSelection[];
  setLastProvider: (provider: ProviderKind) => void;
  setLastModel: (provider: ProviderKind, model: string) => void;
  setLastModelOptions: (
    provider: ProviderKind,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  setLastWorkflowProvider: (slot: WorkflowCreatePreferenceSlot, provider: ProviderKind) => void;
  recordRecentModelSelection: (selection: RecentModelSelection) => void;
}

export const MODEL_PREFERENCES_STORAGE_KEY = "t3code:model-preferences:v1";

const EMPTY_MODEL_PREFERENCES: Pick<
  ModelPreferencesState,
  | "lastProvider"
  | "lastModelByProvider"
  | "lastModelOptions"
  | "lastWorkflowProviderBySlot"
  | "recentModelSelections"
> = {
  lastProvider: null,
  lastModelByProvider: {},
  lastModelOptions: null,
  lastWorkflowProviderBySlot: {},
  recentModelSelections: [],
};

const noopStorage = {
  getItem: (_name: string) => null,
  setItem: (_name: string, _value: string) => {},
  removeItem: (_name: string) => {},
};

function getModelPreferencesStorage() {
  if (
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function" &&
    typeof localStorage.setItem === "function" &&
    typeof localStorage.removeItem === "function"
  ) {
    return localStorage;
  }
  return noopStorage;
}

function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" || value === "cursor" || value === "opencode"
    ? value
    : null;
}

function normalizePersistedModel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePersistedModelMap(value: unknown): ModelPreferencesState["lastModelByProvider"] {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  const next: ModelPreferencesState["lastModelByProvider"] = {};

  const codexModel = normalizePersistedModel(candidate.codex);
  if (codexModel) {
    next.codex = codexModel;
  }

  const claudeModel = normalizePersistedModel(candidate.claudeAgent);
  if (claudeModel) {
    next.claudeAgent = claudeModel;
  }

  const cursorModel = normalizePersistedModel(candidate.cursor);
  if (cursorModel) {
    next.cursor = cursorModel;
  }

  const openCodeModel = normalizePersistedModel(candidate.opencode);
  if (openCodeModel) {
    next.opencode = openCodeModel;
  }

  return next;
}

function normalizePersistedWorkflowProviderMap(
  value: unknown,
): ModelPreferencesState["lastWorkflowProviderBySlot"] {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  const next: ModelPreferencesState["lastWorkflowProviderBySlot"] = {};

  const branchAProvider = normalizeProviderKind(candidate.branchA);
  if (branchAProvider) {
    next.branchA = branchAProvider;
  }

  const branchBProvider = normalizeProviderKind(candidate.branchB);
  if (branchBProvider) {
    next.branchB = branchBProvider;
  }

  const mergeProvider = normalizeProviderKind(candidate.merge);
  if (mergeProvider) {
    next.merge = mergeProvider;
  }

  return next;
}

function pickProviderModelOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions[keyof ProviderModelOptions] | undefined {
  if (!modelOptions) {
    return undefined;
  }
  return modelOptions[provider];
}

/**
 * Wrap a provider-scoped options slice back into a full `ProviderModelOptions`
 * keyed by provider. The composer draft store and `setLastModelOptions` both
 * accept the keyed shape; a `RecentModelSelection` stores only the slice, so we
 * re-wrap before applying.
 */
export function wrapProviderModelOptions(
  provider: ProviderKind,
  options: RecentModelSelection["options"],
): ProviderModelOptions | null {
  if (!options) {
    return null;
  }
  return { [provider]: options } as ProviderModelOptions;
}

function areRecentModelSelectionsEqual(
  left: RecentModelSelection,
  right: RecentModelSelection,
): boolean {
  if (left.provider !== right.provider || left.model !== right.model) {
    return false;
  }
  return areProviderModelOptionsEqual(
    wrapProviderModelOptions(left.provider, left.options),
    wrapProviderModelOptions(right.provider, right.options),
  );
}

function normalizePersistedRecentSelections(
  value: unknown,
): ModelPreferencesState["recentModelSelections"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const next: RecentModelSelection[] = [];
  for (const entry of value) {
    if (next.length >= RECENT_MODEL_SELECTIONS_MAX_LENGTH) {
      break;
    }
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const provider = normalizeProviderKind(candidate.provider);
    if (!provider) continue;
    const model = normalizePersistedModel(candidate.model);
    if (!model) continue;

    const wrapped = normalizeProviderModelOptions(
      candidate.options && typeof candidate.options === "object"
        ? { [provider]: candidate.options }
        : null,
    );
    const slice = pickProviderModelOptions(provider, wrapped);
    next.push({
      provider,
      model,
      options: (slice as RecentModelSelection["options"]) ?? null,
    });
  }

  return next;
}

function normalizePersistedModelPreferences(
  value: unknown,
): Pick<
  ModelPreferencesState,
  | "lastProvider"
  | "lastModelByProvider"
  | "lastModelOptions"
  | "lastWorkflowProviderBySlot"
  | "recentModelSelections"
> {
  if (!value || typeof value !== "object") {
    return EMPTY_MODEL_PREFERENCES;
  }

  const candidate = value as Record<string, unknown>;
  return {
    lastProvider: normalizeProviderKind(candidate.lastProvider),
    lastModelByProvider: normalizePersistedModelMap(candidate.lastModelByProvider),
    lastModelOptions: normalizeProviderModelOptions(candidate.lastModelOptions),
    lastWorkflowProviderBySlot: normalizePersistedWorkflowProviderMap(
      candidate.lastWorkflowProviderBySlot,
    ),
    recentModelSelections: normalizePersistedRecentSelections(candidate.recentModelSelections),
  };
}

export const useModelPreferencesStore = create<ModelPreferencesState>()(
  persist(
    (set) => ({
      ...EMPTY_MODEL_PREFERENCES,
      setLastProvider: (provider) => {
        set((state) => (state.lastProvider === provider ? state : { lastProvider: provider }));
      },
      setLastModel: (provider, model) => {
        const normalizedModel = normalizePersistedModel(model);
        if (!normalizedModel) {
          return;
        }
        set((state) => {
          if (state.lastModelByProvider[provider] === normalizedModel) {
            return state;
          }
          return {
            lastModelByProvider: {
              ...state.lastModelByProvider,
              [provider]: normalizedModel,
            },
          };
        });
      },
      setLastModelOptions: (provider, modelOptions) => {
        const normalizedModelOptions = normalizeProviderModelOptions(modelOptions);
        const nextProviderModelOptions = pickProviderModelOptions(provider, normalizedModelOptions);

        set((state) => {
          const nextLastModelOptions: ProviderModelOptions | null = nextProviderModelOptions
            ? state.lastModelOptions
              ? {
                  ...state.lastModelOptions,
                  [provider]: nextProviderModelOptions,
                }
              : {
                  [provider]: nextProviderModelOptions,
                }
            : (() => {
                if (!state.lastModelOptions?.[provider]) {
                  return state.lastModelOptions;
                }
                const { [provider]: _discardedProvider, ...otherProviderOptions } =
                  state.lastModelOptions;
                return Object.keys(otherProviderOptions).length > 0 ? otherProviderOptions : null;
              })();

          if (areProviderModelOptionsEqual(state.lastModelOptions, nextLastModelOptions)) {
            return state;
          }

          return {
            lastModelOptions: nextLastModelOptions,
          };
        });
      },
      setLastWorkflowProvider: (slot, provider) => {
        set((state) => {
          if (state.lastWorkflowProviderBySlot[slot] === provider) {
            return state;
          }
          return {
            lastWorkflowProviderBySlot: {
              ...state.lastWorkflowProviderBySlot,
              [slot]: provider,
            },
          };
        });
      },
      recordRecentModelSelection: (selection) => {
        const normalizedModel = normalizePersistedModel(selection.model);
        if (!normalizedModel) {
          return;
        }
        const wrappedOptions = wrapProviderModelOptions(selection.provider, selection.options);
        const normalizedWrapped = normalizeProviderModelOptions(wrappedOptions);
        const normalizedSlice = pickProviderModelOptions(selection.provider, normalizedWrapped);
        const nextEntry: RecentModelSelection = {
          provider: selection.provider,
          model: normalizedModel,
          options: (normalizedSlice as RecentModelSelection["options"]) ?? null,
        };

        set((state) => {
          const withoutDuplicate = state.recentModelSelections.filter(
            (existing) => !areRecentModelSelectionsEqual(existing, nextEntry),
          );
          const nextList = [nextEntry, ...withoutDuplicate].slice(
            0,
            RECENT_MODEL_SELECTIONS_MAX_LENGTH,
          );

          if (
            nextList.length === state.recentModelSelections.length &&
            nextList.every((entry, index) => {
              const prior = state.recentModelSelections[index];
              return prior ? areRecentModelSelectionsEqual(entry, prior) : false;
            })
          ) {
            return state;
          }

          return { recentModelSelections: nextList };
        });
      },
    }),
    {
      name: MODEL_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => getModelPreferencesStorage()),
      partialize: (state) => ({
        lastProvider: state.lastProvider,
        lastModelByProvider: state.lastModelByProvider,
        lastModelOptions: state.lastModelOptions,
        lastWorkflowProviderBySlot: state.lastWorkflowProviderBySlot,
        recentModelSelections: state.recentModelSelections,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedModelPreferences(persistedState),
      }),
    },
  ),
);

export function getModelPreferences(): ModelPreferencesState {
  return useModelPreferencesStore.getState();
}

/**
 * Record a full model selection — provider, model, and provider-scoped options
 * — in one call. Updates all legacy single-slot preferences (`lastProvider`,
 * `lastModelByProvider`, `lastModelOptions`) AND appends to
 * `recentModelSelections` so the "switch to recent model" keybinding has an
 * accurate MRU.
 *
 * Prefer this helper over calling the individual setters so the MRU never
 * drifts out of sync with the composer/preferences state.
 */
export function recordModelSelection(
  provider: ProviderKind,
  model: string,
  modelOptions: ProviderModelOptions | null | undefined,
): void {
  const store = useModelPreferencesStore.getState();
  store.setLastProvider(provider);
  store.setLastModel(provider, model);
  store.setLastModelOptions(provider, modelOptions);

  const normalized = normalizeProviderModelOptions(modelOptions);
  const slice = pickProviderModelOptions(provider, normalized);
  store.recordRecentModelSelection({
    provider,
    model,
    options: (slice as RecentModelSelection["options"]) ?? null,
  });
}
