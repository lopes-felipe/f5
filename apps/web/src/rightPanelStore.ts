import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export type RightPanelSurface =
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      line?: number | undefined;
      endLine?: number | undefined;
      column?: number | undefined;
    }
  | { id: "plan"; kind: "plan" }
  | { id: "preview"; kind: "preview" };

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
  open: (threadId: ThreadId, kind: Exclude<RightPanelSurfaceKind, "file">) => void;
  openFile: (threadId: ThreadId, input: OpenFileSurfaceInput) => RightPanelSurface;
  activateSurface: (threadId: ThreadId, surfaceId: string) => void;
  closeSurface: (threadId: ThreadId, surfaceId: string) => void;
  closeOtherSurfaces: (threadId: ThreadId, surfaceId: string) => void;
  closeSurfacesToRight: (threadId: ThreadId, surfaceId: string) => void;
  closeAllSurfaces: (threadId: ThreadId) => void;
  close: (threadId: ThreadId) => void;
  removeThread: (threadId: ThreadId) => void;
}

const EMPTY_THREAD_RIGHT_PANEL_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

function threadKey(threadId: ThreadId): string {
  return String(threadId);
}

function singletonSurface(kind: Exclude<RightPanelSurfaceKind, "file">): RightPanelSurface {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "plan":
      return { id: "plan", kind };
    case "preview":
      return { id: "preview", kind };
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

export const useRightPanelStore = create<RightPanelStoreState>()((set) => ({
  byThreadId: {},
  open: (threadId, kind) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        upsertSurface(current, singletonSurface(kind)),
      ),
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
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) => {
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
    })),
  closeOtherSurfaces: (threadId, surfaceId) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) => {
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
    })),
  closeSurfacesToRight: (threadId, surfaceId) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) => {
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
    })),
  closeAllSurfaces: (threadId) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        current.surfaces.length === 0
          ? current
          : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
      ),
    })),
  close: (threadId) =>
    set((state) => ({
      byThreadId: updateThread(state.byThreadId, threadId, (current) =>
        current.isOpen ? { ...current, isOpen: false } : current,
      ),
    })),
  removeThread: (threadId) =>
    set((state) => {
      const key = threadKey(threadId);
      if (!(key in state.byThreadId)) {
        return state;
      }
      const { [key]: _removed, ...rest } = state.byThreadId;
      return { byThreadId: rest };
    }),
}));
