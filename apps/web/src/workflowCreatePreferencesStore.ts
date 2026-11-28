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
 * branch, cost limit and reader persona are per-run and never saved.
 */
export interface SavedWorkflowSetup {
  /** Authors, reviewers or investigators in row order; 2 up to the type's maximum. */
  actors: SavedWorkflowSlot[];
  /** Merge, consolidation or synthesis. */
  merge: SavedWorkflowSlot;
  /** Feature, Document and Investigation. */
  selfReviewEnabled?: boolean;
  /** Feature. */
  plansDirectory?: string;
  /** Document. */
  documentType?: WorkflowDocumentType;
  /** Document. */
  readerReviewEnabled?: boolean;
  /** Document; `null` when the reader follows the merge model. */
  reader?: SavedWorkflowSlot | null;
  /** Code Review: the checkbox's own value, which applies only once a PR is detected. */
  autoPost?: boolean;
}

export interface WorkflowCreatePreferencesState {
  lastWorkflowType: WorkflowTypeValue | null;
  setupsByType: Partial<Record<WorkflowTypeValue, SavedWorkflowSetup>>;
  recordSubmitted: (type: WorkflowTypeValue, setup: SavedWorkflowSetup) => void;
}

export const WORKFLOW_CREATE_PREFERENCES_STORAGE_KEY = "f5:workflow-create-preferences:v1";

type PersistedWorkflowCreatePreferences = Pick<
  WorkflowCreatePreferencesState,
  "lastWorkflowType" | "setupsByType"
>;

const EMPTY_WORKFLOW_CREATE_PREFERENCES: PersistedWorkflowCreatePreferences = {
  lastWorkflowType: null,
  setupsByType: {},
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
  if (typeof value.plansDirectory === "string" && value.plansDirectory.trim().length > 0) {
    setup.plansDirectory = value.plansDirectory.trim();
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
  if (typeof value.autoPost === "boolean") {
    setup.autoPost = value.autoPost;
  }
  return setup;
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
    }),
    {
      name: WORKFLOW_CREATE_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => createSafeZustandStorage()),
      partialize: (state) => ({
        lastWorkflowType: state.lastWorkflowType,
        setupsByType: state.setupsByType,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedWorkflowCreatePreferences(persistedState),
      }),
    },
  ),
);
