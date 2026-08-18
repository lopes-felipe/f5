import { AgentsSnapshot as AgentsSnapshotSchema } from "@t3tools/contracts";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useMemo } from "react";

import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { Project, Thread } from "../types";
import { onServerWelcome } from "../wsNativeApi";
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

export function selectAgentActivityThreads(input: {
  readonly snapshot: ReturnType<typeof decodeAgentsSnapshot> | null;
  readonly threads: ReadonlyArray<Thread>;
  readonly projects: ReadonlyArray<Project>;
}): ReadonlyArray<AgentActivityThreadSource> {
  if (!input.snapshot || input.snapshot.entries.length === 0) {
    return EMPTY_ACTIVITY_THREADS;
  }

  // The durable snapshot is capped and is authoritative for which work items
  // the panel can render. Restrict the expensive activity correlation to those
  // threads instead of cloning and sorting every loaded activity in the app.
  const relevantThreadIds = new Set(input.snapshot.entries.map((entry) => entry.threadId));
  const projectNameById = new Map(
    input.projects.map((project) => [project.id, project.name] as const),
  );
  return input.threads
    .filter((thread) => relevantThreadIds.has(thread.id))
    .map((thread) => ({
      threadId: thread.id,
      threadTitle: thread.title,
      projectName: projectNameById.get(thread.projectId) ?? null,
      activities: thread.activities,
      hasOlderActivities: thread.history?.hasOlderActivities ?? false,
    }));
}

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
        const decoded = decodeAgentsSnapshot(snapshot);
        queryClient.setQueryData<ReturnType<typeof decodeAgentsSnapshot>>(
          agentsQueryKeys.snapshot,
          (current) => (current && current.generatedAt > decoded.generatedAt ? current : decoded),
        );
      } catch (error) {
        console.warn("Ignored an invalid agents snapshot update.", error);
      }
    });
  }, [queryClient]);

  useEffect(
    () =>
      onServerWelcome(() => {
        void queryClient.invalidateQueries({
          queryKey: agentsQueryKeys.snapshot,
          refetchType: "active",
        });
      }),
    [queryClient],
  );

  const activityThreads = useMemo<ReadonlyArray<AgentActivityThreadSource>>(() => {
    if (!includeActivityIndex) return EMPTY_ACTIVITY_THREADS;
    return selectAgentActivityThreads({
      snapshot: snapshotQuery.data ?? null,
      threads,
      projects,
    });
  }, [includeActivityIndex, projects, snapshotQuery.data, threads]);
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
