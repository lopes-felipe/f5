import {
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { PreviewAutomationResponseCache } from "./PreviewAutomationResponseCache";

function request(
  requestId: string,
  overrides: Partial<PreviewAutomationRequest> = {},
): PreviewAutomationRequest {
  return {
    requestId,
    clientId: "renderer-1",
    connectionId: "connection-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    tabId: "tab-1",
    operation: "status",
    input: {},
    timeoutMs: 1_000,
    ...overrides,
  };
}

function response(requestId: string): PreviewAutomationResponse {
  return {
    requestId,
    clientId: "renderer-1",
    connectionId: "connection-1",
    ok: true,
    result: { available: true },
  };
}

describe("PreviewAutomationResponseCache", () => {
  it("replays the cached response only for an identical request payload and connection", () => {
    const cache = new PreviewAutomationResponseCache();
    const original = request("request-1", { input: { url: "http://localhost:3000" } });
    const cachedResponse = response(original.requestId);
    cache.store(original, cachedResponse, 1_000);

    expect(cache.lookup({ ...original, input: { url: "http://localhost:3000" } }, 1_001)).toEqual({
      kind: "hit",
      response: cachedResponse,
    });
    expect(cache.lookup({ ...original, connectionId: "connection-2" }, 1_001)).toEqual({
      kind: "mismatch",
    });
    expect(cache.lookup({ ...original, input: { url: "http://localhost:4000" } }, 1_001)).toEqual({
      kind: "mismatch",
    });
  });

  it("expires responses after five minutes and caps retained request ids", () => {
    const cache = new PreviewAutomationResponseCache(2, 300_000);
    for (const requestId of ["request-1", "request-2", "request-3"]) {
      cache.store(request(requestId), response(requestId), 1_000);
    }

    expect(cache.size).toBe(2);
    expect(cache.lookup(request("request-1"), 1_001)).toEqual({ kind: "miss" });
    expect(cache.lookup(request("request-3"), 301_000)).toEqual({ kind: "miss" });
    expect(cache.size).toBe(0);
  });
});
