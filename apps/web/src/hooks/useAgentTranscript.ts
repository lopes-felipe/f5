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
    (mode: "tail" | "earlier" | "latest" | "drain" = "tail") =>
      runAgentTranscriptRequest(key, async () => {
        const store = useAgentTranscriptStore.getState();
        let current = store.entries[key] ?? newTranscriptState();
        if (current.inFlight) return;
        if ((mode === "tail" || mode === "drain") && current.detachedFromLatest) return;
        if (mode === "latest") current = newTranscriptState();
        const requestId = ++requestSequence;
        store.update(key, () => ({ ...current, inFlight: true, requestId }));
        lastRequest.current = Date.now();
        let cursor =
          mode === "earlier" ? current.earlierCursor : (current.nextCursor ?? current.tailCursor);
        // Initial opens and settlement drain fully. Each live refresh yields
        // after four requests so catch-up cannot monopolize the connection.
        const maxRequests = mode === "tail" && current.loaded ? 4 : Infinity;
        let requests = 0;
        try {
          do {
            const args: AgentsReadTranscriptInput = {
              threadId: input.threadId,
              workItemIds: ids.split("\u0000"),
              limit: mode === "tail" && current.loaded ? 50 : 200,
              ...(cursor && mode !== "latest" ? { cursor } : { anchor: "latest" }),
            };
            const page = await ensureNativeApi().agents.readTranscript(args);
            requests++;
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
            if (!cursor || requests >= maxRequests) break;
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
      (state.availability === "unavailable" &&
        state.reason !== "not-started" &&
        state.reason !== "session-not-running")
    )
      return;
    const interval = setInterval(
      () => void request(),
      state.reason === "session-not-running" ? 10000 : 2000,
    );
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
  useEffect(() => {
    const current = useAgentTranscriptStore.getState().entries[key];
    if (!current) return;
    const settlement = input.live
      ? "idle"
      : current.observedLive || (current.pendingTail && current.settlement === "idle")
        ? "pending"
        : current.settlement;
    if (current.observedLive !== input.live || current.settlement !== settlement)
      useAgentTranscriptStore.getState().update(key, (existing) => ({
        ...existing,
        observedLive: input.live,
        settlement,
      }));
  }, [key, input.live, state.observedLive, state.settlement, state.pendingTail, state.loaded]);
  useEffect(() => {
    if (
      state.settlement !== "pending" ||
      input.live ||
      !input.visible ||
      state.detachedFromLatest ||
      connection.phase !== "connected"
    )
      return;
    return settleAgentTranscript({
      drain: async () => {
        // The first call may join an already-running bounded live refresh.
        do {
          await request("drain");
        } while (
          useAgentTranscriptStore.getState().entries[key]?.nextCursor &&
          !useAgentTranscriptStore.getState().entries[key]?.error &&
          useAgentTranscriptStore.getState().entries[key]?.availability === "ok" &&
          !useAgentTranscriptStore.getState().entries[key]?.detachedFromLatest
        );
      },
      refresh: () => request("drain"),
      onSettled: () => {
        if (useAgentTranscriptStore.getState().entries[key])
          useAgentTranscriptStore.getState().update(key, (existing) => ({
            ...existing,
            settlement: "complete",
          }));
      },
    });
  }, [
    key,
    input.live,
    input.visible,
    request,
    state.settlement,
    state.detachedFromLatest,
    connection.phase,
  ]);
  return {
    state,
    refresh: () => request(),
    loadEarlier: () => request("earlier"),
    jumpToLatest: () => request("latest"),
  };
}
