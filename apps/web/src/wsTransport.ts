import { registerBrowserResourceReader } from "./lib/performanceCounters";
import { raceWithAbort } from "@t3tools/shared/abortSignal";
import {
  isReadOnlyRpc,
  rpcLane,
  rpcLaneByteBudget,
  rpcLongRunningTimeoutMs,
  rpcMethodPolicy,
  rpcRequiresRuntime,
} from "@t3tools/shared/rpcScheduling";
import {
  getProtocolState,
  requireProtocolUpgrade,
  setServerBootstrap,
  subscribeProtocolState,
} from "./protocolState";
import {
  F5_PROTOCOL_VERSION,
  F5_PROTOCOL_QUERY,
  F5_UPGRADE_REQUIRED_CLOSE_CODE,
  F5_UPGRADE_REQUIRED_MESSAGE,
  WS_CHANNELS,
} from "@t3tools/contracts";
import {
  type ServerRuntimeReadiness,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  WS_METHODS,
  WebSocketResponse,
  type GitCheckoutConflict,
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
import { countRpcDiagnostic, recordRpcQueueWait } from "./rpcDiagnostics";
import {
  getWsConnectionState,
  noteWsConnectionAttempt,
  noteWsConnectionClosed,
  noteWsConnectionError,
  noteWsConnectionOpened,
  registerWsTransportReconnectHandler,
  subscribeWsConnectionState,
} from "./wsConnectionState";
import {
  RpcRequestScheduler,
  utf8ByteLength,
  type RpcRequestClass,
  type ScheduledRpc,
} from "./wsRequestScheduler";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

interface SubscribeOptions {
  readonly replayLatest?: boolean;
}

/** Per-call scheduling context forwarded from callers such as React Query. */
export interface RequestContext {
  /** Background reads yield ordinary slots to interactive work and may be shed. */
  readonly priority?: "interactive" | "background";
  /** Aborting removes an unsent request; a sent one detaches its caller. */
  readonly signal?: AbortSignal;
}

export interface RequestOptions extends RequestContext {
  /** Overrides the method policy's deadline. `null` means no deadline. */
  readonly timeoutMs?: number | null;
  readonly trackLatency?: boolean;
  /** Set false to never retry `RpcBusy`, even for reads. */
  readonly retry?: boolean;
}

export class WsRequestError extends Error {
  readonly code: string | undefined;
  readonly checkoutConflict: GitCheckoutConflict | undefined;

  constructor(
    message: string,
    code?: string,
    checkoutConflict?: GitCheckoutConflict,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    /** `server` when the server answered the request; `client` for local scheduling failures. */
    readonly origin: "server" | "client" = "client",
  ) {
    super(message);
    this.name = "WsRequestError";
    this.code = code;
    this.checkoutConflict = checkoutConflict;
  }
}

/** Failures the transport already owns or that cannot succeed by repeating the query. */
const NON_RETRYABLE_QUERY_CODES = new Set([
  "RpcBusy",
  "ServerStarting",
  "ConnectionNotReady",
  "QueueExpired",
  "BackgroundShed",
  "RpcQueueFull",
  "RequestTooLarge",
  "ResponseEncodeFailed",
]);

/** React Query retry predicate: overload and scheduling failures are never retried there. */
export function isQueryRetryable(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof Error && error.message === F5_UPGRADE_REQUIRED_MESSAGE) return false;
  return !(error instanceof WsRequestError && NON_RETRYABLE_QUERY_CODES.has(error.code ?? ""));
}

type TransportState = "connecting" | "open" | "reconnecting" | "closed" | "disposed";

interface TransportRequest extends ScheduledRpc {
  readonly method: string;
  readonly encoded: string;
  readonly kind: "read" | "mutation" | "connection-control";
  /** Stop and answer controls may be sent before synchronization. */
  readonly control: boolean;
  readonly requiresRuntime: boolean;
  /** Socket generation at enqueue; a queued mutation never crosses into another socket. */
  readonly generation: number;
  readonly createdAtMs: number;
  /** Execution deadline from creation, or `null`. */
  readonly deadlineAtMs: number | null;
  /** Unsent deadline from creation, or `null`. */
  readonly queueDeadlineAtMs: number | null;
  readonly trackLatency: boolean;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  state: "queued" | "sent";
  /** The caller has been answered; a sent request may still hold its slot. */
  settled: boolean;
  everSent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  detachAbort: (() => void) | null;
}

interface RuntimeReadinessState {
  readonly generation: number;
  readonly incarnation: string | undefined;
  readonly state: ServerRuntimeReadiness["state"];
  /** `-1` when inferred from a `ServerStarting` response rather than reported. */
  readonly revision: number;
  readonly message: string | undefined;
}

const REQUEST_TIMEOUT_MS = 60_000;
/** Long operations keep their own execution deadline but must start within this window. */
const LONG_LANE_QUEUE_DEADLINE_MS = 60_000;
/** A sent request whose caller timed out keeps its slot until a late response or this grace. */
export const ORPHAN_RELEASE_GRACE_MS = 30_000;
/** Read retries after `RpcBusy`: at most three attempts in total. */
const RPC_BUSY_BACKOFF_MS = [250, 500];
const RUNTIME_PROBE_INTERVAL_MS = 1_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [500, 3_000, 4_000, 8_000, 16_000];
const FOREGROUND_PROBE_COALESCE_MS = 10_000;
const FOREGROUND_PROBE_TIMEOUT_MS = 3_000;
const INITIAL_CONNECTION_ERROR_MESSAGE = "Unable to connect to the F5 server WebSocket.";
const WS_CONNECTION_CLOSED_MESSAGE = "WebSocket connection closed.";
const WS_CONNECTION_TIMED_OUT_MESSAGE = "WebSocket connection timed out.";
const AUTH_STATUS_PATH = "/auth/status";
const AUTH_SESSION_PATH = "/auth/session";
const DETACHED_SOCKET_GENERATION = -1;
const decodeWsResponse = decodeUnknownJsonResult(WsResponseSchema);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

/** A mutation that never reached the server: nothing executed, so the caller keeps its draft. */
function connectionNotReadyError(): WsRequestError {
  return new WsRequestError(
    "Server changes are unavailable until reconnection and synchronization finish. Your draft is preserved.",
    "ConnectionNotReady",
    undefined,
    true,
  );
}

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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("The request was aborted.", "AbortError");
}

/** Reads `runtime` from a probe result without trusting its shape. */
function probeRuntime(result: unknown): ServerRuntimeReadiness | null {
  if (!result || typeof result !== "object" || !("runtime" in result)) return null;
  const runtime = (result as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object") return null;
  const { state, revision, message } = runtime as Record<string, unknown>;
  if (state !== "starting" && state !== "ready" && state !== "failed") return null;
  if (typeof revision !== "number") return null;
  return { state, revision, ...(typeof message === "string" ? { message } : {}) };
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

async function ensureBrowserAuthSession(signal: AbortSignal): Promise<void> {
  const token = authTokenFromLocationHash();
  if (token) {
    const response = await fetch(AUTH_SESSION_PATH, {
      method: "POST",
      signal,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    signal.throwIfAborted();
    if (!response.ok) {
      throw new Error("F5 authentication failed. Check the remote access token.");
    }
    scrubAuthTokenFromLocationHash();
    return;
  }

  const response = await fetch(AUTH_STATUS_PATH, {
    method: "GET",
    signal,
    credentials: "same-origin",
    cache: "no-store",
  });
  signal.throwIfAborted();
  if (!response.ok) {
    throw new Error("F5 authentication is required. Open the authenticated remote access URL.");
  }
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private socketGeneration = 0;
  private authoritativeSocketGeneration = DETACHED_SOCKET_GENERATION;
  private nextId = 1;
  /** Every request the transport still tracks: queued, sent, or detached but holding a slot. */
  private readonly requests = new Map<string, TransportRequest>();
  // A timed-out request must never remain eligible for a later flush: doing so
  // can execute a mutation after its caller has already been told it failed.
  private readonly scheduler = new RpcRequestScheduler<TransportRequest>();
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private runtime: RuntimeReadinessState | null = null;
  private runtimeProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeProbeInFlight = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authConnectInFlight = false;
  private authController: AbortController | null = null;
  private authGeneration = 0;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelAuthAttempt() {
    this.authGeneration++;
    this.authController?.abort();
    this.authController = null;
    this.authConnectInFlight = false;
  }
  private clearConnectionTimer() {
    if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
  }
  private disposed = false;
  private unsubscribeProtocolState: (() => void) | null = null;
  private unsubscribeConnectionState: (() => void) | null = null;
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

  private unregisterResourceReader: (() => void) | undefined;
  constructor(url?: string) {
    this.unregisterResourceReader = registerBrowserResourceReader("transport", () => ({
      pendingRpcs: this.requests.size,
      queuedRequests: this.scheduler.queuedCount,
      listeners: [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0),
      timers: Number(this.reconnectTimer !== null) + Number(this.connectionTimer !== null),
      connecting: Number(this.authConnectInFlight),
    }));
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
    this.unsubscribeProtocolState = subscribeProtocolState(() => {
      if (getProtocolState().upgradeRequired) this.stopForProtocolUpgrade();
    });
    // Mutations created during synchronization wait unsent until it finishes.
    this.unsubscribeConnectionState = subscribeWsConnectionState(() => {
      if (getWsConnectionState().synchronized) this.flushQueue();
    });
    this.connect();
  }

  private stopForProtocolUpgrade(): void {
    this.cancelAuthAttempt();
    this.clearConnectionTimer();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.ws;
    this.detachAuthoritativeSocket();
    this.failPendingRequests(F5_UPGRADE_REQUIRED_MESSAGE);
    noteWsConnectionClosed();
    noteWsConnectionError(F5_UPGRADE_REQUIRED_MESSAGE);
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(F5_UPGRADE_REQUIRED_CLOSE_CODE, "upgrade-required");
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const socketGeneration = this.socketGeneration;
    const startedAt = Date.now();
    // `null` (no execution deadline) is meaningful from both the caller and the
    // method policy; only an absent value falls back to the default.
    const policyTimeoutMs = rpcLongRunningTimeoutMs({
      ...(params as object | undefined),
      _tag: method,
    });
    const timeoutMs =
      options?.timeoutMs !== undefined
        ? options.timeoutMs
        : policyTimeoutMs !== undefined
          ? policyTimeoutMs
          : REQUEST_TIMEOUT_MS;
    const retryBusy = options?.retry !== false && isReadOnlyRpc(method);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce<T>(method, params, options, {
          startedAtMs: startedAt,
          timeoutMs: timeoutMs === null ? null : Math.max(1, timeoutMs - (Date.now() - startedAt)),
        });
      } catch (error) {
        // Only retry an explicit pre-execution rejection of a read. Never replay
        // mutations, disconnected work or a request accepted by the server.
        if (
          !retryBusy ||
          !(error instanceof WsRequestError) ||
          error.code !== "RpcBusy" ||
          error.origin !== "server" ||
          !error.retryable ||
          attempt >= RPC_BUSY_BACKOFF_MS.length ||
          this.disposed ||
          this.socketGeneration !== socketGeneration
        )
          throw error;
        const delay = Math.max(
          jitterReconnectDelay(RPC_BUSY_BACKOFF_MS[attempt]!),
          error.retryAfterMs ?? 0,
        );
        if (timeoutMs !== null && Date.now() - startedAt + delay >= timeoutMs) throw error;
        await new Promise<void>((resolve, reject) => {
          const signal = options?.signal;
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delay);
          const onAbort = () => {
            clearTimeout(timer);
            reject(abortError(signal!));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        if (this.disposed || this.socketGeneration !== socketGeneration)
          throw new Error(WS_CONNECTION_CLOSED_MESSAGE);
      }
    }
  }

  private requestOnce<T>(
    method: string,
    params: unknown,
    options: RequestOptions | undefined,
    deadline: { readonly startedAtMs: number; readonly timeoutMs: number | null },
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Transport disposed"));
    if (getProtocolState().upgradeRequired)
      return Promise.reject(new Error(F5_UPGRADE_REQUIRED_MESSAGE));
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new Error("Request method is required"));
    }
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const policy = rpcMethodPolicy(method);
    const kind = policy?.kind ?? "mutation";
    const lane = rpcLane({ ...(params as { command?: unknown } | undefined), _tag: method });
    const control = lane === "stop" || lane === "answer";
    if (kind === "mutation" && getWsConnectionState().phase !== "connected") {
      // A mutation is never queued offline: it would execute against state
      // the user can no longer see. One issued while connected but still
      // synchronizing waits unsent below instead.
      countRpcDiagnostic("rpcConnectionNotReady");
      return Promise.reject(connectionNotReadyError());
    }
    const id = String(this.nextId++);
    const body = params != null ? { ...params, _tag: method } : { _tag: method };
    const envelope: WsRequestEnvelope = { id, body };
    const encoded = JSON.stringify(envelope);
    const bytes = utf8ByteLength(encoded);
    if (bytes > rpcLaneByteBudget(lane)) {
      return Promise.reject(new WsRequestError("Request is too large to send.", "RequestTooLarge"));
    }
    const requestClass: RpcRequestClass =
      kind === "mutation"
        ? "mutation"
        : options?.priority === "background"
          ? "background"
          : "interactive";
    const now = Date.now();
    const deadlineAtMs = deadline.timeoutMs === null ? null : now + deadline.timeoutMs;
    const longQueueDeadline = deadline.startedAtMs + LONG_LANE_QUEUE_DEADLINE_MS;
    const queueDeadlineAtMs =
      lane !== "long"
        ? deadlineAtMs
        : deadlineAtMs === null
          ? longQueueDeadline
          : Math.min(deadlineAtMs, longQueueDeadline);

    return new Promise<T>((resolve, reject) => {
      const request: TransportRequest = {
        id,
        lane,
        requestClass,
        bytes,
        method,
        encoded,
        kind,
        control,
        requiresRuntime: rpcRequiresRuntime(body),
        generation: this.authoritativeSocketGeneration,
        createdAtMs: deadline.startedAtMs,
        deadlineAtMs,
        queueDeadlineAtMs,
        trackLatency: options?.trackLatency ?? true,
        resolve: resolve as (result: unknown) => void,
        reject,
        state: "queued",
        settled: false,
        everSent: false,
        timer: null,
        detachAbort: null,
      };
      if (!this.enqueue(request)) return;
      if (signal) {
        const onAbort = () => this.abortRequest(request, abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        request.detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      // Slow-request tracking starts at enqueue so a held mutation still shows it.
      if (request.trackLatency) trackSlowRpcRequestSent(id, method);
      this.flushQueue();
    });
  }

  /** Adds a request to its lane queue, or rejects it when the lane is full. */
  private enqueue(request: TransportRequest): boolean {
    request.state = "queued";
    const result = this.scheduler.enqueue(request);
    if (!result.ok) {
      this.finishRequest(
        request,
        new WsRequestError(
          `WebSocket request queue is full for the ${result.lane} lane.`,
          "RpcQueueFull",
          undefined,
          true,
        ),
      );
      return false;
    }
    this.requests.set(request.id, request);
    this.armTimer(request);
    if (result.evicted) {
      countRpcDiagnostic("rpcBackgroundShed");
      this.finishRequest(
        result.evicted,
        new WsRequestError(
          `Background request was dropped for foreground work: ${result.evicted.method}`,
          "BackgroundShed",
          undefined,
          true,
        ),
      );
    }
    return true;
  }

  /** Answers the caller once. Pass an Error to reject. */
  private settle(request: TransportRequest, outcome: Error | { readonly result: unknown }): void {
    if (request.settled) return;
    request.settled = true;
    request.detachAbort?.();
    request.detachAbort = null;
    if (outcome instanceof Error) request.reject(outcome);
    else request.resolve(outcome.result);
  }

  /** Stops tracking a request that holds no slot, and answers its caller. */
  private finishRequest(request: TransportRequest, outcome: Error | { readonly result: unknown }) {
    this.clearTimer(request);
    this.requests.delete(request.id);
    acknowledgeSlowRpcRequest(request.id);
    this.settle(request, outcome);
  }

  private clearTimer(request: TransportRequest): void {
    if (request.timer !== null) clearTimeout(request.timer);
    request.timer = null;
  }

  /**
   * One timer per request: the unsent deadline while queued, the execution
   * deadline once sent, and the orphan grace after a sent caller detaches.
   */
  private armTimer(request: TransportRequest): void {
    this.clearTimer(request);
    const at =
      request.state === "queued"
        ? request.queueDeadlineAtMs
        : request.settled
          ? request.deadlineAtMs === null
            ? null
            : Math.max(request.deadlineAtMs, Date.now()) + ORPHAN_RELEASE_GRACE_MS
          : request.deadlineAtMs;
    if (at === null) return;
    request.timer = setTimeout(() => this.handleDeadline(request), Math.max(0, at - Date.now()));
  }

  private handleDeadline(request: TransportRequest): void {
    request.timer = null;
    if (this.requests.get(request.id) !== request) return;
    if (request.state === "queued") {
      this.expireQueued(request);
      return;
    }
    if (!request.settled) {
      // The server may still be executing it: keep the slot until a late
      // response, or release it after a grace period.
      countRpcDiagnostic("rpcTimeouts");
      acknowledgeSlowRpcRequest(request.id);
      this.settle(request, new Error(`Request timed out: ${request.method}`));
      this.armTimer(request);
      return;
    }
    this.requests.delete(request.id);
    if (this.scheduler.release(request.id)) countRpcDiagnostic("rpcOrphanReleased");
    this.flushQueue();
  }

  /** An expired queued request is never sent. */
  private expireQueued(request: TransportRequest): void {
    this.scheduler.remove(request.id);
    countRpcDiagnostic("rpcQueueExpired");
    this.finishRequest(
      request,
      new WsRequestError(
        `Request timed out before it was sent: ${request.method}`,
        "QueueExpired",
        undefined,
        true,
      ),
    );
  }

  private abortRequest(request: TransportRequest, error: Error): void {
    if (this.requests.get(request.id) !== request || request.settled) return;
    if (request.state === "queued") {
      this.scheduler.remove(request.id);
      this.finishRequest(request, error);
      return;
    }
    // Sent: detach the caller; the slot stays held until the response arrives.
    acknowledgeSlowRpcRequest(request.id);
    this.settle(request, error);
    this.armTimer(request);
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
    if (getProtocolState().upgradeRequired) return;
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    this.cancelAuthAttempt();
    this.clearConnectionTimer();

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const previousSocket = this.ws;
    if (previousSocket) {
      this.failPendingRequests(WS_CONNECTION_CLOSED_MESSAGE, true);
      noteWsConnectionClosed();
      this.detachAuthoritativeSocket();
    }

    this.connect();

    if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) {
      previousSocket.close();
    }
  }

  dispose() {
    this.unregisterResourceReader?.();
    this.unregisterResourceReader = undefined;
    this.disposed = true;
    this.cancelAuthAttempt();
    this.clearConnectionTimer();
    this.unsubscribeProtocolState?.();
    this.unsubscribeProtocolState = null;
    this.unsubscribeConnectionState?.();
    this.unsubscribeConnectionState = null;
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
    this.detachAuthoritativeSocket();

    if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
      currentSocket.close();
    }
  }

  private connect() {
    if (this.disposed || getProtocolState().upgradeRequired) {
      return;
    }

    if (this.browserSessionAuth) {
      if (this.authConnectInFlight) return;
      this.authConnectInFlight = true;
      const generation = ++this.authGeneration;
      const controller = new AbortController();
      this.authController = controller;
      const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
      void raceWithAbort(ensureBrowserAuthSession(controller.signal), controller.signal)
        .then(
          () => {
            if (generation !== this.authGeneration || this.disposed) return;
            this.authConnectInFlight = false;
            this.authController = null;
            this.openSocket();
          },
          (error: unknown) => {
            if (
              generation !== this.authGeneration ||
              this.disposed ||
              getProtocolState().upgradeRequired
            )
              return;
            this.authConnectInFlight = false;
            this.authController = null;
            noteWsConnectionError(
              controller.signal.aborted
                ? "F5 authentication timed out."
                : error instanceof Error
                  ? error.message
                  : "F5 authentication failed.",
            );
            this.scheduleReconnect();
          },
        )
        .finally(() => clearTimeout(timer));
      return;
    }

    this.openSocket();
  }

  private openSocket() {
    if (this.disposed || getProtocolState().upgradeRequired) return;

    noteWsConnectionAttempt();

    const url = new URL(this.url, window.location.href);
    url.searchParams.set(F5_PROTOCOL_QUERY, String(F5_PROTOCOL_VERSION));
    const ws = new WebSocket(url.toString());
    const generation = ++this.socketGeneration;
    this.ws = ws;
    this.authoritativeSocketGeneration = generation;
    this.clearConnectionTimer();
    this.connectionTimer = setTimeout(() => {
      if (!this.isAuthoritativeSocket(generation, ws) || ws.readyState !== WebSocket.CONNECTING)
        return;
      this.detachAuthoritativeSocket();
      this.failPendingRequests(WS_CONNECTION_TIMED_OUT_MESSAGE, true);
      noteWsConnectionError(WS_CONNECTION_TIMED_OUT_MESSAGE);
      noteWsConnectionClosed();
      ws.close();
      this.scheduleReconnect();
    }, CONNECTION_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (!this.isAuthoritativeSocket(generation, ws)) {
        if (ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
        return;
      }

      this.clearConnectionTimer();
      this.reconnectAttempt = 0;
      this.lastForegroundProbe = null;
      // A new socket has fresh server admission and unknown runtime readiness.
      this.scheduler.resetAdmission();
      this.runtime = null;
      noteWsConnectionOpened();
      this.flushQueue();
    });

    ws.addEventListener("message", (event) => {
      if (!this.isAuthoritativeSocket(generation, ws)) {
        return;
      }

      this.handleMessage(event.data);
    });

    ws.addEventListener("close", (event) => {
      if (!this.isAuthoritativeSocket(generation, ws)) {
        return;
      }

      this.detachAuthoritativeSocket();
      if (event.code === F5_UPGRADE_REQUIRED_CLOSE_CODE) {
        requireProtocolUpgrade();
        this.failPendingRequests(F5_UPGRADE_REQUIRED_MESSAGE);
        noteWsConnectionClosed();
        noteWsConnectionError(F5_UPGRADE_REQUIRED_MESSAGE);
        return;
      }
      this.failPendingRequests(WS_CONNECTION_CLOSED_MESSAGE, true);
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
    if (this.disposed || getProtocolState().upgradeRequired) return;

    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      if (ws?.readyState !== WebSocket.CONNECTING) {
        this.reconnect();
      }
      return;
    }

    const generation = this.authoritativeSocketGeneration;
    const now = Date.now();
    // A sent RPC still awaiting its answer already proves the socket is active.
    // Queued requests do not: they may be waiting precisely because the socket
    // stopped answering. Neither do timed-out or aborted ones holding a slot
    // through their orphan grace.
    for (const request of this.requests.values())
      if (request.state === "sent" && !request.settled) return;
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
      { timeoutMs: FOREGROUND_PROBE_TIMEOUT_MS, trackLatency: false, retry: false },
    )
      .then((result) => this.applyRuntimeReadiness(probeRuntime(result), undefined))
      .catch((error: unknown) => {
        if (!this.isAuthoritativeSocket(generation, ws)) return;
        // Any server answer, including `RpcBusy`, proves the socket is alive.
        if (error instanceof WsRequestError && error.origin === "server") return;
        noteWsConnectionError(
          asError(error, "WebSocket foreground connectivity probe failed.").message,
        );
        this.reconnect();
      })
      .finally(() => {
        if (this.foregroundProbeGeneration === generation) {
          this.foregroundProbeGeneration = null;
        }
      });
  }

  private detachAuthoritativeSocket(): void {
    this.clearConnectionTimer();
    this.ws = null;
    this.authoritativeSocketGeneration = DETACHED_SOCKET_GENERATION;
  }

  /**
   * When the connection is lost, a mutation still queued (including one
   * requeued after `ServerStarting`) never executed, so it is rejected as not
   * sent rather than as possibly applied.
   */
  private failPendingRequests(message: string, connectionLost = false): void {
    clearTrackedSlowRpcRequests(this.requests.keys());
    const requests = [...this.requests.values()];
    this.requests.clear();
    this.scheduler.reset();
    this.runtime = null;
    this.clearRuntimeProbe();
    for (const request of requests) {
      this.clearTimer(request);
      this.settle(
        request,
        connectionLost && request.kind === "mutation" && request.state === "queued"
          ? connectionNotReadyError()
          : new Error(message),
      );
    }
  }

  /**
   * Readiness of the backend behind the current socket. Older revisions and
   * other incarnations are ignored.
   */
  private applyRuntimeReadiness(
    readiness: ServerRuntimeReadiness | null,
    incarnation: string | undefined,
  ): void {
    if (!readiness) return;
    const current = this.runtime;
    const generation = this.authoritativeSocketGeneration;
    if (current && current.generation === generation) {
      if (incarnation !== undefined && current.incarnation !== undefined) {
        if (incarnation !== current.incarnation) return;
      }
      if (readiness.revision <= current.revision) return;
    }
    this.runtime = {
      generation,
      incarnation: incarnation ?? current?.incarnation,
      state: readiness.state,
      revision: readiness.revision,
      message: readiness.message,
    };
    if (readiness.state === "failed") {
      const error = new WsRequestError(
        readiness.message ?? "The F5 server failed to start.",
        "ServerStartFailed",
      );
      for (const request of this.scheduler.queuedEntries())
        if (request.requiresRuntime) {
          this.scheduler.remove(request.id);
          this.finishRequest(request, error);
        }
    }
    this.flushQueue();
  }

  private runtimeHolding(): boolean {
    return (
      this.runtime?.state === "starting" &&
      this.runtime.generation === this.authoritativeSocketGeneration
    );
  }

  private clearRuntimeProbe(): void {
    if (this.runtimeProbeTimer !== null) clearTimeout(this.runtimeProbeTimer);
    this.runtimeProbeTimer = null;
  }

  /** While requests wait for the runtime, probe at most once per second in case a push is lost. */
  private scheduleRuntimeProbe(): void {
    if (this.runtimeProbeTimer !== null || this.runtimeProbeInFlight || !this.runtimeHolding())
      return;
    if (!this.scheduler.queuedEntries().some((request) => request.requiresRuntime)) return;
    const generation = this.authoritativeSocketGeneration;
    this.runtimeProbeTimer = setTimeout(() => {
      this.runtimeProbeTimer = null;
      if (generation !== this.authoritativeSocketGeneration || !this.runtimeHolding()) return;
      this.runtimeProbeInFlight = true;
      void this.request(
        WS_METHODS.serverProbe,
        {},
        { timeoutMs: FOREGROUND_PROBE_TIMEOUT_MS, trackLatency: false, retry: false },
      )
        .then((result) => {
          if (generation === this.authoritativeSocketGeneration)
            this.applyRuntimeReadiness(probeRuntime(result), undefined);
        })
        .catch(() => undefined)
        .finally(() => {
          this.runtimeProbeInFlight = false;
          this.scheduleRuntimeProbe();
        });
    }, RUNTIME_PROBE_INTERVAL_MS);
  }

  private handleMessage(raw: unknown) {
    if (getProtocolState().upgradeRequired) return;
    const result = decodeWsResponse(raw);
    if (Result.isFailure(result)) {
      console.warn("Dropped inbound WebSocket envelope", formatSchemaError(result.failure));
      this.releaseUndecodableResponse(raw);
      return;
    }

    const message = result.success;
    if (isWsPushMessage(message)) {
      if (message.channel === WS_CHANNELS.serverWelcome) {
        if (
          !message.data.bootstrap ||
          message.data.bootstrap.protocolVersion !== F5_PROTOCOL_VERSION
        ) {
          requireProtocolUpgrade();
          this.failPendingRequests(F5_UPGRADE_REQUIRED_MESSAGE);
          noteWsConnectionError(F5_UPGRADE_REQUIRED_MESSAGE);
          this.ws?.close(F5_UPGRADE_REQUIRED_CLOSE_CODE, "upgrade-required");
          return;
        }
        setServerBootstrap(message.data.bootstrap);
        if (message.data.runtime) {
          // The welcome starts this socket's readiness history.
          this.runtime = null;
          this.applyRuntimeReadiness(message.data.runtime, message.data.backendIncarnation);
        }
      } else if (message.channel === WS_CHANNELS.serverRuntimeReadiness) {
        this.applyRuntimeReadiness(message.data, message.data.backendIncarnation);
      }
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

    // Release before the early exit: a late response to a timed-out request
    // still frees the slot it held.
    const released = this.scheduler.release(message.id);
    const request = this.requests.get(message.id);
    if (!request) {
      if (released) this.flushQueue();
      return;
    }

    if (message.error?.code === "RpcBusy") countRpcDiagnostic("rpcBusy");
    if (message.error?.code === "ServerStarting" && !request.settled) {
      countRpcDiagnostic("rpcServerStarting");
      this.requeueForRuntime(request, message.error.retryAfterMs);
      return;
    }

    this.finishRequest(
      request,
      message.error
        ? new WsRequestError(
            message.error.message,
            message.error.code,
            message.error.checkoutConflict,
            message.error.retryable,
            message.error.retryAfterMs,
            "server",
          )
        : { result: message.result },
    );
    this.flushQueue();
  }

  /**
   * `ServerStarting` is a pre-execution rejection, so even a mutation is safe
   * to send again once the runtime is ready.
   */
  private requeueForRuntime(request: TransportRequest, retryAfterMs: number | undefined): void {
    this.clearTimer(request);
    const reportedReady = this.runtime?.state === "ready";
    if (!this.runtimeHolding() && !reportedReady) {
      this.runtime = {
        generation: this.authoritativeSocketGeneration,
        incarnation: this.runtime?.incarnation,
        state: "starting",
        revision: this.runtime?.revision ?? -1,
        message: undefined,
      };
    }
    if (reportedReady) {
      // A response that raced the ready push: wait before resending so a
      // disagreement cannot become a tight loop.
      request.state = "queued";
      request.timer = setTimeout(() => {
        request.timer = null;
        if (this.requests.get(request.id) !== request || request.settled) return;
        if (this.enqueue(request)) this.flushQueue();
      }, retryAfterMs ?? RUNTIME_PROBE_INTERVAL_MS);
      return;
    }
    if (this.enqueue(request)) this.flushQueue();
  }

  /** A response that fails to decode still frees its slot when its id is readable. */
  private releaseUndecodableResponse(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const { id, type } = parsed as { id?: unknown; type?: unknown };
    if (type === "push" || typeof id !== "string") return;
    const released = this.scheduler.release(id);
    const request = this.requests.get(id);
    if (request)
      this.finishRequest(
        request,
        new WsRequestError("The server response could not be decoded.", "ResponseDecodeFailed"),
      );
    if (released || request) this.flushQueue();
  }

  private isEligible(request: TransportRequest): boolean {
    if (request.state !== "queued" || request.settled) return false;
    if (request.kind === "mutation" && !request.control) {
      const connection = getWsConnectionState();
      if (
        connection.phase !== "connected" ||
        !connection.synchronized ||
        request.generation !== this.authoritativeSocketGeneration
      )
        return false;
    }
    return !(request.requiresRuntime && this.runtimeHolding());
  }

  private flushQueue() {
    if (getProtocolState().upgradeRequired || this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const ws = this.ws;
    // Expire before admission: a deadline timer may not have run yet when a
    // released slot or a readiness change flushes the queue.
    const now = Date.now();
    for (const request of this.scheduler.queuedEntries())
      if (request.queueDeadlineAtMs !== null && request.queueDeadlineAtMs <= now)
        this.expireQueued(request);
    for (const request of this.scheduler.takeDispatchable((entry) => this.isEligible(entry))) {
      try {
        ws.send(request.encoded);
      } catch (error) {
        this.scheduler.release(request.id);
        this.finishRequest(request, asError(error, "Failed to send WebSocket request."));
        continue;
      }
      request.state = "sent";
      if (!request.everSent) {
        request.everSent = true;
        recordRpcQueueWait(Date.now() - request.createdAtMs);
      }
      this.armTimer(request);
    }
    this.scheduleRuntimeProbe();
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
