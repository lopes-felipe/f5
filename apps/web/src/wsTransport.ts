import {
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  WS_METHODS,
  WebSocketResponse,
  type WsResponse as WsResponseMessage,
  WsResponse as WsResponseSchema,
} from "@t3tools/contracts";
import { decodeUnknownJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import { Result, Schema } from "effect";

import {
  acknowledgeSlowRpcRequest,
  clearTrackedSlowRpcRequests,
  trackSlowRpcRequestSent,
} from "./requestLatencyState";
import {
  getWsConnectionState,
  noteWsConnectionAttempt,
  noteWsConnectionClosed,
  noteWsConnectionError,
  noteWsConnectionOpened,
  registerWsTransportReconnectHandler,
} from "./wsConnectionState";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface SubscribeOptions {
  readonly replayLatest?: boolean;
}

interface RequestOptions {
  readonly timeoutMs?: number | null;
  readonly trackLatency?: boolean;
}

export class WsRequestError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "WsRequestError";
    this.code = code;
  }
}

type TransportState = "connecting" | "open" | "reconnecting" | "closed" | "disposed";

interface OutboundMessage {
  readonly id: string;
  readonly encoded: string;
  readonly method: string;
  readonly trackLatency: boolean;
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTBOUND_QUEUE_SIZE = 256;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const FOREGROUND_PROBE_COALESCE_MS = 10_000;
const FOREGROUND_PROBE_TIMEOUT_MS = 3_000;
const INITIAL_CONNECTION_ERROR_MESSAGE = "Unable to connect to the F5 server WebSocket.";
const WS_CONNECTION_CLOSED_MESSAGE = "WebSocket connection closed.";
const AUTH_STATUS_PATH = "/auth/status";
const AUTH_SESSION_PATH = "/auth/session";
const DETACHED_SOCKET_GENERATION = -1;
const decodeWsResponse = decodeUnknownJsonResult(WsResponseSchema);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

export function jitterReconnectDelay(baseDelayMs: number, random = Math.random): number {
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(baseDelayMs * (0.8 + sample * 0.4));
}

const isWsPushMessage = (value: WsResponseMessage): value is WsPush =>
  "type" in value && value.type === "push";

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(fallback);
}

function authTokenFromLocationHash(): string | null {
  const hash = window.location.hash.replace(/^#/u, "");
  const token = new URLSearchParams(hash).get("token")?.trim();
  return token && token.length > 0 ? token : null;
}

function scrubAuthTokenFromLocationHash(): void {
  const params = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
  if (!params.has("token")) return;
  params.delete("token");
  const nextHash = params.size > 0 ? `#${params.toString()}` : "";
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${nextHash}`,
  );
}

async function ensureBrowserAuthSession(): Promise<void> {
  const token = authTokenFromLocationHash();
  if (token) {
    const response = await fetch(AUTH_SESSION_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      throw new Error("F5 authentication failed. Check the remote access token.");
    }
    scrubAuthTokenFromLocationHash();
    return;
  }

  const response = await fetch(AUTH_STATUS_PATH, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("F5 authentication is required. Open the authenticated remote access URL.");
  }
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private socketGeneration = 0;
  private authoritativeSocketGeneration = DETACHED_SOCKET_GENERATION;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  // Map preserves insertion order while making cancellation by request id O(1).
  // A timed-out request must never remain eligible for a later flush: doing so
  // can execute a mutation after its caller has already been told it failed.
  private readonly outboundQueue = new Map<string, OutboundMessage>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authConnectInFlight = false;
  private disposed = false;
  private unregisterReconnectHandler: (() => void) | null = null;
  private foregroundProbeGeneration: number | null = null;
  private lastForegroundProbe: {
    readonly generation: number;
    readonly startedAtMs: number;
  } | null = null;
  private readonly url: string;
  private readonly browserSessionAuth: boolean;
  private readonly handleWindowFocus = () => this.handleForegroundSignal();
  private readonly handleWindowOnline = () => this.handleForegroundSignal();
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.handleForegroundSignal();
    }
  };

  constructor(url?: string) {
    const bridgeUrl = window.desktopBridge?.getWsUrl();
    const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
    this.url =
      url ??
      (bridgeUrl && bridgeUrl.length > 0
        ? bridgeUrl
        : envUrl && envUrl.length > 0
          ? envUrl
          : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`);
    this.browserSessionAuth =
      url === undefined && !(bridgeUrl && bridgeUrl.length > 0) && !(envUrl && envUrl.length > 0);

    this.unregisterReconnectHandler = registerWsTransportReconnectHandler(() => this.reconnect());
    window.addEventListener("focus", this.handleWindowFocus);
    window.addEventListener("online", this.handleWindowOnline);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.connect();
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("Request method is required");
    }

    const id = String(this.nextId++);
    const body = params != null ? { ...params, _tag: method } : { _tag: method };
    const envelope: WsRequestEnvelope = { id, body };
    const outboundMessage: OutboundMessage = {
      id,
      encoded: JSON.stringify(envelope),
      method,
      trackLatency: options?.trackLatency ?? true,
    };

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              this.outboundQueue.delete(id);
              acknowledgeSlowRpcRequest(id);
              reject(new Error(`Request timed out: ${method}`));
            }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      try {
        this.send(outboundMessage);
      } catch (error) {
        if (timeout !== null) {
          clearTimeout(timeout);
        }
        this.pending.delete(id);
        this.outboundQueue.delete(id);
        reject(asError(error, `Failed to queue request: ${method}`));
      }
    });
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: SubscribeOptions,
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
    }

    const wrappedListener = (message: WsPush) => {
      listener(message as WsPushMessage<C>);
    };
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) {
        wrappedListener(latest);
      }
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  getState(): TransportState {
    if (this.disposed) {
      return "disposed";
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      return "open";
    }

    const connectionState = getWsConnectionState();
    if (connectionState.phase === "disconnected") {
      return "closed";
    }
    if (connectionState.phase === "reconnecting") {
      return "reconnecting";
    }
    return "connecting";
  }

  reconnect(): void {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const previousSocket = this.ws;
    if (previousSocket) {
      this.failPendingRequests(WS_CONNECTION_CLOSED_MESSAGE);
      noteWsConnectionClosed();
      this.detachAuthoritativeSocket();
    }

    this.connect();

    if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) {
      previousSocket.close();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.unregisterReconnectHandler?.();
    this.unregisterReconnectHandler = null;
    window.removeEventListener("focus", this.handleWindowFocus);
    window.removeEventListener("online", this.handleWindowOnline);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);

    const currentSocket = this.ws;
    this.failPendingRequests("Transport disposed");
    this.outboundQueue.clear();
    this.detachAuthoritativeSocket();

    if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
      currentSocket.close();
    }
  }

  private connect() {
    if (this.disposed) {
      return;
    }

    if (this.browserSessionAuth) {
      if (this.authConnectInFlight) return;
      this.authConnectInFlight = true;
      void ensureBrowserAuthSession().then(
        () => {
          this.authConnectInFlight = false;
          if (!this.disposed) this.openSocket();
        },
        (error: unknown) => {
          this.authConnectInFlight = false;
          if (this.disposed) return;
          noteWsConnectionError(
            error instanceof Error ? error.message : "F5 authentication failed.",
          );
          this.scheduleReconnect();
        },
      );
      return;
    }

    this.openSocket();
  }

  private openSocket() {
    if (this.disposed) return;

    noteWsConnectionAttempt();

    const ws = new WebSocket(this.url);
    const generation = ++this.socketGeneration;
    this.ws = ws;
    this.authoritativeSocketGeneration = generation;

    ws.addEventListener("open", () => {
      if (!this.isAuthoritativeSocket(generation, ws)) {
        if (ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
        return;
      }

      this.reconnectAttempt = 0;
      this.lastForegroundProbe = null;
      noteWsConnectionOpened();
      this.flushQueue();
    });

    ws.addEventListener("message", (event) => {
      if (!this.isAuthoritativeSocket(generation, ws)) {
        return;
      }

      this.handleMessage(event.data);
    });

    ws.addEventListener("close", () => {
      if (!this.isAuthoritativeSocket(generation, ws)) {
        return;
      }

      this.detachAuthoritativeSocket();
      this.failPendingRequests(WS_CONNECTION_CLOSED_MESSAGE);
      if (this.disposed) {
        return;
      }

      noteWsConnectionClosed();
      this.scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      if (!this.isAuthoritativeSocket(generation, ws)) {
        return;
      }

      if (ws.readyState !== WebSocket.OPEN) {
        noteWsConnectionError(INITIAL_CONNECTION_ERROR_MESSAGE);
      } else {
        noteWsConnectionError("WebSocket connection error.");
      }

      console.warn("WebSocket connection error", { type: event.type, url: this.url });
    });
  }

  private isAuthoritativeSocket(generation: number, ws: WebSocket): boolean {
    return this.authoritativeSocketGeneration === generation && this.ws === ws;
  }

  private handleForegroundSignal(): void {
    if (this.disposed) return;

    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      if (ws?.readyState !== WebSocket.CONNECTING) {
        this.reconnect();
      }
      return;
    }

    const generation = this.authoritativeSocketGeneration;
    const now = Date.now();
    if (this.foregroundProbeGeneration === generation) return;
    if (
      this.lastForegroundProbe?.generation === generation &&
      now - this.lastForegroundProbe.startedAtMs < FOREGROUND_PROBE_COALESCE_MS
    ) {
      return;
    }

    this.foregroundProbeGeneration = generation;
    this.lastForegroundProbe = { generation, startedAtMs: now };
    void this.request(
      WS_METHODS.serverProbe,
      {},
      { timeoutMs: FOREGROUND_PROBE_TIMEOUT_MS, trackLatency: false },
    )
      .catch((error: unknown) => {
        if (!this.isAuthoritativeSocket(generation, ws)) return;
        noteWsConnectionError(
          asError(error, "WebSocket foreground connectivity probe failed.").message,
        );
        if (ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
      })
      .finally(() => {
        if (this.foregroundProbeGeneration === generation) {
          this.foregroundProbeGeneration = null;
        }
      });
  }

  private detachAuthoritativeSocket(): void {
    this.ws = null;
    this.authoritativeSocketGeneration = DETACHED_SOCKET_GENERATION;
  }

  private failPendingRequests(message: string): void {
    if (this.pending.size === 0) {
      this.outboundQueue.clear();
      return;
    }

    clearTrackedSlowRpcRequests(this.pending.keys());
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
      this.pending.delete(id);
      pending.reject(new Error(message));
    }

    this.outboundQueue.clear();
  }

  private handleMessage(raw: unknown) {
    const result = decodeWsResponse(raw);
    if (Result.isFailure(result)) {
      console.warn("Dropped inbound WebSocket envelope", formatSchemaError(result.failure));
      return;
    }

    const message = result.success;
    if (isWsPushMessage(message)) {
      this.latestPushByChannel.set(message.channel, message);
      const channelListeners = this.listeners.get(message.channel);
      if (channelListeners) {
        for (const listener of channelListeners) {
          try {
            listener(message);
          } catch {
            // Swallow listener errors
          }
        }
      }
      return;
    }

    if (!isWebSocketResponseEnvelope(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    if (pending.timeout !== null) {
      clearTimeout(pending.timeout);
    }
    this.pending.delete(message.id);
    acknowledgeSlowRpcRequest(message.id);

    if (message.error) {
      pending.reject(new WsRequestError(message.error.message, message.error.code));
      return;
    }

    pending.resolve(message.result);
  }

  private send(message: OutboundMessage) {
    if (this.disposed) {
      return;
    }

    if (!this.outboundQueue.has(message.id) && this.outboundQueue.size >= MAX_OUTBOUND_QUEUE_SIZE) {
      throw new Error(
        `WebSocket request queue is full (${MAX_OUTBOUND_QUEUE_SIZE} pending requests).`,
      );
    }

    this.outboundQueue.set(message.id, message);
    try {
      this.flushQueue();
    } catch {
      // Swallow: flushQueue has queued the message for retry on reconnect
    }
  }

  private flushQueue() {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    while (this.outboundQueue.size > 0) {
      const first = this.outboundQueue.entries().next().value as
        | [string, OutboundMessage]
        | undefined;
      if (!first) break;
      const [id, message] = first;

      // The request may have timed out or been cancelled between enqueue and
      // flush. Drop it instead of producing a ghost RPC.
      if (!this.pending.has(id)) {
        this.outboundQueue.delete(id);
        continue;
      }

      try {
        this.ws.send(message.encoded);
        this.outboundQueue.delete(id);
        if (message.trackLatency) {
          trackSlowRpcRequestSent(message.id, message.method);
        }
      } catch (error) {
        throw asError(error, "Failed to send WebSocket request.");
      }
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer !== null) {
      return;
    }

    const baseDelay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0]!;
    const delay = jitterReconnectDelay(baseDelay);

    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
