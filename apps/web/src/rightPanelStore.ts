import type { PrQuickActionRequest } from "./lib/prQuickActions";
import type { PullRequestKey, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export type RightPanelSurface =
  | {
      id: `pr:${string}`;
      kind: "pull-request";
      key: PullRequestKey;
      url: string;
      initialAction?: PrQuickActionRequest | undefined;
    }
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files"; revealPath?: string }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      line?: number | undefined;
      endLine?: number | undefined;
      column?: number | undefined;
    }
  | { id: "plan"; kind: "plan" }
  | { id: "preview"; kind: "preview" }
  | { id: "agents"; kind: "agents" };

export type RightPanelSurfaceKind = RightPanelSurface["kind"];

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

export interface OpenFileSurfaceInput {
  relativePath: string;
  line?: number | undefined;
  endLine?: number | undefined;
  column?: number | undefined;
}

interface RightPanelStoreState {
  byThreadId: Record<string, ThreadRightPanelState>;
  /** Closed tabs across every thread, oldest first. */
  closedHistory: ClosedRightPanelSurface[];
  tabMenuThreadId: ThreadId | null;
  setTabMenuThread: (threadId: ThreadId | null) => void;
  moveSurface: (threadId: ThreadId, from: number, to: number) => void;
  /** Reopens the most recently closed tab in its own thread, skipping tabs already open. */
  reopenClosed: () => ClosedRightPanelSurface | null;
  open: (threadId: ThreadId, kind: Exclude<RightPanelSurfaceKind, "file" | "pull-request">) => void;
  /**
   * Adds a surface tab without opening the panel or changing the active tab unless
   * `activate` is set. Agent-initiated surfaces use this so they never steal focus.
   */
  addSurface: (
    threadId: ThreadId,
    kind: Exclude<RightPanelSurfaceKind, "file" | "pull-request">,
    options?: { readonly activate?: boolean },
  ) => void;
  consumePullRequestAction: (threadId: ThreadId, surfaceId: string, requestId: string) => void;
  openDirectory: (threadId: ThreadId, relativePath: string) => void;
  openPullRequest: (
    threadId: ThreadId,
    input: { key: PullRequestKey; url: string; initialAction?: PrQuickActionRequest | undefined },
  ) => void;
  openFile: (threadId: ThreadId, input: OpenFileSurfaceInput) => RightPanelSurface;
  activateSurface: (threadId: ThreadId, surfaceId: string) => void;
  closeSurface: (threadId: ThreadId, surfaceId: string) => void;
  closeOtherSurfaces: (threadId: ThreadId, surfaceId: string) => void;
  closeSurfacesToRight: (threadId: ThreadId, surfaceId: string) => void;
  closeAllSurfaces: (threadId: ThreadId) => void;
  close: (threadId: ThreadId) => void;
  removeThread: (threadId: ThreadId) => void;
}

export interface ClosedRightPanelSurface {
  threadId: ThreadId;
  surface: RightPanelSurface;
}

const MAX_CLOSED_HISTORY = 20;

const EMPTY_THREAD_RIGHT_PANEL_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

function threadKey(threadId: ThreadId): string {
  return String(threadId);
}

function singletonSurface(
  kind: Exclude<RightPanelSurfaceKind, "file" | "pull-request">,
): RightPanelSurface {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "plan":
      return { id: "plan", kind };
    case "preview":
      return { id: "preview", kind };
    case "agents":
      return { id: "agents", kind };
  }
}

export function createFileRightPanelSurface(input: OpenFileSurfaceInput): RightPanelSurface {
  return {
    id: `file:${input.relativePath}`,
    kind: "file",
    relativePath: input.relativePath,
    ...(input.line ? { line: input.line } : {}),
    ...(input.endLine ? { endLine: input.endLine } : {}),
    ...(input.column ? { column: input.column } : {}),
  };
}

function upsertSurface(
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
): ThreadRightPanelState {
  const existingIndex = current.surfaces.findIndex((entry) => entry.id === surface.id);
  const surfaces =
    existingIndex >= 0
      ? current.surfaces.map((entry, index) => (index === existingIndex ? surface : entry))
      : [...current.surfaces, surface];
  return {
    isOpen: true,
    surfaces,
    activeSurfaceId: surface.id,
  };
}

function updateThread(
  byThreadId: Record<string, ThreadRightPanelState>,
  threadId: ThreadId,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> {
  const key = threadKey(threadId);
  const current = byThreadId[key] ?? EMPTY_THREAD_RIGHT_PANEL_STATE;
  const next = updater(current);
  if (next === current) {
    return byThreadId;
  }
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(key in byThreadId)) {
      return byThreadId;
    }
    const { [key]: _removed, ...rest } = byThreadId;
    return rest;
  }
  return { ...byThreadId, [key]: next };
}

export function selectThreadRightPanelState(
  byThreadId: Record<string, ThreadRightPanelState>,
  threadId: ThreadId,
): ThreadRightPanelState {
  return byThreadId[threadKey(threadId)] ?? EMPTY_THREAD_RIGHT_PANEL_STATE;
}

/** How a surface's header toggle presents: hidden, open behind another tab, or visible. */
export type RightPanelSurfaceHeaderState = "closed" | "background" | "active";

export function selectSurfaceHeaderState(
  state: ThreadRightPanelState,
  surfaceId: string,
): RightPanelSurfaceHeaderState {
  if (!state.isOpen || !state.surfaces.some((surface) => surface.id === surfaceId)) {
    return "closed";
  }
  return state.activeSurfaceId === surfaceId ? "active" : "background";
}

/** Every explicit tab-close action uses the same bounded history. Hiding the panel does not. */
function closeWithHistory(
  state: RightPanelStoreState,
  threadId: ThreadId,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
) {
  const before = selectThreadRightPanelState(state.byThreadId, threadId);
  const byThreadId = updateThread(state.byThreadId, threadId, updater);
  if (byThreadId === state.byThreadId) return state;
  const remaining = new Set(
    selectThreadRightPanelState(byThreadId, threadId).surfaces.map((surface) => surface.id),
  );
  const removed = before.surfaces.filter((surface) => !remaining.has(surface.id));
  if (!removed.length) return { byThreadId };
  const removedIds = new Set(removed.map((surface) => surface.id));
  const closedHistory = [
    ...state.closedHistory.filter(
      (entry) => entry.threadId !== threadId || !removedIds.has(entry.surface.id),
    ),
    ...removed.map((surface) => ({ threadId, surface })),
  ].slice(-MAX_CLOSED_HISTORY);
  return { byThreadId, closedHistory };
}

export const useRightPanelStore = create<RightPanelStoreState>()((set, get) => ({
  byThreadId: {},
  closedHistory: [],
  tabMenuThreadId: null,
  setTabMenuThread: (tabMenuThreadId) => set({ tabMenuThreadId }),
  moveSurface: (threadId, from, to) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) => {
        if (
          !Number.isInteger(from) ||
          !Number.isInteger(to) ||
          from < 0 ||
          to < 0 ||
          from >= current.surfaces.length ||
          to >= current.surfaces.length ||
          from === to
        )
          return current;
        const surfaces = [...current.surfaces];
        const [surface] = surfaces.splice(from, 1);
        surfaces.splice(to, 0, surface!);
        return { ...current, surfaces };
      }),
    })),
  reopenClosed: () => {
    const state = get(),
      closedHistory = [...state.closedHistory];
    let reopened: ClosedRightPanelSurface | null = null;
    while (closedHistory.length) {
      const candidate = closedHistory.pop()!;
      const current = selectThreadRightPanelState(state.byThreadId, candidate.threadId);
      if (!current.surfaces.some((entry) => entry.id === candidate.surface.id)) {
        reopened = candidate;
        break;
      }
    }
    set({
      closedHistory,
      ...(reopened
        ? {
            byThreadId: updateThread(state.byThreadId, reopened.threadId, (panel) =>
              upsertSurface(panel, reopened!.surface),
            ),
          }
        : {}),
    });
    return reopened;
  },
  open: (threadId, kind) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        upsertSurface(current, singletonSurface(kind)),
      ),
    })),
  addSurface: (threadId, kind, options) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) => {
        const surface = singletonSurface(kind);
        if (options?.activate) return upsertSurface(current, surface);
        if (current.surfaces.some((entry) => entry.id === surface.id)) return current;
        return {
          ...current,
          surfaces: [...current.surfaces, surface],
          activeSurfaceId: current.activeSurfaceId ?? surface.id,
        };
      }),
    })),
  openPullRequest: (threadId, input) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        upsertSurface(current, { id: `pr:${input.key}`, kind: "pull-request", ...input }),
      ),
    })),
  consumePullRequestAction: (threadId, surfaceId, requestId) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) => {
        const target = current.surfaces.find((surface) => surface.id === surfaceId);
        if (target?.kind !== "pull-request" || target.initialAction?.id !== requestId)
          return current;
        return {
          ...current,
          surfaces: current.surfaces.map((surface) => {
            if (surface !== target) return surface;
            const { initialAction: _consumed, ...rest } = surface;
            return rest;
          }),
        };
      }),
    })),
  openDirectory: (threadId, relativePath) =>
    set((state) => ({
      byThreadId: {
        ...state.byThreadId,
        [threadKey(threadId)]: upsertSurface(
          state.byThreadId[threadKey(threadId)] ?? EMPTY_THREAD_RIGHT_PANEL_STATE,
          { id: "files", kind: "files", revealPath: relativePath },
        ),
      },
    })),
  openFile: (threadId, input) => {
    const surface = createFileRightPanelSurface(input);
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        upsertSurface(current, surface),
      ),
    }));
    return surface;
  },
  activateSurface: (threadId, surfaceId) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        current.surfaces.some((surface) => surface.id === surfaceId)
          ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
          : current,
      ),
    })),
  closeSurface: (threadId, surfaceId) =>
    set((state) =>
      closeWithHistory(state, threadId, (current) => {
        const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
        if (index < 0) {
          return current;
        }
        const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
        const activeStillExists = surfaces.some(
          (surface) => surface.id === current.activeSurfaceId,
        );
        const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
        return {
          ...current,
          isOpen: surfaces.length > 0,
          surfaces,
          activeSurfaceId: activeStillExists ? current.activeSurfaceId : (fallback?.id ?? null),
        };
      }),
    ),
  closeOtherSurfaces: (threadId, surfaceId) =>
    set((state) =>
      closeWithHistory(state, threadId, (current) => {
        const surface = current.surfaces.find((entry) => entry.id === surfaceId);
        if (!surface || current.surfaces.length === 1) {
          return current;
        }
        return {
          ...current,
          isOpen: true,
          surfaces: [surface],
          activeSurfaceId: surface.id,
        };
      }),
    ),
  closeSurfacesToRight: (threadId, surfaceId) =>
    set((state) =>
      closeWithHistory(state, threadId, (current) => {
        const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
        if (index < 0 || index === current.surfaces.length - 1) {
          return current;
        }
        const surfaces = current.surfaces.slice(0, index + 1);
        const activeStillExists = surfaces.some(
          (surface) => surface.id === current.activeSurfaceId,
        );
        return {
          ...current,
          surfaces,
          activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
        };
      }),
    ),
  closeAllSurfaces: (threadId) =>
    set((state) =>
      closeWithHistory(state, threadId, (current) =>
        current.surfaces.length === 0
          ? current
          : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
      ),
    ),
  close: (threadId) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        current.isOpen ? { ...current, isOpen: false } : current,
      ),
    })),
  removeThread: (threadId) =>
    set((state) => {
      const key = threadKey(threadId);
      const { [key]: _panel, ...byThreadId } = state.byThreadId;
      return {
        byThreadId,
        closedHistory: state.closedHistory.filter((entry) => entry.threadId !== threadId),
        tabMenuThreadId: state.tabMenuThreadId === threadId ? null : state.tabMenuThreadId,
      };
    }),
}));
