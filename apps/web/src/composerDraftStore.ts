import {
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  ProjectId,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  ThreadId,
  type CodexReasoningEffort,
  type ProviderKind,
  type ProviderInteractionMode,
  type ProviderModelOptions,
  type RuntimeMode,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { areProviderModelOptionsEqual } from "@t3tools/shared/providerOptions";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type ChatImageAttachment } from "./types";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import { normalizeAttachedFilePaths } from "./lib/attachedFiles";
import { normalizeProviderModelOptions } from "./providerModelOptions";
import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
export type DraftThreadEnvMode = "local" | "worktree";

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

interface DebouncedStorage extends StateStorage {
  cancelPending: () => void;
  flush: () => void;
}

export function createDebouncedStorage(baseStorage: StateStorage): DebouncedStorage {
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      baseStorage.setItem(name, value);
    },
    { wait: COMPOSER_PERSIST_DEBOUNCE_MS },
  );

  return {
    getItem: (name) => baseStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      baseStorage.removeItem(name);
    },
    cancelPending: () => {
      debouncedSetItem.cancel();
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

function createMemoryStateStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

function isStateStorage(value: unknown): value is StateStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    "getItem" in value &&
    typeof value.getItem === "function" &&
    "setItem" in value &&
    typeof value.setItem === "function" &&
    "removeItem" in value &&
    typeof value.removeItem === "function"
  );
}

const fallbackComposerBaseStorage = createMemoryStateStorage();

function resolveComposerBaseStorage(): StateStorage {
  return typeof localStorage !== "undefined" && isStateStorage(localStorage)
    ? localStorage
    : fallbackComposerBaseStorage;
}

let composerDebouncedStorage: DebouncedStorage = createDebouncedStorage(
  resolveComposerBaseStorage(),
);

// Test-only seams: gated behind `import.meta.env.DEV` so Vite can tree-shake
// the body in production bundles and any accidental runtime call from a
// shipped build fails loudly instead of silently rewiring the draft store.
export function setComposerDraftBaseStorageForTesting(baseStorage: StateStorage): void {
  if (!import.meta.env.DEV) {
    throw new Error(
      "setComposerDraftBaseStorageForTesting is a test-only helper and must not be called in production builds",
    );
  }
  composerDebouncedStorage.cancelPending();
  composerDebouncedStorage = createDebouncedStorage(baseStorage);
  useComposerDraftStore.persist.setOptions({
    storage: createJSONStorage(() => composerDebouncedStorage),
  });
}

export function resetComposerDraftBaseStorageForTesting(): void {
  if (!import.meta.env.DEV) {
    throw new Error(
      "resetComposerDraftBaseStorageForTesting is a test-only helper and must not be called in production builds",
    );
  }
  composerDebouncedStorage.cancelPending();
  composerDebouncedStorage = createDebouncedStorage(resolveComposerBaseStorage());
  useComposerDraftStore.persist.setOptions({
    storage: createJSONStorage(() => composerDebouncedStorage),
  });
}

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export interface PersistedComposerImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

interface PersistedTerminalContextDraft {
  id: string;
  threadId: ThreadId;
  createdAt: string;
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}

interface PersistedComposerThreadDraftState {
  prompt: string;
  attachments: PersistedComposerImageAttachment[];
  filePaths?: string[];
  terminalContexts?: PersistedTerminalContextDraft[];
  provider?: ProviderKind | null;
  model?: string | null;
  modelOptions?: ProviderModelOptions | null;
  runtimeMode?: RuntimeMode | null;
  interactionMode?: ProviderInteractionMode | null;
  effort?: CodexReasoningEffort | null;
  codexFastMode?: boolean | null;
  serviceTier?: string | null;
}

interface PersistedDraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
}

interface PersistedComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, PersistedComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, PersistedDraftThreadState>;
  projectDraftThreadIdByProjectId: Record<string, ThreadId>;
}

interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  filePaths: string[];
  terminalContexts: TerminalContextDraft[];
  provider: ProviderKind | null;
  model: string | null;
  modelOptions: ProviderModelOptions | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
  effort: CodexReasoningEffort | null;
  codexFastMode: boolean;
}

export interface DraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
}

interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

const PROJECT_DRAFT_KEY_SEPARATOR = "::";
const LEGACY_PROJECT_DRAFT_KEY_SEPARATOR = "\u0000";
type ProjectDraftThreadKey = string;

function normalizeDraftWorkspaceKey(input?: {
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode | null;
}): string {
  const worktreePath = typeof input?.worktreePath === "string" ? input.worktreePath.trim() : "";
  if (worktreePath.length > 0) {
    return `worktree:${worktreePath}`;
  }
  return input?.envMode === "worktree" ? "worktree:new" : "local";
}

function projectDraftThreadKey(
  projectId: ProjectId,
  input?: {
    worktreePath?: string | null;
    envMode?: DraftThreadEnvMode | null;
  },
): ProjectDraftThreadKey {
  return `${projectId}${PROJECT_DRAFT_KEY_SEPARATOR}${normalizeDraftWorkspaceKey(input)}`;
}

function projectIdFromDraftThreadKey(key: string): ProjectId {
  const separatorIndex = key.indexOf(PROJECT_DRAFT_KEY_SEPARATOR);
  if (separatorIndex !== -1) {
    return key.slice(0, separatorIndex) as ProjectId;
  }
  const legacySeparatorIndex = key.indexOf(LEGACY_PROJECT_DRAFT_KEY_SEPARATOR);
  return (legacySeparatorIndex === -1 ? key : key.slice(0, legacySeparatorIndex)) as ProjectId;
}

function keyForDraftThread(draftThread: DraftThreadState): ProjectDraftThreadKey {
  return projectDraftThreadKey(draftThread.projectId, draftThread);
}

function isProjectDraftKeyForProject(key: string, projectId: ProjectId): boolean {
  return projectIdFromDraftThreadKey(key) === projectId;
}

interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<string, ThreadId>;
  getDraftThreadByProjectId: (
    projectId: ProjectId,
    options?: {
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode | null;
    },
  ) => ProjectDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setFilePaths: (threadId: ThreadId, filePaths: string[]) => void;
  setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  setProvider: (threadId: ThreadId, provider: ProviderKind | null | undefined) => void;
  setModel: (threadId: ThreadId, model: string | null | undefined) => void;
  setModelOptions: (
    threadId: ThreadId,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  setEffort: (threadId: ThreadId, effort: CodexReasoningEffort | null | undefined) => void;
  setCodexFastMode: (threadId: ThreadId, enabled: boolean | null | undefined) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  addFilePaths: (threadId: ThreadId, paths: string[]) => void;
  removeFilePath: (threadId: ThreadId, filePath: string) => void;
  insertTerminalContext: (
    threadId: ThreadId,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadId: ThreadId, contextId: string) => void;
  clearTerminalContexts: (threadId: ThreadId) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (threadId: ThreadId) => void;
  clearThreadDraft: (threadId: ThreadId) => void;
}

const EMPTY_PERSISTED_DRAFT_STORE_STATE: PersistedComposerDraftStoreState = {
  draftsByThreadId: {},
  draftThreadsByThreadId: {},
  projectDraftThreadIdByProjectId: {},
};

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_FILE_PATHS: string[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_FILE_PATHS);
Object.freeze(EMPTY_TERMINAL_CONTEXTS);
const EMPTY_THREAD_DRAFT = Object.freeze({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  filePaths: EMPTY_FILE_PATHS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  provider: null,
  model: null,
  modelOptions: null,
  runtimeMode: null,
  interactionMode: null,
  effort: null,
  codexFastMode: false,
}) as ComposerThreadDraftState;

const REASONING_EFFORT_VALUES = new Set<CodexReasoningEffort>(
  REASONING_EFFORT_OPTIONS_BY_PROVIDER.codex,
);

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    filePaths: [],
    terminalContexts: [],
    provider: null,
    model: null,
    modelOptions: null,
    runtimeMode: null,
    interactionMode: null,
    effort: null,
    codexFastMode: false,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

function areComposerFilePathsEqual(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return left.length === right.length && left.every((filePath, index) => filePath === right[index]);
}

function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.filePaths.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.provider === null &&
    draft.model === null &&
    draft.modelOptions === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null &&
    draft.effort === null &&
    draft.codexFastMode === false
  );
}

function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" ? value : null;
}

function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

function normalizePersistedComposerDraftState(value: unknown): PersistedComposerDraftStoreState {
  if (!value || typeof value !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = value as Record<string, unknown>;
  const rawDraftMap = candidate.draftsByThreadId;
  const rawDraftThreadsByThreadId = candidate.draftThreadsByThreadId;
  const rawProjectDraftThreadIdByProjectId = candidate.projectDraftThreadIdByProjectId;
  const draftThreadsByThreadId: PersistedComposerDraftStoreState["draftThreadsByThreadId"] = {};
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      if (typeof projectId !== "string" || projectId.length === 0) {
        continue;
      }
      draftThreadsByThreadId[threadId as ThreadId] = {
        projectId: projectId as ProjectId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode:
          candidateDraftThread.runtimeMode === "approval-required" ||
          candidateDraftThread.runtimeMode === "full-access"
            ? candidateDraftThread.runtimeMode
            : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_INTERACTION_MODE,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
      };
    }
  }
  const projectDraftThreadIdByProjectId: PersistedComposerDraftStoreState["projectDraftThreadIdByProjectId"] =
    {};
  if (
    rawProjectDraftThreadIdByProjectId &&
    typeof rawProjectDraftThreadIdByProjectId === "object"
  ) {
    for (const [rawProjectDraftKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectId as Record<string, unknown>,
    )) {
      if (
        typeof rawProjectDraftKey === "string" &&
        rawProjectDraftKey.length > 0 &&
        typeof threadId === "string" &&
        threadId.length > 0
      ) {
        const projectId = projectIdFromDraftThreadKey(rawProjectDraftKey);
        if (!draftThreadsByThreadId[threadId as ThreadId]) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            projectId,
            createdAt: new Date().toISOString(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            envMode: "local",
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.projectId !== projectId) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            projectId,
          };
        }
        const draftThread = draftThreadsByThreadId[threadId as ThreadId];
        if (draftThread) {
          projectDraftThreadIdByProjectId[keyForDraftThread(draftThread)] = threadId as ThreadId;
        }
      }
    }
  }
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return { draftsByThreadId: {}, draftThreadsByThreadId, projectDraftThreadIdByProjectId };
  }
  const nextDraftsByThreadId: PersistedComposerDraftStoreState["draftsByThreadId"] = {};
  for (const [threadId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as Record<string, unknown>;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const filePaths = Array.isArray(draftCandidate.filePaths)
      ? normalizeAttachedFilePaths(
          draftCandidate.filePaths.filter((entry): entry is string => typeof entry === "string"),
        )
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const provider = normalizeProviderKind(draftCandidate.provider);
    const model =
      typeof draftCandidate.model === "string"
        ? normalizeModelSlug(draftCandidate.model, provider ?? "codex")
        : null;
    const modelOptions = normalizeProviderModelOptions(draftCandidate.modelOptions, provider, {
      effort:
        typeof draftCandidate.effort === "string"
          ? ((draftCandidate.effort as CodexReasoningEffort) ?? null)
          : null,
      codexFastMode: draftCandidate.codexFastMode === true ? true : null,
      serviceTier:
        typeof draftCandidate.serviceTier === "string" ? draftCandidate.serviceTier : null,
    });
    const runtimeMode =
      draftCandidate.runtimeMode === "approval-required" ||
      draftCandidate.runtimeMode === "full-access"
        ? draftCandidate.runtimeMode
        : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const effortCandidate =
      typeof draftCandidate.effort === "string" ? draftCandidate.effort : null;
    const effort =
      effortCandidate && REASONING_EFFORT_VALUES.has(effortCandidate as CodexReasoningEffort)
        ? (effortCandidate as CodexReasoningEffort)
        : null;
    const codexFastMode =
      draftCandidate.codexFastMode === true ||
      (typeof draftCandidate.serviceTier === "string" && draftCandidate.serviceTier === "fast");
    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      filePaths.length === 0 &&
      terminalContexts.length === 0 &&
      !provider &&
      !model &&
      !modelOptions &&
      !runtimeMode &&
      !interactionMode &&
      !effort &&
      !codexFastMode
    ) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      attachments,
      ...(filePaths.length > 0 ? { filePaths } : {}),
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(modelOptions ? { modelOptions } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
      ...(effort ? { effort } : {}),
      ...(codexFastMode ? { codexFastMode } : {}),
    };
  }
  return {
    draftsByThreadId: nextDraftsByThreadId,
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
  };
}

function parsePersistedDraftStateRaw(raw: string | null): PersistedComposerDraftStoreState {
  if (!raw) {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "state" in parsed) {
      return normalizePersistedComposerDraftState((parsed as { state?: unknown }).state);
    }
    return normalizePersistedComposerDraftState(parsed);
  } catch {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
}

function readPersistedAttachmentIdsFromStorage(threadId: ThreadId): string[] {
  if (threadId.length === 0) {
    return [];
  }
  try {
    const raw = composerDebouncedStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (raw instanceof Promise) {
      return [];
    }
    const persisted = parsePersistedDraftStateRaw(raw);
    return (persisted.draftsByThreadId[threadId]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function hydreatePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

function hydrateImagesFromPersisted(
  attachments: PersistedComposerImageAttachment[],
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydreatePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ];
  });
}

function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: persistedDraft.attachments,
    filePaths: persistedDraft.filePaths ?? [],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    provider: persistedDraft.provider ?? null,
    model: persistedDraft.model ?? null,
    modelOptions: persistedDraft.modelOptions ?? null,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
    effort: persistedDraft.effort ?? null,
    codexFastMode: persistedDraft.codexFastMode === true,
  };
}

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      getDraftThreadByProjectId: (projectId, options) => {
        if (projectId.length === 0) {
          return null;
        }
        const state = get();
        if (options !== undefined) {
          const threadId =
            state.projectDraftThreadIdByProjectId[projectDraftThreadKey(projectId, options)];
          if (!threadId) {
            return null;
          }
          const draftThread = state.draftThreadsByThreadId[threadId];
          if (!draftThread || draftThread.projectId !== projectId) {
            return null;
          }
          return {
            threadId,
            ...draftThread,
          };
        }

        let latestDraftThread: ProjectDraftThread | null = null;
        for (const [key, threadId] of Object.entries(state.projectDraftThreadIdByProjectId)) {
          if (!isProjectDraftKeyForProject(key, projectId)) {
            continue;
          }
          const draftThread = state.draftThreadsByThreadId[threadId];
          if (!draftThread || draftThread.projectId !== projectId) {
            continue;
          }
          const draftThreadCreatedAtMs = Date.parse(draftThread.createdAt);
          const latestDraftThreadCreatedAtMs = latestDraftThread
            ? Date.parse(latestDraftThread.createdAt)
            : Number.NEGATIVE_INFINITY;
          const draftThreadSortTime = Number.isFinite(draftThreadCreatedAtMs)
            ? draftThreadCreatedAtMs
            : Number.NEGATIVE_INFINITY;
          const latestDraftThreadSortTime = Number.isFinite(latestDraftThreadCreatedAtMs)
            ? latestDraftThreadCreatedAtMs
            : Number.NEGATIVE_INFINITY;
          if (
            !latestDraftThread ||
            draftThreadSortTime > latestDraftThreadSortTime ||
            (draftThreadSortTime === latestDraftThreadSortTime &&
              threadId > latestDraftThread.threadId)
          ) {
            latestDraftThread = {
              threadId,
              ...draftThread,
            };
          }
        }
        return latestDraftThread;
      },
      getDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return null;
        }
        return get().draftThreadsByThreadId[threadId] ?? null;
      },
      setProjectDraftThreadId: (projectId, threadId, options) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadId[threadId];
          const nextWorktreePath =
            options?.worktreePath === undefined
              ? (existingThread?.worktreePath ?? null)
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId,
            createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
            runtimeMode:
              options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              options?.interactionMode ??
              existingThread?.interactionMode ??
              DEFAULT_INTERACTION_MODE,
            branch:
              options?.branch === undefined
                ? (existingThread?.branch ?? null)
                : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options?.envMode ??
              (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
          };
          const nextProjectDraftKey = keyForDraftThread(nextDraftThread);
          const previousThreadIdForProjectKey =
            state.projectDraftThreadIdByProjectId[nextProjectDraftKey];
          const hasSameProjectMapping = previousThreadIdForProjectKey === threadId;
          const hasSameDraftThread =
            existingThread &&
            existingThread.projectId === nextDraftThread.projectId &&
            existingThread.createdAt === nextDraftThread.createdAt &&
            existingThread.runtimeMode === nextDraftThread.runtimeMode &&
            existingThread.interactionMode === nextDraftThread.interactionMode &&
            existingThread.branch === nextDraftThread.branch &&
            existingThread.worktreePath === nextDraftThread.worktreePath &&
            existingThread.envMode === nextDraftThread.envMode;
          if (hasSameProjectMapping && hasSameDraftThread) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {};
          for (const [key, existingThreadId] of Object.entries(
            state.projectDraftThreadIdByProjectId,
          )) {
            if (existingThreadId === threadId && key !== nextProjectDraftKey) {
              continue;
            }
            nextProjectDraftThreadIdByProjectId[key] = existingThreadId;
          }
          nextProjectDraftThreadIdByProjectId[nextProjectDraftKey] = threadId;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (
            previousThreadIdForProjectKey &&
            previousThreadIdForProjectKey !== threadId &&
            !Object.values(nextProjectDraftThreadIdByProjectId).includes(
              previousThreadIdForProjectKey,
            )
          ) {
            delete nextDraftThreadsByThreadId[previousThreadIdForProjectKey];
            if (state.draftsByThreadId[previousThreadIdForProjectKey] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[previousThreadIdForProjectKey];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      setDraftThreadContext: (threadId, options) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing) {
            return state;
          }
          const nextProjectId = options.projectId ?? existing.projectId;
          if (nextProjectId.length === 0) {
            return state;
          }
          const nextWorktreePath =
            options.worktreePath === undefined
              ? existing.worktreePath
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId: nextProjectId,
            createdAt:
              options.createdAt === undefined
                ? existing.createdAt
                : options.createdAt || existing.createdAt,
            runtimeMode: options.runtimeMode ?? existing.runtimeMode,
            interactionMode: options.interactionMode ?? existing.interactionMode,
            branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
          };
          const isUnchanged =
            nextDraftThread.projectId === existing.projectId &&
            nextDraftThread.createdAt === existing.createdAt &&
            nextDraftThread.runtimeMode === existing.runtimeMode &&
            nextDraftThread.interactionMode === existing.interactionMode &&
            nextDraftThread.branch === existing.branch &&
            nextDraftThread.worktreePath === existing.worktreePath &&
            nextDraftThread.envMode === existing.envMode;
          if (isUnchanged) {
            return state;
          }
          const nextProjectDraftKey = keyForDraftThread(nextDraftThread);
          const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {};
          for (const [key, existingThreadId] of Object.entries(
            state.projectDraftThreadIdByProjectId,
          )) {
            if (existingThreadId === threadId && key !== nextProjectDraftKey) {
              continue;
            }
            nextProjectDraftThreadIdByProjectId[key] = existingThreadId;
          }
          nextProjectDraftThreadIdByProjectId[nextProjectDraftKey] = threadId;
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: nextDraftThread,
            },
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      clearProjectDraftThreadId: (projectId) => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => {
          const removedThreadIds = new Set<ThreadId>();
          const restProjectMappings: Record<string, ThreadId> = {};
          for (const [key, threadId] of Object.entries(state.projectDraftThreadIdByProjectId)) {
            if (isProjectDraftKeyForProject(key, projectId)) {
              removedThreadIds.add(threadId);
              continue;
            }
            restProjectMappings[key] = threadId;
          }
          if (removedThreadIds.size === 0) {
            return state;
          }
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          const remainingThreadIds = new Set(Object.values(restProjectMappings));
          for (const threadId of removedThreadIds) {
            if (remainingThreadIds.has(threadId)) {
              continue;
            }
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              if (nextDraftsByThreadId === state.draftsByThreadId) {
                nextDraftsByThreadId = { ...state.draftsByThreadId };
              }
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearProjectDraftThreadById: (projectId, threadId) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const restProjectMappings: Record<string, ThreadId> = {};
          let removed = false;
          for (const [key, draftThreadId] of Object.entries(
            state.projectDraftThreadIdByProjectId,
          )) {
            if (isProjectDraftKeyForProject(key, projectId) && draftThreadId === threadId) {
              removed = true;
              continue;
            }
            restProjectMappings[key] = draftThreadId;
          }
          if (!removed) {
            return state;
          }
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (!Object.values(restProjectMappings).includes(threadId)) {
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          if (!hasDraftThread && !hasProjectMapping) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
            Object.entries(state.projectDraftThreadIdByProjectId).filter(
              ([, draftThreadId]) => draftThreadId !== threadId,
            ),
          ) as Record<string, ThreadId>;
          const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
            state.draftThreadsByThreadId;
          return {
            draftThreadsByThreadId: restDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      setPrompt: (threadId, prompt) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setFilePaths: (threadId, filePaths) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedFilePaths = normalizeAttachedFilePaths(filePaths);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalizedFilePaths.length === 0) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (areComposerFilePathsEqual(base.filePaths, normalizedFilePaths)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            filePaths: normalizedFilePaths,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt: ensureInlineTerminalContextPlaceholders(
              existing.prompt,
              normalizedContexts.length,
            ),
            terminalContexts: normalizedContexts,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setProvider: (threadId, provider) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedProvider = normalizeProviderKind(provider);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalizedProvider === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.provider === normalizedProvider) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            provider: normalizedProvider,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModel: (threadId, model) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          const normalizedModel = normalizeModelSlug(model, existing?.provider ?? "codex") ?? null;
          if (!existing && normalizedModel === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.model === normalizedModel) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            model: normalizedModel,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModelOptions: (threadId, modelOptions) => {
        if (threadId.length === 0) {
          return;
        }
        const nextModelOptions = normalizeProviderModelOptions(modelOptions) ?? null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextModelOptions === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (areProviderModelOptionsEqual(base.modelOptions, nextModelOptions)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelOptions: nextModelOptions,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setRuntimeMode: (threadId, runtimeMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextRuntimeMode =
          runtimeMode === "approval-required" || runtimeMode === "full-access" ? runtimeMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextRuntimeMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.runtimeMode === nextRuntimeMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            runtimeMode: nextRuntimeMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setInteractionMode: (threadId, interactionMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextInteractionMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.interactionMode === nextInteractionMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            interactionMode: nextInteractionMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setEffort: (threadId, effort) => {
        if (threadId.length === 0) {
          return;
        }
        const nextEffort =
          effort &&
          REASONING_EFFORT_VALUES.has(effort) &&
          effort !== DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex
            ? effort
            : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextEffort === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.effort === nextEffort) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            effort: nextEffort,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setCodexFastMode: (threadId, enabled) => {
        if (threadId.length === 0) {
          return;
        }
        const nextCodexFastMode = enabled === true;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextCodexFastMode === false) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.codexFastMode === nextCodexFastMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            codexFastMode: nextCodexFastMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      addImage: (threadId, image) => {
        if (threadId.length === 0) {
          return;
        }
        get().addImages(threadId, [image]);
      },
      addImages: (threadId, images) => {
        if (threadId.length === 0 || images.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const existingIds = new Set(existing.images.map((image) => image.id));
          const existingDedupKeys = new Set(
            existing.images.map((image) => composerImageDedupKey(image)),
          );
          const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
          const dedupedIncoming: ComposerImageAttachment[] = [];
          for (const image of images) {
            const dedupKey = composerImageDedupKey(image);
            if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
              // Avoid revoking a blob URL that's still referenced by an accepted image.
              if (!acceptedPreviewUrls.has(image.previewUrl)) {
                revokeObjectPreviewUrl(image.previewUrl);
              }
              continue;
            }
            dedupedIncoming.push(image);
            existingIds.add(image.id);
            existingDedupKeys.add(dedupKey);
            acceptedPreviewUrls.add(image.previewUrl);
          }
          if (dedupedIncoming.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                images: [...existing.images, ...dedupedIncoming],
              },
            },
          };
        });
      },
      removeImage: (threadId, imageId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (!existing) {
          return;
        }
        const removedImage = existing.images.find((image) => image.id === imageId);
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            images: current.images.filter((image) => image.id !== imageId),
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => attachment.id !== imageId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      addFilePaths: (threadId, paths) => {
        if (threadId.length === 0 || paths.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextFilePaths = normalizeAttachedFilePaths([...existing.filePaths, ...paths]);
          if (nextFilePaths.length === existing.filePaths.length) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                filePaths: nextFilePaths,
              },
            },
          };
        });
      },
      removeFilePath: (threadId, filePath) => {
        if (threadId.length === 0 || filePath.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || !current.filePaths.includes(filePath)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            filePaths: current.filePaths.filter((entry) => entry !== filePath),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      insertTerminalContext: (threadId, prompt, context, index) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const normalizedContext = normalizeTerminalContextForThread(threadId, context);
          if (!normalizedContext) {
            return state;
          }
          const dedupKey = terminalContextDedupKey(normalizedContext);
          if (
            existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
            existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
          ) {
            return state;
          }
          inserted = true;
          const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
            terminalContexts: [
              ...existing.terminalContexts.slice(0, boundedIndex),
              normalizedContext,
              ...existing.terminalContexts.slice(boundedIndex),
            ],
          };
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: nextDraft,
            },
          };
        });
        return inserted;
      },
      addTerminalContext: (threadId, context) => {
        if (threadId.length === 0) {
          return;
        }
        get().addTerminalContexts(threadId, [context]);
      },
      addTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0 || contexts.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
            ...existing.terminalContexts,
            ...contexts,
          ]).slice(existing.terminalContexts.length);
          if (acceptedContexts.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                prompt: ensureInlineTerminalContextPlaceholders(
                  existing.prompt,
                  existing.terminalContexts.length + acceptedContexts.length,
                ),
                terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
              },
            },
          };
        });
      },
      removeTerminalContext: (threadId, contextId) => {
        if (threadId.length === 0 || contextId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: current.terminalContexts.filter(
              (context) => context.id !== contextId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearTerminalContexts: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.terminalContexts.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearPersistedAttachments: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            persistedAttachments: [],
            nonPersistedImageIds: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      syncPersistedAttachments: (threadId, attachments) => {
        if (threadId.length === 0) {
          return;
        }
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        const previouslyConfirmedAttachments =
          get().draftsByThreadId[threadId]?.persistedAttachments ?? [];
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            // Stage attempted attachments so persist middleware can try writing them.
            persistedAttachments: attachments,
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (id) => !attachmentIdSet.has(id),
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
        Promise.resolve().then(() => {
          try {
            composerDebouncedStorage.flush();
            const persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadId));
            set((state) => {
              const current = state.draftsByThreadId[threadId];
              if (!current) {
                return state;
              }
              const imageIdSet = new Set(current.images.map((image) => image.id));
              const persistedAttachments = attachments.filter(
                (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
              );
              const nonPersistedImageIds = current.images
                .map((image) => image.id)
                .filter((imageId) => !persistedIdSet.has(imageId));
              const nextDraft: ComposerThreadDraftState = {
                ...current,
                persistedAttachments,
                nonPersistedImageIds,
              };
              const nextDraftsByThreadId = { ...state.draftsByThreadId };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadId[threadId];
              } else {
                nextDraftsByThreadId[threadId] = nextDraft;
              }
              return { draftsByThreadId: nextDraftsByThreadId };
            });
          } catch {
            const confirmedAttachmentById = new Map(
              previouslyConfirmedAttachments.map((attachment) => [attachment.id, attachment]),
            );
            set((state) => {
              const current = state.draftsByThreadId[threadId];
              if (!current) {
                return state;
              }
              const currentImageIds = current.images.map((image) => image.id);
              const persistedAttachments = currentImageIds.flatMap((imageId) => {
                const attachment = confirmedAttachmentById.get(imageId);
                return attachment ? [attachment] : [];
              });
              const nextDraft: ComposerThreadDraftState = {
                ...current,
                persistedAttachments,
                nonPersistedImageIds: currentImageIds,
              };
              const nextDraftsByThreadId = { ...state.draftsByThreadId };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadId[threadId];
              } else {
                nextDraftsByThreadId[threadId] = nextDraft;
              }
              return { draftsByThreadId: nextDraftsByThreadId };
            });
          }
        });
      },
      clearComposerContent: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: "",
            images: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            filePaths: [],
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearThreadDraft: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (existing) {
          for (const image of existing.images) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
        }
        set((state) => {
          const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          if (!hasComposerDraft && !hasDraftThread && !hasProjectMapping) {
            return state;
          }
          const { [threadId]: _removedComposerDraft, ...restComposerDraftsByThreadId } =
            state.draftsByThreadId;
          const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
            state.draftThreadsByThreadId;
          const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
            Object.entries(state.projectDraftThreadIdByProjectId).filter(
              ([, draftThreadId]) => draftThreadId !== threadId,
            ),
          ) as Record<string, ThreadId>;
          return {
            draftsByThreadId: restComposerDraftsByThreadId,
            draftThreadsByThreadId: restDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
    }),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => composerDebouncedStorage),
      partialize: (state) => {
        const persistedDraftsByThreadId: PersistedComposerDraftStoreState["draftsByThreadId"] = {};
        for (const [threadId, draft] of Object.entries(state.draftsByThreadId)) {
          if (typeof threadId !== "string" || threadId.length === 0) {
            continue;
          }
          if (
            draft.prompt.length === 0 &&
            draft.persistedAttachments.length === 0 &&
            draft.filePaths.length === 0 &&
            draft.terminalContexts.length === 0 &&
            draft.provider === null &&
            draft.model === null &&
            draft.modelOptions === null &&
            draft.runtimeMode === null &&
            draft.interactionMode === null &&
            draft.effort === null &&
            draft.codexFastMode === false
          ) {
            continue;
          }
          const persistedDraft: PersistedComposerThreadDraftState = {
            prompt: draft.prompt,
            attachments: draft.persistedAttachments,
          };
          if (draft.filePaths.length > 0) {
            persistedDraft.filePaths = draft.filePaths;
          }
          if (draft.terminalContexts.length > 0) {
            persistedDraft.terminalContexts = draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            }));
          }
          if (draft.model) {
            persistedDraft.model = draft.model;
          }
          if (draft.provider) {
            persistedDraft.provider = draft.provider;
          }
          if (draft.modelOptions) {
            persistedDraft.modelOptions = draft.modelOptions;
          }
          if (draft.runtimeMode) {
            persistedDraft.runtimeMode = draft.runtimeMode;
          }
          if (draft.interactionMode) {
            persistedDraft.interactionMode = draft.interactionMode;
          }
          if (draft.effort) {
            persistedDraft.effort = draft.effort;
          }
          if (draft.codexFastMode) {
            persistedDraft.codexFastMode = true;
          }
          persistedDraftsByThreadId[threadId as ThreadId] = persistedDraft;
        }
        return {
          draftsByThreadId: persistedDraftsByThreadId,
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
        };
      },
      merge: (persistedState, currentState) => {
        const normalizedPersisted = normalizePersistedComposerDraftState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
        };
      },
    },
  ),
);

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT);
}

/**
 * Clear draft threads that have been promoted to server threads.
 *
 * Call this after a snapshot sync so the route guard in `_chat.$threadId`
 * sees the server thread before the draft is removed — avoids a redirect
 * to `/` caused by a gap where neither draft nor server thread exists.
 */
export function clearPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      store.clearDraftThread(draftId);
    }
  }
}

export function pruneOrphanedDraftThreads(validProjectIds: ReadonlySet<string>): void {
  const previousDraftsByThreadId = useComposerDraftStore.getState().draftsByThreadId;
  const removedThreadIds = new Set<ThreadId>();

  useComposerDraftStore.setState((state) => {
    let changed = false;
    const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
      ...state.draftThreadsByThreadId,
    };

    for (const [threadId, draftThread] of Object.entries(state.draftThreadsByThreadId) as Array<
      [ThreadId, DraftThreadState]
    >) {
      if (validProjectIds.has(draftThread.projectId)) {
        continue;
      }
      delete nextDraftThreadsByThreadId[threadId];
      removedThreadIds.add(threadId);
      changed = true;
    }

    const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
      Object.entries(state.projectDraftThreadIdByProjectId).filter(([key, threadId]) => {
        const projectId = projectIdFromDraftThreadKey(key);
        if (!validProjectIds.has(projectId)) {
          changed = true;
          return false;
        }

        const draftThread = nextDraftThreadsByThreadId[threadId as ThreadId];
        if (!draftThread || draftThread.projectId !== projectId) {
          removedThreadIds.add(threadId as ThreadId);
          changed = true;
          return false;
        }

        return true;
      }),
    ) as Record<string, ThreadId>;

    const referencedThreadIds = new Set(Object.values(nextProjectDraftThreadIdByProjectId));
    for (const threadId of Object.keys(nextDraftThreadsByThreadId) as ThreadId[]) {
      if (referencedThreadIds.has(threadId)) {
        continue;
      }
      delete nextDraftThreadsByThreadId[threadId];
      removedThreadIds.add(threadId);
      changed = true;
    }

    if (!changed) {
      return state;
    }

    let nextDraftsByThreadId = state.draftsByThreadId;
    if (removedThreadIds.size > 0) {
      nextDraftsByThreadId = { ...state.draftsByThreadId };
      for (const threadId of removedThreadIds) {
        delete nextDraftsByThreadId[threadId];
      }
    }

    return {
      draftsByThreadId: nextDraftsByThreadId,
      draftThreadsByThreadId: nextDraftThreadsByThreadId,
      projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
    };
  });

  for (const threadId of removedThreadIds) {
    const existing = previousDraftsByThreadId[threadId];
    if (!existing) {
      continue;
    }
    for (const image of existing.images) {
      revokeObjectPreviewUrl(image.previewUrl);
    }
  }
}
