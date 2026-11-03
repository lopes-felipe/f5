import type { AgentsReadTranscriptInput, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import { ensureNativeApi } from "../nativeApi";
import { useWsConnectionState } from "../wsConnectionState";
import { runAgentTranscriptRequest, settleAgentTranscript } from "../lib/agentTranscriptRequests";
import {
  mergeAgentTranscriptPage,
  newTranscriptState,
  transcriptKey,
  useAgentTranscriptStore,
} from "../lib/agentTranscriptStore";

const EMPTY = newTranscriptState();
let requestSequence = 0;
export function useAgentTranscript(input: {
  threadId: ThreadId;
  nativeWorkItemId: string;
  workItemIds: readonly string[];
  live: boolean;
  visible: boolean;
  revision: string;
}) {
  const key = transcriptKey(input.threadId, input.nativeWorkItemId);
  const state = useAgentTranscriptStore((store) => store.entries[key] ?? EMPTY);
  const connection = useWsConnectionState();
  const ids = input.workItemIds.join("\u0000");
  const lastRequest = useRef(0);
  const request = useCallback(
    (mode: "tail" | "earlier" | "latest" = "tail") =>
      runAgentTranscriptRequest(key, async () => {
        const store = useAgentTranscriptStore.getState();
        let current = store.entries[key] ?? newTranscriptState();
        if (current.inFlight) return;
        if (mode === "tail" && current.detachedFromLatest) return;
        if (mode === "latest") current = newTranscriptState();
        const requestId = ++requestSequence;
        store.update(key, () => ({ ...current, inFlight: true, requestId }));
        lastRequest.current = Date.now();
        let cursor =
          mode === "earlier" ? current.earlierCursor : (current.nextCursor ?? current.tailCursor);
        try {
          do {
            const args: AgentsReadTranscriptInput = {
              threadId: input.threadId,
              workItemIds: ids.split("\u0000"),
              limit: mode === "tail" && current.loaded ? 50 : 200,
              ...(cursor && mode !== "latest" ? { cursor } : { anchor: "latest" }),
            };
            const page = await ensureNativeApi().agents.readTranscript(args);
            // Closing a tab evicts it; a late response must not resurrect it.
            if (useAgentTranscriptStore.getState().entries[key]?.requestId !== requestId) return;
            store.update(key, (existing) => ({
              ...mergeAgentTranscriptPage(
                existing,
                page,
                mode === "earlier" ? "prepend" : "append",
              ),
              inFlight: true,
              requestId,
            }));
            if (page.reset) {
              cursor = null;
              mode = "latest";
              continue;
            }
            cursor = mode === "earlier" ? null : page.nextCursor;
            if (cursor && cursor === args.cursor)
              throw new Error(
                "The transcript reader could not advance. Retry after the provider finishes writing.",
              );
            mode = mode === "latest" ? "tail" : mode;
            if (!cursor) break;
          } while (useAgentTranscriptStore.getState().entries[key]);
          store.update(key, (existing) => ({ ...existing, inFlight: false }));
        } catch (cause) {
          if (useAgentTranscriptStore.getState().entries[key]?.requestId === requestId)
            store.update(key, (existing) => ({
              ...existing,
              inFlight: false,
              error: cause instanceof Error ? cause.message : "Transcript request failed.",
            }));
        }
      }),
    [key, input.threadId, ids],
  );
  useEffect(() => {
    if (input.visible && connection.phase === "connected") void request();
  }, [request, input.visible, connection.phase]);
  useEffect(() => {
    if (
      !input.visible ||
      !input.live ||
      connection.phase !== "connected" ||
      state.detachedFromLatest ||
      (state.availability === "unavailable" && state.reason !== "not-started")
    )
      return;
    const interval = setInterval(() => void request(), 2000);
    const timeout = setTimeout(
      () => void request(),
      Math.max(0, 1000 - (Date.now() - lastRequest.current)),
    );
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [
    request,
    input.live,
    input.visible,
    input.revision,
    connection.phase,
    state.detachedFromLatest,
    state.availability,
    state.reason,
  ]);
  const wasLive = useRef(input.live);
  const settlementPending = useRef(false);
  useEffect(() => {
    if (wasLive.current && !input.live) settlementPending.current = true;
    if (input.live) settlementPending.current = false;
    wasLive.current = input.live;
    if (
      !settlementPending.current ||
      !input.visible ||
      state.detachedFromLatest ||
      connection.phase !== "connected"
    )
      return;
    return settleAgentTranscript({
      drain: () => request(),
      refresh: () => request(),
      onSettled: () => {
        settlementPending.current = false;
      },
    });
  }, [input.live, input.visible, request, state.detachedFromLatest, connection.phase]);
  return {
    state,
    refresh: () => request(),
    loadEarlier: () => request("earlier"),
    jumpToLatest: () => request("latest"),
  };
}
