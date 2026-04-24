import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export const SLOW_RPC_THRESHOLD_MS = 2_500;

export type SlowRpcMethod =
  | typeof ORCHESTRATION_WS_METHODS.dispatchCommand
  | typeof ORCHESTRATION_WS_METHODS.getSnapshot;

export interface SlowRpcRequest {
  readonly requestId: string;
  readonly method: SlowRpcMethod;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly thresholdMs: number;
}

interface PendingSlowRpcRequest {
  readonly request: SlowRpcRequest;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

const TRACKED_SLOW_RPC_METHODS = new Set<SlowRpcMethod>([
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  ORCHESTRATION_WS_METHODS.getSnapshot,
]);

const pendingSlowRequestsById = new Map<string, PendingSlowRpcRequest>();
let slowRequests: ReadonlyArray<SlowRpcRequest> = [];
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setSlowRequests(nextRequests: ReadonlyArray<SlowRpcRequest>): void {
  slowRequests = [...nextRequests];
  emitChange();
}

function isTrackedSlowRpcMethod(method: string): method is SlowRpcMethod {
  return TRACKED_SLOW_RPC_METHODS.has(method as SlowRpcMethod);
}

function clearPendingSlowRequest(requestId: string): void {
  const pending = pendingSlowRequestsById.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingSlowRequestsById.delete(requestId);
}

function removeSlowRequest(requestId: string): void {
  if (!slowRequests.some((request) => request.requestId === requestId)) {
    return;
  }

  setSlowRequests(slowRequests.filter((request) => request.requestId !== requestId));
}

export function getSlowRpcRequests(): ReadonlyArray<SlowRpcRequest> {
  return slowRequests;
}

export function useSlowRpcRequests(): ReadonlyArray<SlowRpcRequest> {
  return useSyncExternalStore(subscribe, getSlowRpcRequests, getSlowRpcRequests);
}

export function trackSlowRpcRequestSent(requestId: string, method: string): void {
  if (!isTrackedSlowRpcMethod(method)) {
    return;
  }

  acknowledgeSlowRpcRequest(requestId);

  const startedAtMs = Date.now();
  const request: SlowRpcRequest = {
    requestId,
    method,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    thresholdMs: SLOW_RPC_THRESHOLD_MS,
  };
  const timeoutId = setTimeout(() => {
    pendingSlowRequestsById.delete(requestId);
    setSlowRequests([...slowRequests, request]);
  }, SLOW_RPC_THRESHOLD_MS);

  pendingSlowRequestsById.set(requestId, {
    request,
    timeoutId,
  });
}

export function acknowledgeSlowRpcRequest(requestId: string): void {
  clearPendingSlowRequest(requestId);
  removeSlowRequest(requestId);
}

export function clearTrackedSlowRpcRequests(requestIds: Iterable<string>): void {
  for (const requestId of requestIds) {
    acknowledgeSlowRpcRequest(requestId);
  }
}

export function resetRequestLatencyStateForTests(): void {
  for (const pending of pendingSlowRequestsById.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingSlowRequestsById.clear();
  slowRequests = [];
  emitChange();
}
