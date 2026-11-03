import type { AgentTranscriptItem, AgentTranscriptPage } from "@t3tools/contracts";
import { create } from "zustand";
import { forgetAgentTranscriptRequest } from "./agentTranscriptRequests";

export interface TranscriptState {
  items: AgentTranscriptItem[];
  nextCursor: string | null;
  earlierCursor: string | null;
  tailCursor: string | null;
  pendingTail: boolean;
  availability: AgentTranscriptPage["availability"];
  reason?: AgentTranscriptPage["reason"];
  droppedCount: number;
  detachedFromLatest: boolean;
  inFlight: boolean;
  requestId: number;
  loaded: boolean;
  error: string | null;
  observedLive: boolean;
  settlement: "idle" | "pending" | "complete";
}
export const newTranscriptState = (): TranscriptState => ({
  items: [],
  nextCursor: null,
  earlierCursor: null,
  tailCursor: null,
  pendingTail: false,
  availability: "ok",
  droppedCount: 0,
  detachedFromLatest: false,
  inFlight: false,
  requestId: 0,
  loaded: false,
  error: null,
  observedLive: false,
  settlement: "idle",
});
export const transcriptKey = (threadId: string, nativeWorkItemId: string) =>
  threadId + "\u0000" + nativeWorkItemId;
function comparePosition(a: AgentTranscriptItem, b: AgentTranscriptItem): number {
  if (!a.position || !b.position) return 0;
  return a.position.offset - b.position.offset || a.position.index - b.position.index;
}
export function mergeAgentTranscriptPage(
  state: TranscriptState,
  page: AgentTranscriptPage,
  position: "append" | "prepend",
): TranscriptState {
  if (page.reset) return newTranscriptState();
  if (page.availability === "unavailable")
    return {
      ...state,
      availability: page.availability,
      reason: page.reason,
      loaded: true,
      inFlight: false,
      error: null,
    };
  const map = new Map(state.items.map((item) => [item.id, item]));
  const existingIds = new Set(map.keys());
  for (const item of page.items) map.set(item.id, item);
  const ids =
    position === "prepend"
      ? [
          ...page.items.filter((item) => !existingIds.has(item.id)).map((item) => item.id),
          ...state.items.map((item) => item.id),
        ]
      : [...state.items.map((item) => item.id), ...page.items.map((item) => item.id)];
  const ordered = [...new Set(ids)].map((id) => map.get(id)!);
  if (ordered.every((item) => item.position !== undefined)) ordered.sort(comparePosition);
  const overflow = Math.max(0, ordered.length - 2000);
  const items = position === "prepend" ? ordered.slice(0, 2000) : ordered.slice(-2000);
  const first = state.items[0];
  // Floor refreshes can revisit already-evicted history. Count only entries
  // newly displaced from this window, not those historical rereads.
  const newlyDropped =
    position === "append"
      ? ordered
          .slice(0, overflow)
          .filter((item) => !first?.position || !item.position || comparePosition(item, first) >= 0)
          .length
      : 0;
  return {
    ...state,
    ...page,
    reason: page.reason,
    pendingTail: position === "prepend" ? state.pendingTail : page.pendingTail,
    items,
    earlierCursor:
      items[0]?.earlierCursor !== undefined
        ? items[0].earlierCursor
        : position === "prepend" || !state.loaded
          ? page.earlierCursor
          : state.earlierCursor,
    tailCursor: position === "prepend" ? state.tailCursor : page.tailCursor,
    nextCursor: position === "prepend" ? state.nextCursor : page.nextCursor,
    droppedCount: state.droppedCount + newlyDropped,
    detachedFromLatest: state.detachedFromLatest || (position === "prepend" && overflow > 0),
    loaded: true,
    inFlight: false,
    error: null,
  };
}
/** Derive folds from retained source rows so results arriving before calls also work. */
export function deriveTranscriptRows(
  state: TranscriptState,
  settled: boolean,
): AgentTranscriptItem[] {
  const calls = new Set(
    state.items.filter((item) => item.kind === "tool-call").map((item) => item.toolCallId),
  );
  const results = new Map(
    state.items
      .filter((item) => item.kind === "tool-result")
      .map((item) => [item.toolCallId, item]),
  );
  return state.items.flatMap<AgentTranscriptItem>((item) => {
    if (item.kind === "tool-result" && calls.has(item.toolCallId)) return [];
    if (item.kind !== "tool-call") return [item];
    const result = results.get(item.toolCallId);
    return [
      {
        ...item,
        ...(result
          ? {
              output: result.output,
              outputTruncated: result.outputTruncated,
              status: result.isError ? ("failed" as const) : ("completed" as const),
            }
          : settled && item.status === "running"
            ? { output: item.output || "No result", status: "completed" as const }
            : {}),
      },
    ];
  });
}
interface Store {
  entries: Record<string, TranscriptState>;
  order: string[];
  update: (key: string, fn: (state: TranscriptState) => TranscriptState) => void;
  evict: (key: string) => void;
}
export const useAgentTranscriptStore = create<Store>((set) => ({
  entries: {},
  order: [],
  update: (key, fn) =>
    set((state) => {
      const order = [...state.order.filter((entry) => entry !== key), key];
      const entries = { ...state.entries, [key]: fn(state.entries[key] ?? newTranscriptState()) };
      while (order.length > 8) {
        const removed = order.shift()!;
        forgetAgentTranscriptRequest(removed);
        delete entries[removed];
      }
      return { entries, order };
    }),
  evict: (key) =>
    set((state) => {
      forgetAgentTranscriptRequest(key);
      const { [key]: _removed, ...entries } = state.entries;
      return { entries, order: state.order.filter((entry) => entry !== key) };
    }),
}));
