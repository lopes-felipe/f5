import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { AgentsStatusFilter } from "./lib/agentsModel";
import { createSafeZustandStorage } from "./lib/safeStorage";

export const LEGACY_AGENTS_PANEL_STORAGE_KEY = "t3code:agents-panel:v1";
export const AGENTS_PANEL_STORAGE_KEY = "f5:agents-panel:v1";

export type AgentsPanelScope = "thread" | "all";

export interface AgentsPanelPreferencesState {
  scope: AgentsPanelScope;
  backgroundTasksExpanded: boolean;
  statusFilter: AgentsStatusFilter;
  setScope: (scope: AgentsPanelScope) => void;
  setBackgroundTasksExpanded: (expanded: boolean) => void;
  setStatusFilter: (filter: AgentsStatusFilter) => void;
}

const agentsPanelStorage = createSafeZustandStorage(LEGACY_AGENTS_PANEL_STORAGE_KEY);

function normalizeScope(value: unknown): AgentsPanelScope {
  return value === "all" ? "all" : "thread";
}

function normalizeStatusFilter(value: unknown): AgentsStatusFilter {
  return value === "running" || value === "failed" || value === "done" ? value : "all";
}

/** App-wide Agents panel view preferences, shared by every thread. */
export const useAgentsPanelStore = create<AgentsPanelPreferencesState>()(
  persist(
    (set) => ({
      scope: "thread",
      backgroundTasksExpanded: false,
      statusFilter: "all",
      setScope: (scope) => set({ scope }),
      setBackgroundTasksExpanded: (backgroundTasksExpanded) => set({ backgroundTasksExpanded }),
      setStatusFilter: (statusFilter) => set({ statusFilter }),
    }),
    {
      name: AGENTS_PANEL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => agentsPanelStorage),
      partialize: (state) => ({
        scope: state.scope,
        backgroundTasksExpanded: state.backgroundTasksExpanded,
        statusFilter: state.statusFilter,
      }),
      merge: (persisted, current) => {
        const value = (persisted ?? {}) as Partial<AgentsPanelPreferencesState>;
        return {
          ...current,
          scope: normalizeScope(value.scope),
          backgroundTasksExpanded: value.backgroundTasksExpanded === true,
          statusFilter: normalizeStatusFilter(value.statusFilter),
        };
      },
    },
  ),
);
