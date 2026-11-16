import {
  AgentsSnapshot as AgentsSnapshotSchema,
  type AgentsDismissInput,
  type ThreadId,
} from "@t3tools/contracts";
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useMemo } from "react";

import type { AgentsPanelScope } from "../agentsPanelStore";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { useShallow } from "zustand/react/shallow";

import { useStore } from "../store";
import { selectThreadById } from "../threadSelectors";
import type { Project, Thread } from "../types";
import { onServerWelcome } from "../wsNativeApi";
import {
  buildAgentActivityIndex,
  deriveAgentsPanelModel,
  type AgentActivityThreadSource,
} from "./agentsModel";

export const agentsQueryKeys = {
  all: ["agents", "snapshot"] as const,
  global: ["agents", "snapshot", "all"] as const,
  threads: ["agents", "snapshot", "thread"] as const,
  thread: (threadId: ThreadId) => ["agents", "snapshot", "thread", threadId] as const,
};

type DecodedAgentsSnapshot = ReturnType<typeof decodeAgentsSnapshot>;

const EMPTY_STORE_ITEMS: readonly never[] = [];
const EMPTY_ACTIVITY_THREADS: ReadonlyArray<AgentActivityThreadSource> = [];

/** The thread fields the agents panel correlates with snapshot entries. */
export type AgentActivityThreadInput = Pick<Thread, "id" | "title" | "projectId" | "activities"> & {
  readonly history?: Pick<NonNullable<Thread["history"]>, "hasOlderActivities"> | undefined;
};

export function selectAgentActivityThreads(input: {
  readonly snapshot: DecodedAgentsSnapshot | null;
  readonly threads: ReadonlyArray<AgentActivityThreadInput>;
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

export function agentsSnapshotQueryOptions(threadId: ThreadId | null = null) {
  return queryOptions({
    queryKey: threadId ? agentsQueryKeys.thread(threadId) : agentsQueryKeys.global,
    queryFn: async () =>
      decodeAgentsSnapshot(
        await ensureNativeApi().agents.getSnapshot(threadId ? { threadId } : undefined),
      ),
    staleTime: 30_000,
  });
}

/** At most one thread-snapshot refetch per interval while pushes stream in. */
export const THREAD_SNAPSHOT_REFRESH_MS = 400;

const threadRefreshTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/**
 * Applies a global push. The global snapshot is replaced outright. Thread
 * snapshots are refetched instead of patched: the capped global push can
 * leave out a thread's completions and can't express removals, while a
 * refetch replaces the thread's rows authoritatively.
 */
export function applyPushedSnapshot(queryClient: QueryClient, decoded: DecodedAgentsSnapshot) {
  queryClient.setQueryData<DecodedAgentsSnapshot>(agentsQueryKeys.global, (current) =>
    current && current.generatedAt > decoded.generatedAt ? current : decoded,
  );
  if (threadRefreshTimers.has(queryClient)) return;
  threadRefreshTimers.set(
    queryClient,
    setTimeout(() => {
      threadRefreshTimers.delete(queryClient);
      void refreshThreadSnapshots(queryClient);
    }, THREAD_SNAPSHOT_REFRESH_MS),
  );
}

async function refreshThreadSnapshots(queryClient: QueryClient) {
  // A refetch reuses a first load that is still in flight instead of
  // restarting it, and that load may predate the push. Cancel it so the
  // refetch below starts fresh.
  await queryClient.cancelQueries({
    queryKey: agentsQueryKeys.threads,
    predicate: (query) => query.state.data === undefined && query.state.fetchStatus === "fetching",
  });
  await queryClient.invalidateQueries({ queryKey: agentsQueryKeys.threads, refetchType: "active" });
}

export async function dismissAgentWork(queryClient: QueryClient, input: AgentsDismissInput) {
  const result = await ensureNativeApi().agents.dismiss(input);
  await queryClient.invalidateQueries({ queryKey: agentsQueryKeys.all, refetchType: "active" });
  return result;
}

export function useAgentsPanelModel(options: {
  readonly threadId: ThreadId;
  readonly scope: AgentsPanelScope;
  readonly includeActivityIndex?: boolean;
}) {
  const includeActivityIndex = options.includeActivityIndex ?? true;
  const queryClient = useQueryClient();
  // The global snapshot always lists live work first, so it also backs the live
  // counts for both scopes; the thread query adds that thread's full history.
  const globalQuery = useQuery(agentsSnapshotQueryOptions(null));
  const threadQuery = useQuery({
    ...agentsSnapshotQueryOptions(options.threadId),
    enabled: options.scope === "thread",
  });
  const snapshotQuery = options.scope === "thread" ? threadQuery : globalQuery;
  const snapshotThreadIds = useMemo(
    () =>
      includeActivityIndex
        ? [
            ...new Set(
              [...(globalQuery.data?.entries ?? []), ...(threadQuery.data?.entries ?? [])].map(
                (entry) => entry.threadId,
              ),
            ),
          ]
        : EMPTY_STORE_ITEMS,
    [globalQuery.data, includeActivityIndex, threadQuery.data],
  );
  const threads = useAgentActivityThreadInputs(snapshotThreadIds);
  const projects = useStore((state) => (includeActivityIndex ? state.projects : EMPTY_STORE_ITEMS));

  useEffect(() => {
    const api = readNativeApi();
    if (!api?.agents) return;
    return api.agents.onSnapshotUpdated((snapshot) => {
      try {
        applyPushedSnapshot(queryClient, decodeAgentsSnapshot(snapshot));
      } catch (error) {
        console.warn("Ignored an invalid agents snapshot update.", error);
      }
    });
  }, [queryClient]);

  useEffect(
    () =>
      onServerWelcome(() => {
        void queryClient.invalidateQueries({
          queryKey: agentsQueryKeys.all,
          refetchType: "active",
        });
      }),
    [queryClient],
  );

  const globalModel = useDerivedAgentsModel(
    globalQuery.data ?? null,
    includeActivityIndex,
    threads,
    projects,
  );
  const threadModel = useDerivedAgentsModel(
    options.scope === "thread" ? (threadQuery.data ?? null) : null,
    includeActivityIndex,
    threads,
    projects,
  );
  const liveCounts = useMemo(
    () => ({
      thread:
        globalModel.threads.find((group) => group.threadId === options.threadId)?.liveCount ?? 0,
      all: globalModel.liveCount,
    }),
    [globalModel, options.threadId],
  );

  return {
    model: options.scope === "thread" ? threadModel : globalModel,
    liveCounts,
    snapshotQuery,
  };
}

const FIELDS_PER_ACTIVITY_THREAD = 5;

/**
 * The activity inputs of the threads a snapshot lists. Selected as a flat
 * field list so streaming deltas, which replace the thread object but keep
 * its title and activities, do not re-derive the agents model.
 */
function useAgentActivityThreadInputs(
  threadIds: ReadonlyArray<ThreadId>,
): ReadonlyArray<AgentActivityThreadInput> {
  const fields = useStore(
    useShallow((state) => {
      const flat: unknown[] = [];
      for (const threadId of threadIds) {
        const thread = selectThreadById(state, threadId);
        if (!thread) continue;
        flat.push(
          thread.id,
          thread.title,
          thread.projectId,
          thread.activities,
          thread.history?.hasOlderActivities ?? false,
        );
      }
      return flat;
    }),
  );
  return useMemo(() => {
    const inputs: AgentActivityThreadInput[] = [];
    for (let offset = 0; offset < fields.length; offset += FIELDS_PER_ACTIVITY_THREAD) {
      inputs.push({
        id: fields[offset] as Thread["id"],
        title: fields[offset + 1] as string,
        projectId: fields[offset + 2] as Thread["projectId"],
        activities: fields[offset + 3] as Thread["activities"],
        history: { hasOlderActivities: fields[offset + 4] as boolean },
      });
    }
    return inputs;
  }, [fields]);
}

function useDerivedAgentsModel(
  snapshot: DecodedAgentsSnapshot | null,
  includeActivityIndex: boolean,
  threads: ReadonlyArray<AgentActivityThreadInput>,
  projects: ReadonlyArray<Project>,
) {
  const activityThreads = useMemo<ReadonlyArray<AgentActivityThreadSource>>(() => {
    if (!includeActivityIndex) return EMPTY_ACTIVITY_THREADS;
    return selectAgentActivityThreads({ snapshot, threads, projects });
  }, [includeActivityIndex, projects, snapshot, threads]);
  const activityIndex = useMemo(() => buildAgentActivityIndex(activityThreads), [activityThreads]);
  return useMemo(
    () => deriveAgentsPanelModel({ snapshot, activityIndex, threads: activityThreads }),
    [activityIndex, activityThreads, snapshot],
  );
}
