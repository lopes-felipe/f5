import {
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
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
}

type TransportState = "connecting" | "open" | "reconnecting" | "closed" | "disposed";

interface OutboundMessage {
  readonly id: string;
  readonly encoded: string;
  readonly method: string;
}

const REQUEST_TIMEOUT_MS = 60_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const INITIAL_CONNECTION_ERROR_MESSAGE = "Unable to connect to the F5 server WebSocket.";
const WS_CONNECTION_CLOSED_MESSAGE = "WebSocket connection closed.";
const DETACHED_SOCKET_GENERATION = -1;
const decodeWsResponse = decodeUnknownJsonResult(WsResponseSchema);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

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

export class WsTransport {
  private ws: WebSocket | null = null;
  private socketGeneration = 0;
  private authoritativeSocketGeneration = DETACHED_SOCKET_GENERATION;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private readonly outboundQueue: OutboundMessage[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private unregisterReconnectHandler: (() => void) | null = null;
  private readonly url: string;

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

    this.unregisterReconnectHandler = registerWsTransportReconnectHandler(() => this.reconnect());
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
    };

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              acknowledgeSlowRpcRequest(id);
              reject(new Error(`Request timed out: ${method}`));
            }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.send(outboundMessage);
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

    const currentSocket = this.ws;
    this.failPendingRequests("Transport disposed");
    this.outboundQueue.length = 0;
    this.detachAuthoritativeSocket();

    if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
      currentSocket.close();
    }
  }

  private connect() {
    if (this.disposed) {
      return;
    }

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

  private detachAuthoritativeSocket(): void {
    this.ws = null;
    this.authoritativeSocketGeneration = DETACHED_SOCKET_GENERATION;
  }

  private failPendingRequests(message: string): void {
    if (this.pending.size === 0) {
      this.outboundQueue.length = 0;
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

    this.outboundQueue.length = 0;
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
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private send(message: OutboundMessage) {
    if (this.disposed) {
      return;
    }

    this.outboundQueue.push(message);
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

    while (this.outboundQueue.length > 0) {
      const message = this.outboundQueue.shift();
      if (!message) {
        continue;
      }

      try {
        this.ws.send(message.encoded);
        trackSlowRpcRequestSent(message.id, message.method);
      } catch (error) {
        this.outboundQueue.unshift(message);
        throw asError(error, "Failed to send WebSocket request.");
      }
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer !== null) {
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0]!;

    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
