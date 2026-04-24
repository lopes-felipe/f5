import { ORCHESTRATION_WS_METHODS, WS_CHANNELS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSlowRpcRequests,
  resetRequestLatencyStateForTests,
  SLOW_RPC_THRESHOLD_MS,
} from "./requestLatencyState";
import { getWsConnectionState, resetWsConnectionStateForTests } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { data?: unknown; type?: string };
type WsListener = (event?: WsEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(_url: string) {
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  error() {
    this.emit("error", { type: "error" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

function getSocket(index = sockets.length - 1): MockWebSocket {
  const socket = sockets[index];
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { hostname: "localhost", port: "3020", protocol: "http:" },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("routes valid push envelopes to channel listeners", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe(WS_CHANNELS.serverConfigUpdated, listener);

    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: { issues: [], providers: [] },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverConfigUpdated,
      data: { issues: [], providers: [] },
    });

    transport.dispose();
  });

  it("resolves pending requests for valid response envelopes", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.request("projects.list");
    const sent = socket.sent.at(-1);
    if (!sent) {
      throw new Error("Expected request envelope to be sent");
    }

    const requestEnvelope = JSON.parse(sent) as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: [] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: [] });

    transport.dispose();
  });

  it("drops malformed envelopes without crashing transport", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    const listener = vi.fn();
    transport.subscribe(WS_CHANNELS.serverConfigUpdated, listener);

    socket.serverMessage("{ invalid-json");
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 2,
        channel: 42,
        data: { bad: true },
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 3,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: { issues: [], providers: [] },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.serverConfigUpdated,
      data: { issues: [], providers: [] },
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    transport.dispose();
  });

  it("queues requests until the websocket opens and resolves the queued response", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const requestPromise = transport.request("projects.list");
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.sent).toHaveLength(1);

    const requestEnvelope = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        result: { projects: [{ id: "project-1" }] },
      }),
    );

    await expect(requestPromise).resolves.toEqual({ projects: [{ id: "project-1" }] });

    transport.dispose();
  });

  it("starts slow-request tracking only after the queued request is actually sent", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const requestPromise = transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
      command: { type: "noop" },
    });
    void requestPromise.catch(() => undefined);

    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);
    expect(getSlowRpcRequests()).toEqual([]);

    socket.open();
    expect(socket.sent).toHaveLength(1);

    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS - 1);
    expect(getSlowRpcRequests()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getSlowRpcRequests()).toMatchObject([
      {
        method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      },
    ]);

    transport.dispose();
  });

  it("schedules only one reconnect timer for repeated close events", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    socket.close();
    socket.close();

    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);

    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);

    transport.dispose();
  });

  it("does not let a stale socket close overwrite a newer connected socket", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const staleSocket = getSocket(0);

    (transport as unknown as { connect: () => void }).connect();
    const currentSocket = getSocket(1);
    currentSocket.open();
    staleSocket.close();

    expect(getWsConnectionState()).toMatchObject({
      phase: "connected",
      attemptCount: 2,
    });

    transport.dispose();
  });

  it("ignores stale socket messages", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const staleSocket = getSocket(0);

    (transport as unknown as { connect: () => void }).connect();
    const currentSocket = getSocket(1);
    currentSocket.open();

    const listener = vi.fn();
    transport.subscribe(WS_CHANNELS.serverConfigUpdated, listener);

    staleSocket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: { issues: [{ message: "stale" }], providers: [] },
      }),
    );
    currentSocket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 2,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: { issues: [], providers: [] },
      }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({
      type: "push",
      sequence: 2,
      channel: WS_CHANNELS.serverConfigUpdated,
      data: { issues: [], providers: [] },
    });

    transport.dispose();
  });

  it("ignores manual reconnect while the newest socket is still connecting", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    transport.reconnect();
    expect(sockets).toHaveLength(1);

    transport.dispose();
  });

  it("cancels the pending reconnect timer when reconnect is forced manually", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const firstSocket = getSocket();
    firstSocket.open();
    firstSocket.close();

    transport.reconnect();
    expect(sockets).toHaveLength(2);

    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(2);

    transport.dispose();
  });

  it("records the initial connection error message when the socket errors before opening", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    socket.error();

    expect(getWsConnectionState()).toMatchObject({
      phase: "connecting",
      attemptCount: 1,
      lastError: "Unable to connect to the F5 server WebSocket.",
    });

    transport.dispose();
  });

  it("records a live websocket error when the open socket emits an error", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    socket.error();

    expect(getWsConnectionState()).toMatchObject({
      phase: "connected",
      attemptCount: 1,
      lastError: "WebSocket connection error.",
    });

    transport.dispose();
  });
});
