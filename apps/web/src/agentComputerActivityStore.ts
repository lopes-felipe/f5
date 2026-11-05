import { create } from "zustand";
import type {
  ComputerActivity,
  ComputerGrant,
  ComputerAccessPush,
  ComputerAccessSettled,
  AgentComputerUseChanged,
  AgentComputerUseHolder,
} from "@t3tools/contracts";
import { isAgentActivityRecent } from "./agentActivityWindow";
export const COMPUTER_ACCESS_HISTORY_LIMIT = 20;
export const COMPUTER_ACTION_HISTORY_LIMIT = 30;
type AccessRequest = typeof ComputerAccessPush.Type & {
  settled?: boolean;
  allowed?: boolean;
  persistence?: "durable" | "session-only";
  persistenceReason?: string;
};
type Activity = ComputerActivity & { at: number };
const EMPTY_REQUESTS: ReadonlyArray<AccessRequest> = [];

/** Object insertion order defines age, including after reconnect restoration. */
function pruneRequests(requests: Record<string, AccessRequest | undefined>) {
  const counts = new Map<string, number>();
  const settled = Object.values(requests).filter(
    (request): request is AccessRequest => !!request?.settled,
  );
  for (const request of settled)
    counts.set(request.threadId, (counts.get(request.threadId) ?? 0) + 1);
  let total = settled.length;
  for (const request of settled) {
    const count = counts.get(request.threadId)!;
    if (count > COMPUTER_ACCESS_HISTORY_LIMIT) {
      delete requests[request.requestId];
      counts.set(request.threadId, count - 1);
      --total;
    }
  }
  for (const request of settled) {
    if (total <= 200) break;
    if (Object.hasOwn(requests, request.requestId)) {
      delete requests[request.requestId];
      --total;
    }
  }
  return requests;
}
function indexRequests(
  requests: Record<string, AccessRequest | undefined>,
  previous: ComputerState["requestsByThread"],
) {
  const next: ComputerState["requestsByThread"] = {};
  for (const request of Object.values(requests)) {
    if (request) (next[request.threadId] ??= []).push(request);
  }
  for (const [threadId, entries] of Object.entries(next)) {
    const old = previous[threadId];
    if (
      old &&
      old.length === entries?.length &&
      entries?.every((entry, index) => old[index] === entry)
    )
      next[threadId] = old;
  }
  return next;
}
export { EMPTY_REQUESTS as EMPTY_COMPUTER_REQUESTS };
interface ComputerState {
  requestsByThread: Record<string, AccessRequest[] | undefined>;
  history: Record<string, Activity[] | undefined>;
  stopUnconfirmed: Record<string, boolean | undefined>;
  invalidate: (threadId: string) => void;
  markStopUnconfirmed: (threadId: string) => void;
  confirmStopIfReleased: (threadId: string) => void;
  appNames: Record<string, string | undefined>;
  activity: Record<string, (ComputerActivity & { at: number }) | undefined>;
  lastCapture: Record<string, (ComputerActivity & { at: number }) | undefined>;
  grants: Record<string, ReadonlyArray<ComputerGrant> | undefined>;
  requests: Record<string, AccessRequest | undefined>;
  paused: Record<string, boolean | undefined>;
  /** Every holder in this profile: delivery, target app, execution state and pause cause. */
  leases: typeof AgentComputerUseChanged.Type;
  lastLeaseAt: Record<string, number | undefined>;
  record: (activity: ComputerActivity) => void;
  request: (request: typeof ComputerAccessPush.Type) => void;
  settle: (event: typeof ComputerAccessSettled.Type) => void;
  setGrants: (threadId: string, grants: ReadonlyArray<ComputerGrant>) => void;
  setPaused: (threadId: string, paused: boolean) => void;
  resetConnection: () => void;
  setLeases: (leases: typeof AgentComputerUseChanged.Type) => void;
}
const NO_LEASES: typeof AgentComputerUseChanged.Type = { holders: [] };
export const useAgentComputerActivityStore = create<ComputerState>((set) => ({
  resetConnection: () =>
    set({
      requestsByThread: {},
      history: {},
      stopUnconfirmed: {},
      appNames: {},
      activity: {},
      lastCapture: {},
      grants: {},
      requests: {},
      paused: {},
      leases: NO_LEASES,
      lastLeaseAt: {},
    }),
  appNames: {},
  activity: {},
  lastCapture: {},
  grants: {},
  requests: {},
  paused: {},
  leases: NO_LEASES,
  lastLeaseAt: {},
  requestsByThread: {},
  history: {},
  stopUnconfirmed: {},
  invalidate: (threadId) =>
    set((state) => ({ lastCapture: { ...state.lastCapture, [threadId]: undefined } })),
  markStopUnconfirmed: (threadId) =>
    set((state) => ({
      stopUnconfirmed: { ...state.stopUnconfirmed, [threadId]: true },
      lastCapture: { ...state.lastCapture, [threadId]: undefined },
    })),
  confirmStopIfReleased: (threadId) =>
    set((state) => {
      if (
        state.leases.holders.some(
          (holder) => holder.threadId === threadId && holder.leaseHeld !== false,
        ) ||
        state.leases.pendingTakeover?.threadId === threadId
      )
        return state;
      return { stopUnconfirmed: { ...state.stopUnconfirmed, [threadId]: undefined } };
    }),
  record: (activity) =>
    set((state) => {
      const { thumbnailDataUrl, ...summary } = activity;
      const at = Date.now();
      const toolHistory =
        activity.source === "tool"
          ? {
              history: {
                ...state.history,
                [activity.threadId]: [
                  ...(state.history[activity.threadId] ?? []),
                  { ...summary, at },
                ].slice(-COMPUTER_ACTION_HISTORY_LIMIT),
              },
            }
          : {};
      if (activity.source === "tool" && activity.status === "completed") return toolHistory;
      return {
        ...toolHistory,
        activity: { ...state.activity, [activity.threadId]: { ...summary, at } },
        lastCapture: {
          ...state.lastCapture,
          [activity.threadId]:
            activity.status === "completed" && thumbnailDataUrl
              ? { ...activity, at }
              : activity.op === "wait" && ["started", "completed"].includes(activity.status)
                ? state.lastCapture[activity.threadId]
                : undefined,
        },
      };
    }),
  request: (request) =>
    set((state) => {
      const requests = pruneRequests({ ...state.requests, [request.requestId]: request });
      return {
        requests,
        requestsByThread: indexRequests(requests, state.requestsByThread),
        appNames: {
          ...state.appNames,
          ...Object.fromEntries(request.apps.map((app) => [app.appId, app.name])),
        },
      };
    }),
  settle: (event) =>
    set((state) => {
      const request = state.requests[event.requestId];
      if (!request) return state;
      const requests = pruneRequests({
        ...state.requests,
        [event.requestId]: { ...request, ...event, settled: true },
      });
      return { requests, requestsByThread: indexRequests(requests, state.requestsByThread) };
    }),
  setGrants: (threadId, grants) =>
    set((state) => ({
      grants: { ...state.grants, [threadId]: grants },
      // A capture may include every granted app; discard it on any grant change.
      lastCapture: { ...state.lastCapture, [threadId]: undefined },
    })),
  setPaused: (threadId, paused) =>
    set((state) => ({
      paused: { ...state.paused, [threadId]: paused },
      lastCapture: { ...state.lastCapture, [threadId]: undefined },
    })),
  setLeases: (leases) =>
    set((state) => {
      const now = Date.now();
      const removed = state.leases.holders.filter(
        (holder) => !leases.holders.some((next) => next.threadId === holder.threadId),
      );
      return {
        leases,
        stopUnconfirmed: Object.fromEntries(
          Object.entries(state.stopUnconfirmed).filter(
            ([threadId]) =>
              leases.holders.some(
                (holder) => holder.threadId === threadId && holder.leaseHeld !== false,
              ) || leases.pendingTakeover?.threadId === threadId,
          ),
        ),
        appNames: {
          ...state.appNames,
          ...Object.fromEntries(
            leases.holders.flatMap((holder) =>
              holder.appId && holder.appName ? [[holder.appId, holder.appName]] : [],
            ),
          ),
        },
        lastLeaseAt: removed.length
          ? {
              ...state.lastLeaseAt,
              ...Object.fromEntries(removed.map((holder) => [holder.threadId, now])),
            }
          : state.lastLeaseAt,
      };
    }),
}));
export function computerHolderFor(
  leases: typeof AgentComputerUseChanged.Type,
  threadId: string,
): AgentComputerUseHolder | undefined {
  return leases.holders.find((holder) => holder.threadId === threadId);
}
export function isAgentComputerActive(
  activity: (ComputerActivity & { at: number }) | undefined,
  now: number,
  held: boolean,
  lastLeaseAt?: number,
): boolean {
  return (
    held ||
    (lastLeaseAt !== undefined && isAgentActivityRecent(lastLeaseAt, now)) ||
    (!!activity && (activity.status === "started" || isAgentActivityRecent(activity.at, now)))
  );
}
