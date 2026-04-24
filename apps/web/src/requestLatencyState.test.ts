import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeSlowRpcRequest,
  clearTrackedSlowRpcRequests,
  getSlowRpcRequests,
  resetRequestLatencyStateForTests,
  SLOW_RPC_THRESHOLD_MS,
  trackSlowRpcRequestSent,
} from "./requestLatencyState";

describe("requestLatencyState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRequestLatencyStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks allowlisted requests as slow once they cross the threshold", () => {
    trackSlowRpcRequestSent("1", ORCHESTRATION_WS_METHODS.dispatchCommand);

    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS - 1);
    expect(getSlowRpcRequests()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getSlowRpcRequests()).toMatchObject([
      {
        requestId: "1",
        method: ORCHESTRATION_WS_METHODS.dispatchCommand,
        thresholdMs: SLOW_RPC_THRESHOLD_MS,
      },
    ]);
  });

  it("clears a slow request when the response is acknowledged", () => {
    trackSlowRpcRequestSent("1", ORCHESTRATION_WS_METHODS.getSnapshot);
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);
    expect(getSlowRpcRequests()).toHaveLength(1);

    acknowledgeSlowRpcRequest("1");
    expect(getSlowRpcRequests()).toEqual([]);
  });

  it("clears tracked requests when the transport closes or disposes", () => {
    trackSlowRpcRequestSent("1", ORCHESTRATION_WS_METHODS.dispatchCommand);
    trackSlowRpcRequestSent("2", ORCHESTRATION_WS_METHODS.getSnapshot);
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);
    expect(getSlowRpcRequests()).toHaveLength(2);

    clearTrackedSlowRpcRequests(["1", "2"]);
    expect(getSlowRpcRequests()).toEqual([]);
  });

  it("ignores git.runStackedAction", () => {
    trackSlowRpcRequestSent("1", WS_METHODS.gitRunStackedAction);
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toEqual([]);
  });

  it("ignores every non-allowlisted method", () => {
    trackSlowRpcRequestSent("1", "server.getConfig");
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toEqual([]);
  });
});
