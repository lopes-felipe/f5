/**
 * In-process MSP host for tests. Speaks NDJSON JSON-RPC over an SDK
 * `DuplexTransport`, answers the requests F5 sends with stable defaults,
 * and lets a test override any method or push notifications.
 *
 * `apps/server/scripts/msp-mock-host.ts` serves the same host over stdio.
 *
 * @module provider/msp/testing/mockMspHost
 */
import type { DuplexTransport } from "@muse-code/sdk";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";

export interface MockMspError {
  readonly code: number;
  readonly message: string;
  readonly data: { readonly kind: string; readonly retryable?: boolean } & Record<string, unknown>;
}

export class MockMspFailure extends Error {
  constructor(readonly error: MockMspError) {
    super(error.message);
  }
}

export type MockMspHandler = (
  params: Record<string, unknown>,
  host: MockMspHost,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface MockMspHostOptions {
  readonly fingerprint?: string;
  readonly sessionDurability?: "durable" | "ephemeral";
  readonly sandboxAvailability?: "available" | "unavailable";
  /** Approval mode the host claims to apply, regardless of the request. */
  readonly forcedApprovalMode?: string;
}

export function mspError(kind: string, message = kind, code = -32000): MockMspFailure {
  return new MockMspFailure({ code, message, data: { kind } });
}

export class MockMspHost {
  readonly requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> =
    [];
  readonly notifications: Array<{ readonly method: string }> = [];
  readonly handlers = new Map<string, MockMspHandler>();
  readonly transport: DuplexTransport;
  sessionId = "msp-session-1";
  turnCounter = 0;
  cursorCounter = 0;
  closed = false;
  #pushChunk: ((chunk: string) => void) | undefined;
  #endIncoming: (() => void) | undefined;
  readonly #queued: string[] = [];
  #buffer = "";

  constructor(readonly options: MockMspHostOptions = {}) {
    // oxlint-disable-next-line typescript/no-this-alias
    const host = this;
    const incoming: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              const queued = host.#queued.shift();
              if (queued !== undefined) return resolve({ value: queued, done: false });
              if (host.closed) return resolve({ value: undefined, done: true });
              host.#pushChunk = (chunk) => {
                host.#pushChunk = undefined;
                host.#endIncoming = undefined;
                resolve({ value: chunk, done: false });
              };
              host.#endIncoming = () => {
                host.#pushChunk = undefined;
                host.#endIncoming = undefined;
                resolve({ value: undefined, done: true });
              };
            }),
        };
      },
    };
    this.transport = {
      incoming,
      write: async (chunk) => {
        if (this.closed) throw new Error("mock host closed");
        this.#ingest(chunk);
      },
      close: async () => {
        this.end();
      },
    };
  }

  /** Simulate the host going away (EOF). */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.#endIncoming?.();
  }

  nextCursor(): string {
    this.cursorCounter += 1;
    return `cursor-${this.cursorCounter}`;
  }

  /** Push a server notification; `viewCursor` and `sessionId` default in. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.notifications.push({ method });
    this.#send({
      jsonrpc: "2.0",
      method,
      params: { sessionId: this.sessionId, viewCursor: this.nextCursor(), ...params },
    });
  }

  requestsFor(method: string) {
    return this.requests.filter((request) => request.method === method);
  }

  #send(frame: unknown): void {
    const line = `${JSON.stringify(frame)}\n`;
    if (this.#pushChunk) this.#pushChunk(line);
    else this.#queued.push(line);
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim()) void this.#handle(JSON.parse(line) as Record<string, unknown>);
      newline = this.#buffer.indexOf("\n");
    }
  }

  async #handle(frame: Record<string, unknown>): Promise<void> {
    const method = frame.method;
    if (typeof method !== "string" || frame.id === undefined) return;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params });
    try {
      const handler = this.handlers.get(method) ?? DEFAULT_HANDLERS[method];
      const result = handler
        ? await handler(params, this)
        : { status: "accepted", ...(params.commandId ? { commandId: params.commandId } : {}) };
      this.#send({ jsonrpc: "2.0", id: frame.id, result });
    } catch (error) {
      const failure =
        error instanceof MockMspFailure
          ? error.error
          : { code: -32603, message: String(error), data: { kind: "internal" } };
      this.#send({ jsonrpc: "2.0", id: frame.id, error: failure });
    }
  }
}

function sessionRecord(host: MockMspHost, approvalMode: unknown) {
  return {
    sessionId: host.sessionId,
    activeTurnId: null,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    forkedFrom: null,
    modelId: "muse-spark-1.3",
    providerId: "meta",
    path: "/tmp/session",
    status: "idle",
    turnCount: 0,
    workspaceRoot: "/tmp",
    ...(approvalMode
      ? {
          approvalMode: {
            mode: host.options.forcedApprovalMode ?? approvalMode,
            source: "startup",
            lastCommandId: null,
          },
        }
      : {}),
  };
}

const DEFAULT_HANDLERS: Record<string, MockMspHandler> = {
  initialize: (_params, host) => ({
    experimentalApi: false,
    grantedCapabilities: [],
    museHome: "/tmp/muse",
    platformFamily: "unix",
    platformOs: "macos",
    sandboxAvailability: host.options.sandboxAvailability ?? "available",
    schema: { fingerprint: host.options.fingerprint ?? EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
    serverInfo: { name: "muse-mock", version: "1.4.8" },
    sessionDurability: host.options.sessionDurability ?? "durable",
    userAgent: "muse-mock/1.4.8",
  }),
  "session/start": (params, host) => ({
    session: sessionRecord(host, params.approvalMode),
    viewCursor: host.nextCursor(),
  }),
  "session/resume": (_params, host) => ({
    session: sessionRecord(host, undefined),
    history: { items: null, mode: "none", snapshot: null },
    pendingRequests: [],
    viewCursor: host.nextCursor(),
  }),
  "session/read": (_params, host) => ({
    session: sessionRecord(host, undefined),
    history: { items: [], mode: "inline", snapshot: null },
    pendingRequests: [],
    viewCursor: host.nextCursor(),
  }),
  "session/setApprovalMode": (params, host) => ({
    applyOutcome: "completed",
    commandId: params.commandId,
    effectiveMode: {
      mode: host.options.forcedApprovalMode ?? params.mode,
      source: "approvalReconfigure",
      lastCommandId: params.commandId,
    },
    status: "accepted",
  }),
  "approval/listPending": () => ({ approvals: [], userInputs: [] }),
  "model/list": () => ({
    models: [
      {
        modelId: "muse-spark-1.3",
        displayLabel: "Muse Spark 1.3",
        contextLimit: null,
        cost: null,
        description: null,
        isActive: true,
        isDefault: true,
        outputLimit: null,
        profileId: null,
        providerId: "meta",
        releaseDate: null,
        variants: ["low", "medium", "high"],
      },
    ],
    profileId: null,
    providerId: "meta",
    source: "providerCatalog",
  }),
  "usage/read": () => ({}),
  "turn/cancel": (params, host) => {
    const turnId = typeof params.turnId === "string" ? params.turnId : `turn-${host.turnCounter}`;
    setTimeout(() => host.notify("turn/completed", { turnId, terminal: "cancelled" }), 0);
    return { commandId: params.commandId, status: "accepted", turnId };
  },
  "turn/start": (params, host) => {
    host.turnCounter += 1;
    return {
      commandId: params.commandId,
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId: `turn-${host.turnCounter}`,
    };
  },
};
