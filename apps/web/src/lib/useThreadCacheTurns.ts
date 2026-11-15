import type { MessageId, ThreadId, TurnId, UsageThreadTurns } from "@t3tools/contracts";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import {
  cacheMissesByAssistantMessageId,
  lastAssistantMessageIdByTurn,
  mergeThreadTurn,
  summarizeThreadCache,
  turnStartTimes,
  type ThreadCacheSummary,
  type TurnCacheSummary,
} from "../components/chat/cacheIndicator.logic";
import { useStableCallback } from "../hooks/useStableCallback";
import { ensureNativeApi } from "../nativeApi";
import type { ChatMessage } from "../types";
import { useWsConnectionState } from "../wsConnectionState";
import {
  noteLiveThreadTurnFact,
  usageQueryKeys,
  usageThreadTurnsQueryOptions,
} from "./usageReactQuery";

interface ThreadUsageSubscription {
  references: number;
  connectedAt: string | null;
  unsubscribe: (() => void) | undefined;
}
const threadUsageSubscriptions = new WeakMap<QueryClient, Map<ThreadId, ThreadUsageSubscription>>();

/**
 * A thread's recorded per-turn usage, oldest first, for the prompt cache
 * indicator. Loaded each time the thread opens; facts recorded while it is
 * open are merged in from the domain event stream, including facts that land
 * while a load is in flight, and a reconnect reloads it because events may
 * have been missed. Null while disabled, loading, or failed.
 */
export function useThreadCacheTurns(
  threadId: ThreadId | null,
  enabled: boolean,
): UsageThreadTurns | null {
  const client = useQueryClient();
  const connection = useWsConnectionState();
  const connected = connection.phase === "connected";
  const active = enabled && threadId !== null;
  const query = useQuery({
    ...usageThreadTurnsQueryOptions({
      // The key is never read while disabled.
      threadId: threadId ?? ("" as ThreadId),
      enabled: active && connected,
    }),
    // Only the data is read. Loading, error and retry transitions must not
    // re-render the conversation that hosts this hook.
    notifyOnChangeProps: ["data"],
  });

  useEffect(() => {
    if (!active) return;
    let subscriptions = threadUsageSubscriptions.get(client);
    if (!subscriptions) {
      subscriptions = new Map();
      threadUsageSubscriptions.set(client, subscriptions);
    }
    let subscription = subscriptions.get(threadId);
    if (!subscription) {
      subscription = { references: 0, connectedAt: null, unsubscribe: undefined };
      const queryKey = usageQueryKeys.threadTurns(threadId);
      subscription.unsubscribe = ensureNativeApi().orchestration?.onDomainEvent?.((event) => {
        const fact =
          event.type === "thread.usage-recorded" || event.type === "thread.session-set"
            ? event.payload.usageFact
            : undefined;
        if (!fact || fact.threadId !== threadId) return;
        // An in-flight load folds the fact into its response; loaded data takes
        // it now. Before the first load there is no data to merge into.
        noteLiveThreadTurnFact(fact);
        client.setQueryData<UsageThreadTurns>(queryKey, (current) =>
          current ? mergeThreadTurn(current, fact) : current,
        );
      });
      subscriptions.set(threadId, subscription);
    }
    subscription.references++;
    return () => {
      if (--subscription.references > 0) return;
      subscription.unsubscribe?.();
      subscriptions.delete(threadId);
      if (subscriptions.size === 0) threadUsageSubscriptions.delete(client);
    };
  }, [active, client, threadId]);

  // The first connection loads through `enabled`; later ones reload.
  useEffect(() => {
    if (!active || !connected || connection.connectedAt === null) return;
    const subscription = threadUsageSubscriptions.get(client)?.get(threadId);
    if (!subscription) return;
    const previous = subscription.connectedAt;
    subscription.connectedAt = connection.connectedAt;
    if (previous !== null && previous !== connection.connectedAt) {
      void client.invalidateQueries({ queryKey: usageQueryKeys.threadTurns(threadId) });
    }
  }, [active, client, connected, connection.connectedAt, threadId]);

  return active ? (query.data ?? null) : null;
}

export interface PromptCacheMeterView {
  readonly summary: ThreadCacheSummary;
  /** False for turns whose reply is not loaded in the timeline. */
  readonly canSelectTurn: (turnId: TurnId) => boolean;
  readonly onSelectTurn: (turnId: TurnId) => void;
}

export interface ThreadPromptCacheView {
  /** Missed turns keyed by the assistant message whose footer shows the pill. */
  readonly missByAssistantMessageId: ReadonlyMap<MessageId, TurnCacheSummary>;
  /** Null while disabled, loading, or for a thread with no recorded turns. */
  readonly meter: PromptCacheMeterView | null;
}

const NO_MISSES: ReadonlyMap<MessageId, TurnCacheSummary> = new Map();

/**
 * Changes when a turn can have started or ended: messages added at either
 * end, or the newest message gaining a turn. A streamed delta replaces the
 * newest message object without changing any of these, so the scans keyed on
 * it run once per turn boundary instead of once per delta.
 */
export function turnBoundaryKey(messages: ReadonlyArray<ChatMessage>): string {
  const first = messages[0];
  const last = messages.at(-1);
  return [
    messages.length,
    first?.id ?? "",
    first?.createdAt ?? "",
    last?.id ?? "",
    last?.role ?? "",
    last?.turnId ?? "",
    last?.createdAt ?? "",
  ].join("\n");
}

/**
 * Everything the miss pills and the context meter read. The message-derived
 * maps are recomputed only when `turnBoundaryKey` changes, so they keep their
 * identity, and the timeline's row cache stays valid, while a reply streams.
 */
export function useThreadPromptCache(input: {
  readonly threadId: ThreadId | null;
  readonly enabled: boolean;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly onSelectMessage: (messageId: MessageId) => void;
}): ThreadPromptCacheView {
  const history = useThreadCacheTurns(input.threadId, input.enabled);
  const boundaryKey = history ? turnBoundaryKey(input.messages) : null;
  // Read through a ref so the scans below depend on the key, not on each
  // message array a delta produces.
  const messagesRef = useRef(input.messages);
  messagesRef.current = input.messages;
  const derived = useMemo(
    () =>
      boundaryKey === null
        ? null
        : {
            starts: turnStartTimes(messagesRef.current),
            replyByTurn: lastAssistantMessageIdByTurn(messagesRef.current),
          },
    [boundaryKey],
  );
  const summary = useMemo(
    () => (history && derived ? summarizeThreadCache(history, derived.starts) : null),
    [derived, history],
  );
  const missByAssistantMessageId = useMemo(
    () =>
      summary && derived
        ? cacheMissesByAssistantMessageId(summary, derived.replyByTurn)
        : NO_MISSES,
    [derived, summary],
  );
  const onSelectMessage = useStableCallback(input.onSelectMessage);
  const meter = useMemo(
    () =>
      summary && derived && summary.turns.length > 0
        ? {
            summary,
            canSelectTurn: (turnId: TurnId) => derived.replyByTurn.has(turnId),
            onSelectTurn: (turnId: TurnId) => {
              const messageId = derived.replyByTurn.get(turnId);
              if (messageId) onSelectMessage(messageId);
            },
          }
        : null,
    [derived, onSelectMessage, summary],
  );
  return { missByAssistantMessageId, meter };
}
