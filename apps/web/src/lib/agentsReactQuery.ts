import { AgentsSnapshot as AgentsSnapshotSchema } from "@t3tools/contracts";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useMemo } from "react";

import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import {
  buildAgentActivityIndex,
  deriveAgentsPanelModel,
  type AgentActivityThreadSource,
} from "./agentsModel";

export const agentsQueryKeys = {
  snapshot: ["agents", "snapshot"] as const,
};

const EMPTY_STORE_ITEMS: readonly never[] = [];
const EMPTY_ACTIVITY_THREADS: ReadonlyArray<AgentActivityThreadSource> = [];

export function decodeAgentsSnapshot(value: unknown) {
  return Schema.decodeUnknownSync(AgentsSnapshotSchema)(value);
}

export function agentsSnapshotQueryOptions() {
  return queryOptions({
    queryKey: agentsQueryKeys.snapshot,
    queryFn: async () => decodeAgentsSnapshot(await ensureNativeApi().agents.getSnapshot()),
    staleTime: 30_000,
  });
}

export function useAgentsPanelModel(options: { readonly includeActivityIndex?: boolean } = {}) {
  const includeActivityIndex = options.includeActivityIndex ?? true;
  const queryClient = useQueryClient();
  const snapshotQuery = useQuery(agentsSnapshotQueryOptions());
  const threads = useStore((state) => (includeActivityIndex ? state.threads : EMPTY_STORE_ITEMS));
  const projects = useStore((state) => (includeActivityIndex ? state.projects : EMPTY_STORE_ITEMS));

  useEffect(() => {
    const api = readNativeApi();
    if (!api?.agents) return;
    return api.agents.onSnapshotUpdated((snapshot) => {
      try {
        queryClient.setQueryData(agentsQueryKeys.snapshot, decodeAgentsSnapshot(snapshot));
      } catch (error) {
        console.warn("Ignored an invalid agents snapshot update.", error);
      }
    });
  }, [queryClient]);

  const activityThreads = useMemo<ReadonlyArray<AgentActivityThreadSource>>(() => {
    if (!includeActivityIndex) return EMPTY_ACTIVITY_THREADS;
    const projectNameById = new Map(projects.map((project) => [project.id, project.name] as const));
    return threads.map((thread) => ({
      threadId: thread.id,
      threadTitle: thread.title,
      projectName: projectNameById.get(thread.projectId) ?? null,
      activities: thread.activities,
      hasOlderActivities: thread.history?.hasOlderActivities ?? false,
    }));
  }, [includeActivityIndex, projects, threads]);
  const activityIndex = useMemo(() => buildAgentActivityIndex(activityThreads), [activityThreads]);
  const model = useMemo(
    () =>
      deriveAgentsPanelModel({
        snapshot: snapshotQuery.data ?? null,
        activityIndex,
        threads: activityThreads,
      }),
    [activityIndex, activityThreads, snapshotQuery.data],
  );

  return { model, snapshotQuery };
}
