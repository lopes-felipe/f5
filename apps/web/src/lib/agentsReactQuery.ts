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

export function useAgentsPanelModel() {
  const queryClient = useQueryClient();
  const snapshotQuery = useQuery(agentsSnapshotQueryOptions());
  const threads = useStore((state) => state.threads);
  const projects = useStore((state) => state.projects);

  useEffect(() => {
    const api = readNativeApi();
    if (!api?.agents) return;
    return api.agents.onSnapshotUpdated((snapshot) => {
      queryClient.setQueryData(agentsQueryKeys.snapshot, snapshot);
    });
  }, [queryClient]);

  const activityThreads = useMemo<ReadonlyArray<AgentActivityThreadSource>>(() => {
    const projectNameById = new Map(projects.map((project) => [project.id, project.name] as const));
    return threads.map((thread) => ({
      threadId: thread.id,
      threadTitle: thread.title,
      projectName: projectNameById.get(thread.projectId) ?? null,
      activities: thread.activities,
      hasOlderActivities: thread.history?.hasOlderActivities ?? false,
    }));
  }, [projects, threads]);
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
