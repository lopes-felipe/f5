import type {
  MessageId,
  ThreadId,
  TurnId,
  UsageThreadTurn,
  UsageThreadTurns,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import {
  cacheMissesByAssistantMessageId,
  decodeStringMap,
  encodeStringMap,
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
import { usageQueryKeys, usageThreadTurnsQueryOptions } from "./usageReactQuery";

/**
 * A thread's recorded per-turn usage, oldest first, for the prompt cache
 * indicator. Loaded each time the thread opens; facts recorded while it is
 * open are merged in from the domain event stream, and a reconnect reloads it
 * because events may have been missed. Null while disabled, loading, or failed.
 */
export function useThreadCacheTurns(
  threadId: ThreadId | null,
  enabled: boolean,
): ReadonlyArray<UsageThreadTurn> | null {
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
  });

  useEffect(() => {
    if (!active) return;
    const queryKey = usageQueryKeys.threadTurns(threadId);
    return ensureNativeApi().orchestration?.onDomainEvent?.((event) => {
      const fact =
        event.type === "thread.usage-recorded" || event.type === "thread.session-set"
          ? event.payload.usageFact
          : undefined;
      if (!fact || fact.threadId !== threadId) return;
      // Before the first load there is nothing to merge into; the load
      // itself will include this fact.
      client.setQueryData<UsageThreadTurns>(queryKey, (current) =>
        current ? { turns: mergeThreadTurn(current.turns, fact) } : current,
      );
    });
  }, [active, client, threadId]);

  // The first connection loads through `enabled`; later ones reload.
  const lastConnectedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !connected || connection.connectedAt === null) return;
    const previous = lastConnectedAt.current;
    lastConnectedAt.current = connection.connectedAt;
    if (previous !== null && previous !== connection.connectedAt) {
      void client.invalidateQueries({ queryKey: usageQueryKeys.threadTurns(threadId) });
    }
  }, [active, client, connected, connection.connectedAt, threadId]);

  return active ? (query.data?.turns ?? null) : null;
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
 * Everything the miss pills and the context meter read. Message objects change
 * on every streamed delta, so the message-derived maps are memoized on string
 * signatures: the results keep their identity until a turn starts or ends,
 * and the timeline's row cache stays valid while a reply streams.
 */
export function useThreadPromptCache(input: {
  readonly threadId: ThreadId | null;
  readonly enabled: boolean;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly onSelectMessage: (messageId: MessageId) => void;
}): ThreadPromptCacheView {
  const turns = useThreadCacheTurns(input.threadId, input.enabled);
  const startsKey = turns ? encodeStringMap(turnStartTimes(input.messages)) : null;
  const replyKey = turns ? encodeStringMap(lastAssistantMessageIdByTurn(input.messages)) : null;
  const summary = useMemo(
    () =>
      turns && startsKey !== null
        ? summarizeThreadCache(turns, decodeStringMap<TurnId, string>(startsKey))
        : null,
    [startsKey, turns],
  );
  const replyByTurn = useMemo(
    () => (replyKey === null ? null : decodeStringMap<TurnId, MessageId>(replyKey)),
    [replyKey],
  );
  const missByAssistantMessageId = useMemo(
    () =>
      summary && replyByTurn ? cacheMissesByAssistantMessageId(summary, replyByTurn) : NO_MISSES,
    [replyByTurn, summary],
  );
  const onSelectMessage = useStableCallback(input.onSelectMessage);
  const meter = useMemo(
    () =>
      summary && replyByTurn && summary.turns.length > 0
        ? {
            summary,
            canSelectTurn: (turnId: TurnId) => replyByTurn.has(turnId),
            onSelectTurn: (turnId: TurnId) => {
              const messageId = replyByTurn.get(turnId);
              if (messageId) onSelectMessage(messageId);
            },
          }
        : null,
    [onSelectMessage, replyByTurn, summary],
  );
  return { missByAssistantMessageId, meter };
}
