import type { TaskItem, ThreadId } from "@t3tools/contracts";
import { isTurnInProgress } from "@t3tools/shared/turnAssistantMessage";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { rpcQueryContext, rpcQueryMeta } from "../../lib/rpcQueryContext";
import { ensureNativeApi } from "../../nativeApi";
import type { Thread } from "../../types";

/** Enough of a thread's end to show its last exchange without opening it. */
const TAIL_MESSAGE_LIMIT = 12;
/** A running turn's tasks move without changing the query key. */
const RUNNING_TAIL_REFETCH_MS = 15_000;

interface TailMessage {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly turnId?: string | null | undefined;
}

export interface HomeThreadTail {
  /** The last prompt, whole. */
  readonly lastPrompt: string | null;
  /** The newest settled reply outside a turn still producing output, whole. */
  readonly lastReply: string | null;
  readonly tasks: ReadonlyArray<TaskItem>;
  /** True while the tail is being read and nothing is known yet. */
  readonly pending: boolean;
}

/** The sidebar peek's rule (`localThreadPeek`), on whole messages. */
export function tailFromMessages(
  messages: ReadonlyArray<TailMessage>,
  latestTurn: Pick<NonNullable<Thread["latestTurn"]>, "turnId" | "state"> | null,
): Pick<HomeThreadTail, "lastPrompt" | "lastReply"> {
  const inProgressTurnId =
    latestTurn && isTurnInProgress(latestTurn.state) ? latestTurn.turnId : null;
  const lastPrompt = messages.findLast(
    (message) => message.role === "user" && message.text.trim().length > 0,
  );
  const lastReply = messages.findLast(
    (message) =>
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0 &&
      (inProgressTurnId === null || message.turnId !== inProgressTurnId),
  );
  return { lastPrompt: lastPrompt?.text ?? null, lastReply: lastReply?.text ?? null };
}

function homeThreadTailQueryOptions(
  threadId: ThreadId,
  latestTurn: Pick<NonNullable<Thread["latestTurn"]>, "turnId" | "state"> | null,
) {
  return queryOptions({
    queryKey: [
      "home-thread-tail",
      threadId,
      latestTurn ? `${latestTurn.turnId}:${latestTurn.state}` : null,
    ] as const,
    queryFn: (context) =>
      ensureNativeApi().orchestration.getThreadTailDetails(
        { threadId, messageLimit: TAIL_MESSAGE_LIMIT, checkpointLimit: 0 },
        rpcQueryContext(context),
      ),
    staleTime: 30_000,
    meta: rpcQueryMeta("refresh-background"),
  });
}

/**
 * The selected thread's last exchange and tasks: from the store when the thread is loaded,
 * else one tail read, cached per latest turn. The read never touches the store, so
 * previewing a thread does not load it.
 */
export function useHomeThreadTail(thread: Thread | undefined): HomeThreadTail {
  const local =
    thread?.detailsLoaded === true ? tailFromMessages(thread.messages, thread.latestTurn) : null;
  // A loaded tail that ends mid-conversation may miss the exchange: ask the server then.
  const localComplete =
    local !== null &&
    !(thread?.history?.hasOlderMessages && (!local.lastPrompt || !local.lastReply));
  const running = isTurnInProgress(thread?.latestTurn?.state);
  const query = useQuery({
    ...homeThreadTailQueryOptions(thread?.id ?? ("" as ThreadId), thread?.latestTurn ?? null),
    enabled: thread !== undefined && !localComplete,
    refetchInterval: running ? RUNNING_TAIL_REFETCH_MS : false,
  });
  if (!thread) return { lastPrompt: null, lastReply: null, tasks: [], pending: false };
  if (localComplete && local) return { ...local, tasks: thread.tasks, pending: false };
  const remote = query.data ? tailFromMessages(query.data.messages, thread.latestTurn) : null;
  return {
    ...mergeHomeThreadTail(local, remote),
    tasks: query.data?.tasks ?? thread.tasks,
    pending: query.isPending && query.fetchStatus !== "idle",
  };
}

/**
 * The server's tail fills what the loaded messages miss. Each half is chosen on its own:
 * the read may still be loading, may have failed, or may end before the half the loaded
 * messages do hold.
 */
export function mergeHomeThreadTail(
  local: Pick<HomeThreadTail, "lastPrompt" | "lastReply"> | null,
  remote: Pick<HomeThreadTail, "lastPrompt" | "lastReply"> | null,
): Pick<HomeThreadTail, "lastPrompt" | "lastReply"> {
  return {
    lastPrompt: remote?.lastPrompt ?? local?.lastPrompt ?? null,
    lastReply: remote?.lastReply ?? local?.lastReply ?? null,
  };
}
