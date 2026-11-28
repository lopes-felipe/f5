import {
  isKnownProviderKind,
  type ProviderKind,
  type ProviderModelOptions,
  type WorkflowDocumentType,
} from "@t3tools/contracts";
import { WORKFLOW_DOCUMENT_TYPE_ORDER } from "@t3tools/shared/documentWorkflow";
import { workflowMaxParticipants } from "@t3tools/shared/workflowParticipants";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { getSingleProviderModelOptions } from "./components/workflow/workflowSlots";
import { createSafeZustandStorage } from "./lib/safeStorage";
import { WORKFLOW_TYPE_ORDER, type WorkflowTypeValue } from "./lib/workflowType";
import { normalizeProviderModelOptions } from "./providerModelOptions";

/** One model slot of a submitted workflow, without the dispatch-time provider options. */
export interface SavedWorkflowSlot {
  provider: ProviderKind;
  model: string;
  modelOptions?: ProviderModelOptions;
}

/**
 * The setup last submitted for one workflow type. The prompt, file references, compare
 * branch, plans directory, cost limit and reader persona are per-run or per-repository and
 * never saved. Code review auto-post is kept per project in `autoPostProjectIds`.
 */
export interface SavedWorkflowSetup {
  /** Authors, reviewers or investigators in row order; 2 up to the type's maximum. */
  actors: SavedWorkflowSlot[];
  /** Merge, consolidation or synthesis. */
  merge: SavedWorkflowSlot;
  /** Feature, Document and Investigation. */
  selfReviewEnabled?: boolean;
  /** Document. */
  documentType?: WorkflowDocumentType;
  /** Document. */
  readerReviewEnabled?: boolean;
  /** Document; `null` when the reader follows the authors and merge model. */
  reader?: SavedWorkflowSlot | null;
}

export interface WorkflowCreatePreferencesState {
  lastWorkflowType: WorkflowTypeValue | null;
  setupsByType: Partial<Record<WorkflowTypeValue, SavedWorkflowSetup>>;
  /**
   * Projects whose last code review was started with auto-post on and a PR to post to. Auto-post
   * publishes from the user's GitHub account, so an opt-in never carries to another project.
   */
  autoPostProjectIds: string[];
  recordSubmitted: (type: WorkflowTypeValue, setup: SavedWorkflowSetup) => void;
  recordAutoPost: (projectId: string, enabled: boolean) => void;
}

export const WORKFLOW_CREATE_PREFERENCES_STORAGE_KEY = "f5:workflow-create-preferences:v1";

/** Most recent opt-ins kept; older projects fall back to auto-post off. */
export const AUTO_POST_PROJECT_IDS_MAX_LENGTH = 50;

type PersistedWorkflowCreatePreferences = Pick<
  WorkflowCreatePreferencesState,
  "lastWorkflowType" | "setupsByType" | "autoPostProjectIds"
>;

const EMPTY_WORKFLOW_CREATE_PREFERENCES: PersistedWorkflowCreatePreferences = {
  lastWorkflowType: null,
  setupsByType: {},
  autoPostProjectIds: [],
};

function isWorkflowType(value: unknown): value is WorkflowTypeValue {
  return WORKFLOW_TYPE_ORDER.includes(value as WorkflowTypeValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSlot(value: unknown): SavedWorkflowSlot | null {
  if (!isRecord(value)) return null;
  const provider = value.provider;
  if (!isKnownProviderKind(provider)) return null;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (model.length === 0) return null;
  const modelOptions = getSingleProviderModelOptions(
    provider,
    normalizeProviderModelOptions(value.modelOptions),
  );
  return { provider, model, ...(modelOptions ? { modelOptions } : {}) };
}

function normalizeSetup(type: WorkflowTypeValue, value: unknown): SavedWorkflowSetup | null {
  if (!isRecord(value) || !Array.isArray(value.actors)) return null;
  const actors = value.actors
    .map(normalizeSlot)
    .filter((slot): slot is SavedWorkflowSlot => slot !== null)
    .slice(0, workflowMaxParticipants(type));
  const merge = normalizeSlot(value.merge);
  if (actors.length < 2 || merge === null) return null;

  const setup: SavedWorkflowSetup = { actors, merge };
  if (typeof value.selfReviewEnabled === "boolean") {
    setup.selfReviewEnabled = value.selfReviewEnabled;
  }
  if (WORKFLOW_DOCUMENT_TYPE_ORDER.includes(value.documentType as WorkflowDocumentType)) {
    setup.documentType = value.documentType as WorkflowDocumentType;
  }
  if (typeof value.readerReviewEnabled === "boolean") {
    setup.readerReviewEnabled = value.readerReviewEnabled;
  }
  if (value.reader === null) {
    setup.reader = null;
  } else if (value.reader !== undefined) {
    const reader = normalizeSlot(value.reader);
    if (reader) setup.reader = reader;
  }
  return setup;
}

function normalizeProjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return [...new Set(ids)].slice(0, AUTO_POST_PROJECT_IDS_MAX_LENGTH);
}

export function normalizePersistedWorkflowCreatePreferences(
  value: unknown,
): PersistedWorkflowCreatePreferences {
  if (!isRecord(value)) return EMPTY_WORKFLOW_CREATE_PREFERENCES;
  const setupsByType: PersistedWorkflowCreatePreferences["setupsByType"] = {};
  if (isRecord(value.setupsByType)) {
    for (const type of WORKFLOW_TYPE_ORDER) {
      const setup = normalizeSetup(type, value.setupsByType[type]);
      if (setup) setupsByType[type] = setup;
    }
  }
  return {
    lastWorkflowType: isWorkflowType(value.lastWorkflowType) ? value.lastWorkflowType : null,
    setupsByType,
    autoPostProjectIds: normalizeProjectIds(value.autoPostProjectIds),
  };
}

export const useWorkflowCreatePreferencesStore = create<WorkflowCreatePreferencesState>()(
  persist(
    (set) => ({
      ...EMPTY_WORKFLOW_CREATE_PREFERENCES,
      recordSubmitted: (type, setup) => {
        const normalized = normalizeSetup(type, setup);
        set((state) => ({
          lastWorkflowType: type,
          setupsByType: normalized
            ? { ...state.setupsByType, [type]: normalized }
            : state.setupsByType,
        }));
      },
      recordAutoPost: (projectId, enabled) => {
        set((state) => {
          const others = state.autoPostProjectIds.filter((id) => id !== projectId);
          return {
            autoPostProjectIds: enabled
              ? [projectId, ...others].slice(0, AUTO_POST_PROJECT_IDS_MAX_LENGTH)
              : others,
          };
        });
      },
    }),
    {
      name: WORKFLOW_CREATE_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => createSafeZustandStorage()),
      partialize: (state) => ({
        lastWorkflowType: state.lastWorkflowType,
        setupsByType: state.setupsByType,
        autoPostProjectIds: state.autoPostProjectIds,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedWorkflowCreatePreferences(persistedState),
      }),
    },
  ),
);

// Each write stores the whole map, so a tab must pick up another tab's submits before its own
// next write, or that write would drop them.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key === WORKFLOW_CREATE_PREFERENCES_STORAGE_KEY) {
      void useWorkflowCreatePreferencesStore.persist.rehydrate();
    }
  });
}
