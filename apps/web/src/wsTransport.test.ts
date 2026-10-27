import { noteWsSynchronized, noteWsResynchronizing } from "./wsConnectionState";
import { serverBootstrapFixture } from "./test/serverBootstrap";
import { F5_PROTOCOL_VERSION, F5_UPGRADE_REQUIRED_CLOSE_CODE } from "@t3tools/contracts";
import {
  getProtocolState,
  getServerSendLimits,
  resetProtocolStateForTests,
  protocolFetch,
} from "./protocolState";
import { ORCHESTRATION_WS_METHODS, WS_CHANNELS, WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSlowRpcRequests,
  resetRequestLatencyStateForTests,
  SLOW_RPC_THRESHOLD_MS,
} from "./requestLatencyState";
import { getWsConnectionState, resetWsConnectionStateForTests } from "./wsConnectionState";
import { jitterReconnectDelay, WsTransport } from "./wsTransport";

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { data?: unknown; type?: string; code?: number };
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

  constructor(readonly url: string) {
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

  close(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { type: "close", code });
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
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

function getSocket(index = sockets.length - 1): MockWebSocket {
  const socket = sockets[index];
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  sockets.length = 0;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
  resetProtocolStateForTests();

  const windowTarget = new EventTarget();
  Object.assign(windowTarget, {
    location: {
      href: "http://localhost:3020/app/",
      hash: "",
      hostname: "localhost",
      pathname: "/",
      port: "3020",
      protocol: "http:",
      search: "",
    },
    history: { replaceState: vi.fn(), state: null },
    desktopBridge: undefined,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowTarget,
  });

  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", {
    configurable: true,
    writable: true,
    value: "visible",
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentTarget,
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
  resetProtocolStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("retries a cold start quickly, then backs off repeated failures", () => {
    const transport = new WsTransport("ws://localhost:3020");
    getSocket().close();
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    getSocket().close();
    vi.advanceTimersByTime(2_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    transport.dispose();
  });
  it("cancels hung authentication on its deadline and retries without stale socket creation", async () => {
    let reply!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, _options?: RequestInit) =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    );
    globalThis.fetch = fetcher;
    const transport = new WsTransport();
    expect(fetcher).toHaveBeenCalledOnce();
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    expect(getWsConnectionState().lastError).toContain("timed out");
    reply({ ok: true } as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    transport.dispose();
    expect(fetcher.mock.calls[1]![1]!.signal?.aborted).toBe(true);
  });
  it("reconnect cancels older auth attempts and late auth cannot open an old socket", async () => {
    const replies: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, _options?: RequestInit) =>
        new Promise<Response>((resolve) => replies.push(resolve)),
    );
    globalThis.fetch = fetcher;
    const transport = new WsTransport();
    transport.reconnect();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    replies[0]!({ ok: true } as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
    replies[1]!({ ok: true } as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    transport.dispose();
  });
  it("expires stuck CONNECTING sockets and ignores their late open callbacks", async () => {
    const transport = new WsTransport("ws://localhost:3020"),
      old = getSocket();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(sockets).toHaveLength(2);
    old.open();
    expect(getWsConnectionState().phase).not.toBe("connected");
    getSocket().open();
    expect(getWsConnectionState().phase).toBe("connected");
    transport.dispose();
  });
  it("rejects no-timeout requests immediately after disposal", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    transport.dispose();
    await expect(
      transport.request(ORCHESTRATION_WS_METHODS.getSnapshot, undefined, { timeoutMs: null }),
    ).rejects.toThrow("disposed");
  });

  it("applies bounded reconnect jitter around the existing delay ladder", () => {
    expect(jitterReconnectDelay(1_000, () => 0)).toBe(800);
    expect(jitterReconnectDelay(1_000, () => 0.5)).toBe(1_000);
    expect(jitterReconnectDelay(1_000, () => 1)).toBe(1_200);
  });

  it("exchanges a URL-fragment token for a cookie before opening the browser websocket", async () => {
    window.location.hash = "#token=remote-secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock;

    const transport = new WsTransport();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/session",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ token: "remote-secret" }),
      }),
    );
    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/");

    transport.dispose();
  });

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

  it("preserves structured checkout conflicts for the recovery dialog", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();
    noteWsSynchronized();
    const promise = transport.request(WS_METHODS.gitCheckout, { cwd: "/repo", branch: "main" });
    const envelope = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const checkoutConflict = { cwd: "/repo", branch: "main", files: ["index.css"] };
    const rejection = expect(promise).rejects.toMatchObject({
      name: "WsRequestError",
      code: "GitCheckoutConflict",
      checkoutConflict,
    });
    socket.serverMessage(
      JSON.stringify({
        id: envelope.id,
        error: {
          message: "Local changes block branch switch.",
          code: "GitCheckoutConflict",
          checkoutConflict,
        },
      }),
    );
    await rejection;
    transport.dispose();
  });

  it("removes timed-out queued requests so they cannot execute after reconnect", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const requestPromise = transport.request("projects.list", undefined, { timeoutMs: 25 });
    const rejection = expect(requestPromise).rejects.toThrow("Request timed out: projects.list");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    socket.open();
    expect(socket.sent).toHaveLength(0);

    transport.dispose();
  });

  it("bounds requests queued before the websocket opens", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const pending = Array.from({ length: 256 }, () =>
      transport.request("projects.list", undefined, { timeoutMs: null }),
    );
    for (const request of pending) {
      void request.catch(() => undefined);
    }

    await expect(
      transport.request("projects.list", undefined, { timeoutMs: null }),
    ).rejects.toThrow("WebSocket request queue is full");

    transport.dispose();
  });

  it("starts slow-request tracking only after the queued request is actually sent", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();

    const requestPromise = transport.request(ORCHESTRATION_WS_METHODS.getSnapshot, {
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
        method: ORCHESTRATION_WS_METHODS.getSnapshot,
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

    vi.advanceTimersByTime(3_000);
    expect(sockets).toHaveLength(2);

    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);

    transport.dispose();
  });

  it("coalesces focus, online, and visibility probes to one per ten seconds", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(socket.sent).toHaveLength(1);
    const firstProbe = JSON.parse(socket.sent[0] ?? "{}") as {
      id: string;
      body: { _tag: string };
    };
    expect(firstProbe.body._tag).toBe(WS_METHODS.serverProbe);
    socket.serverMessage(JSON.stringify({ id: firstProbe.id, result: {} }));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(9_999);
    window.dispatchEvent(new Event("focus"));
    expect(socket.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    window.dispatchEvent(new Event("focus"));
    expect(socket.sent).toHaveLength(2);

    transport.dispose();
  });

  it("does not show foreground probes as slow user RPCs", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();

    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toEqual([]);
    transport.dispose();
  });

  it("closes and reconnects only the generation whose foreground probe times out", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const firstSocket = getSocket();
    firstSocket.open();

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(sockets).toHaveLength(2);
    const secondSocket = getSocket();
    secondSocket.open();
    expect(getWsConnectionState().phase).toBe("connected");

    transport.dispose();
  });

  it("does not let a stale probe failure close a newer socket generation", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const firstSocket = getSocket();
    firstSocket.open();
    window.dispatchEvent(new Event("focus"));

    transport.reconnect();
    const secondSocket = getSocket();
    secondSocket.open();
    await Promise.resolve();

    expect(secondSocket.readyState).toBe(MockWebSocket.OPEN);
    expect(getWsConnectionState().phase).toBe("connected");
    transport.dispose();
  });

  it("reconnects immediately on a foreground signal and removes listeners on disposal", () => {
    const transport = new WsTransport("ws://localhost:3020");
    const socket = getSocket();
    socket.open();
    socket.close();

    window.dispatchEvent(new Event("online"));
    expect(sockets).toHaveLength(2);

    transport.dispose();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sockets).toHaveLength(2);
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

  it("replaces a connecting socket when reconnect is requested", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    transport.reconnect();
    expect(sockets).toHaveLength(2);

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

describe("protocol upgrades", () => {
  it("installs welcome limits before notifying subscribers and refreshes them on reconnect", () => {
    const transport = new WsTransport("ws://localhost:3020/");
    const observed: number[] = [];
    transport.subscribe(WS_CHANNELS.serverWelcome, () =>
      observed.push(getServerSendLimits().maxInputChars),
    );
    const welcome = (maxInputChars: number) =>
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverWelcome,
        data: {
          cwd: "/repo",
          projectName: "repo",
          bootstrap: {
            ...serverBootstrapFixture,
            sendLimits: { ...serverBootstrapFixture.sendLimits, maxInputChars },
          },
        },
      });
    getSocket().open();
    getSocket().serverMessage(welcome(42));
    getSocket().close();
    vi.advanceTimersByTime(3_000);
    getSocket().open();
    getSocket().serverMessage(welcome(84));
    expect(observed).toEqual([42, 84]);
    transport.dispose();
  });

  it("sends the current version on initial connection and reconnect", () => {
    const transport = new WsTransport("ws://localhost:3020/?token=secret&protocol=old");
    expect(new URL(getSocket().url).searchParams.get("protocol")).toBe(String(F5_PROTOCOL_VERSION));
    expect(new URL(getSocket().url).searchParams.get("token")).toBe("secret");
    getSocket().open();
    getSocket().close();
    vi.advanceTimersByTime(3_000);
    expect(new URL(getSocket().url).searchParams.get("protocol")).toBe(String(F5_PROTOCOL_VERSION));
    transport.dispose();
  });
  it("stops retrying and rejects requests after an upgrade-required close", async () => {
    const transport = new WsTransport("ws://localhost:3020/");
    getSocket().open();
    const request = transport.request("server.probe");
    const rejected = expect(request).rejects.toThrow("F5 was updated. Reload to continue.");
    getSocket().close(F5_UPGRADE_REQUIRED_CLOSE_CODE);
    await rejected;
    expect(getProtocolState().upgradeRequired).toBe(true);
    vi.advanceTimersByTime(60_000);
    transport.reconnect();
    expect(sockets).toHaveLength(1);
    await expect(transport.request("server.probe")).rejects.toThrow("F5 was updated");
    transport.dispose();
  });
});

it.each([undefined, { ...serverBootstrapFixture, protocolVersion: F5_PROTOCOL_VERSION + 1 }])(
  "closes an incompatible welcome and stops reconnecting (%j)",
  (bootstrap) => {
    const transport = new WsTransport("ws://localhost:3020/");
    const listener = vi.fn();
    transport.subscribe(WS_CHANNELS.serverWelcome, listener);
    const socket = getSocket();
    socket.open();
    socket.serverMessage(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverWelcome,
        data: { cwd: "/repo", projectName: "repo", bootstrap },
      }),
    );
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(getProtocolState().upgradeRequired).toBe(true);
    expect(getWsConnectionState().lastError).toContain("F5 was updated");
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    transport.dispose();
  },
);

it.each([
  "/ws?token=secret",
  "./ws?token=secret",
  "//remote.example/ws?token=secret",
  "wss://remote.example/ws?token=secret",
])("resolves %s and preserves authentication on reconnect", (input) => {
  const expected = new URL(input, window.location.href);
  expected.searchParams.set("protocol", String(F5_PROTOCOL_VERSION));
  const transport = new WsTransport(input);
  expect(getSocket().url).toBe(expected.href);
  getSocket().open();
  getSocket().close();
  vi.advanceTimersByTime(3_000);
  expect(getSocket().url).toBe(expected.href);
  transport.dispose();
});

it("rejects timeout-free websocket requests when HTTP reports an upgrade, without waiting for socket traffic", async () => {
  const transport = new WsTransport("ws://localhost:3020/");
  const socket = getSocket();
  socket.open();
  const pending = transport.request("server.probe", {}, { timeoutMs: null });
  const rejected = expect(pending).rejects.toThrow("F5 was updated");
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 426 }));
  await expect(protocolFetch("/api/storage/restore", { method: "POST" })).rejects.toThrow(
    "F5 was updated",
  );
  await rejected;
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
  expect(getWsConnectionState().lastError).toContain("F5 was updated");
  transport.dispose();
});

it("admits stop and answers during resynchronization but never queues mutations offline", async () => {
  const transport = new WsTransport("ws://localhost:3020");
  const socket = sockets[0]!;
  socket.open();
  noteWsResynchronizing();
  for (const type of [
    "thread.turn.interrupt",
    "thread.approval.respond",
    "thread.user-input.respond",
  ]) {
    const pending = transport.request("orchestration.dispatchCommand", { command: { type } });
    const envelope = JSON.parse(socket.sent.at(-1)!);
    socket.serverMessage(JSON.stringify({ id: envelope.id, result: {} }));
    await pending;
  }
  const steer = transport.request("nextTurnQueue.steer", {});
  socket.serverMessage(JSON.stringify({ id: JSON.parse(socket.sent.at(-1)!).id, result: {} }));
  await steer;
  for (const method of [
    "providerAccount.logout",
    "githubAccount.loginStart",
    "nativeOperation.resolve",
  ])
    await expect(transport.request(method)).rejects.toMatchObject({ code: "ConnectionNotReady" });
  socket.close();
  await expect(
    transport.request("orchestration.dispatchCommand", {
      command: { type: "thread.turn.interrupt" },
    }),
  ).rejects.toMatchObject({ code: "ConnectionNotReady" });
  transport.dispose();
});

it("honours retryAfterMs for busy reads without replaying rejected mutations", async () => {
  const transport = new WsTransport("ws://localhost:3020");
  const socket = sockets[0]!;
  socket.open();
  const pending = transport.request("terminal.snapshot", {});
  const rejectBusy = () =>
    socket.serverMessage(
      JSON.stringify({
        id: JSON.parse(socket.sent.at(-1)!).id,
        error: { message: "busy", code: "RpcBusy", retryable: true, retryAfterMs: 500 },
      }),
    );
  rejectBusy();
  await vi.advanceTimersByTimeAsync(499);
  expect(socket.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(socket.sent).toHaveLength(2);
  socket.serverMessage(JSON.stringify({ id: JSON.parse(socket.sent.at(-1)!).id, result: null }));
  await pending;
  noteWsSynchronized();
  const mutation = transport.request("projects.writeFile", {});
  const rejected = expect(mutation).rejects.toMatchObject({ code: "RpcBusy" });
  rejectBusy();
  await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  expect(socket.sent).toHaveLength(3);
  transport.dispose();
});
