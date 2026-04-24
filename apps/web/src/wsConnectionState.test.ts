import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getWsConnectionState,
  noteWsConnectionAttempt,
  noteWsConnectionClosed,
  noteWsConnectionError,
  noteWsConnectionOpened,
  reconnectWsTransport,
  registerWsTransportReconnectHandler,
  resetWsConnectionStateForTests,
} from "./wsConnectionState";

describe("wsConnectionState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T18:00:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks the initial connecting attempt", () => {
    noteWsConnectionAttempt();

    expect(getWsConnectionState()).toEqual({
      phase: "connecting",
      attemptCount: 1,
      connectedAt: null,
      disconnectedAt: null,
      lastError: null,
      lastErrorAt: null,
    });
  });

  it("moves into reconnecting after a prior successful connection closes", () => {
    noteWsConnectionAttempt();
    noteWsConnectionOpened();
    noteWsConnectionClosed();

    expect(getWsConnectionState()).toMatchObject({
      phase: "reconnecting",
      attemptCount: 1,
      connectedAt: "2026-04-07T18:00:00.000Z",
      disconnectedAt: "2026-04-07T18:00:00.000Z",
    });

    vi.setSystemTime(new Date("2026-04-07T18:00:05.000Z"));
    noteWsConnectionAttempt();

    expect(getWsConnectionState()).toMatchObject({
      phase: "reconnecting",
      attemptCount: 2,
      connectedAt: "2026-04-07T18:00:00.000Z",
      disconnectedAt: "2026-04-07T18:00:00.000Z",
    });
  });

  it("moves into disconnected after an initial failure", () => {
    noteWsConnectionAttempt();
    noteWsConnectionError("Unable to connect to the F5 server WebSocket.");
    noteWsConnectionClosed();

    expect(getWsConnectionState()).toEqual({
      phase: "disconnected",
      attemptCount: 1,
      connectedAt: null,
      disconnectedAt: "2026-04-07T18:00:00.000Z",
      lastError: "Unable to connect to the F5 server WebSocket.",
      lastErrorAt: "2026-04-07T18:00:00.000Z",
    });
  });

  it("moves into reconnecting when retrying after an initial failure", () => {
    noteWsConnectionAttempt();
    noteWsConnectionError("Unable to connect to the F5 server WebSocket.");
    noteWsConnectionClosed();

    vi.setSystemTime(new Date("2026-04-07T18:00:05.000Z"));
    noteWsConnectionAttempt();

    expect(getWsConnectionState()).toMatchObject({
      phase: "reconnecting",
      attemptCount: 2,
      connectedAt: null,
      disconnectedAt: "2026-04-07T18:00:00.000Z",
      lastError: "Unable to connect to the F5 server WebSocket.",
      lastErrorAt: "2026-04-07T18:00:00.000Z",
    });
  });

  it("updates timestamps across open, error, and close events", () => {
    noteWsConnectionAttempt();

    vi.setSystemTime(new Date("2026-04-07T18:01:00.000Z"));
    noteWsConnectionOpened();
    expect(getWsConnectionState().connectedAt).toBe("2026-04-07T18:01:00.000Z");

    vi.setSystemTime(new Date("2026-04-07T18:02:00.000Z"));
    noteWsConnectionError("WebSocket connection error.");
    expect(getWsConnectionState().lastErrorAt).toBe("2026-04-07T18:02:00.000Z");

    vi.setSystemTime(new Date("2026-04-07T18:03:00.000Z"));
    noteWsConnectionClosed();
    expect(getWsConnectionState().disconnectedAt).toBe("2026-04-07T18:03:00.000Z");
  });

  it("registers and clears the reconnect handler", async () => {
    const reconnect = vi.fn(async () => undefined);
    const unregister = registerWsTransportReconnectHandler(reconnect);

    await reconnectWsTransport();
    expect(reconnect).toHaveBeenCalledTimes(1);

    unregister();
    await reconnectWsTransport();
    expect(reconnect).toHaveBeenCalledTimes(1);

    registerWsTransportReconnectHandler(reconnect);
    resetWsConnectionStateForTests();
    await reconnectWsTransport();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
