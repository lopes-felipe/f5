import { create } from "zustand";
import type {
  ComputerActivity,
  ComputerGrant,
  ComputerAccessPush,
  ComputerAccessSettled,
  AgentComputerUseChanged,
} from "@t3tools/contracts";
import { isAgentActivityRecent } from "./agentActivityWindow";
interface ComputerState {
  appNames: Record<string, string | undefined>;
  activity: Record<string, (ComputerActivity & { at: number }) | undefined>;
  grants: Record<string, ReadonlyArray<ComputerGrant> | undefined>;
  requests: Record<
    string,
    (typeof ComputerAccessPush.Type & { settled?: boolean; allowed?: boolean }) | undefined
  >;
  paused: Record<string, boolean | undefined>;
  lease: typeof AgentComputerUseChanged.Type;
  record: (activity: ComputerActivity) => void;
  request: (request: typeof ComputerAccessPush.Type) => void;
  settle: (event: typeof ComputerAccessSettled.Type) => void;
  setGrants: (threadId: string, grants: ReadonlyArray<ComputerGrant>) => void;
  setPaused: (threadId: string, paused: boolean) => void;
  setLease: (lease: typeof AgentComputerUseChanged.Type) => void;
}
export const useAgentComputerActivityStore = create<ComputerState>((set) => ({
  appNames: {},
  activity: {},
  grants: {},
  requests: {},
  paused: {},
  lease: { threadId: null },
  record: (activity) =>
    set((state) => ({
      activity: { ...state.activity, [activity.threadId]: { ...activity, at: Date.now() } },
    })),
  request: (request) =>
    set((state) => ({
      requests: { ...state.requests, [request.requestId]: request },
      appNames: {
        ...state.appNames,
        ...Object.fromEntries(request.apps.map((app) => [app.appId, app.name])),
      },
    })),
  settle: (event) =>
    set((state) => {
      const request = state.requests[event.requestId];
      return request
        ? {
            requests: {
              ...state.requests,
              [event.requestId]: { ...request, settled: true, allowed: event.allowed },
            },
          }
        : state;
    }),
  setGrants: (threadId, grants) =>
    set((state) => ({ grants: { ...state.grants, [threadId]: grants } })),
  setPaused: (threadId, paused) =>
    set((state) => ({ paused: { ...state.paused, [threadId]: paused } })),
  setLease: (lease) => set({ lease }),
}));
export function isAgentComputerActive(
  activity: (ComputerActivity & { at: number }) | undefined,
  now: number,
  held: boolean,
): boolean {
  return (
    held ||
    (!!activity && (activity.status === "started" || isAgentActivityRecent(activity.at, now)))
  );
}
