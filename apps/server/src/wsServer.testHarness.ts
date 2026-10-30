import * as NodeServices from "@effect/platform-node/NodeServices";
import { MigrationError } from "@effect/sql-sqlite-bun/SqliteMigrator";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import {
  DEFAULT_TERMINAL_ID,
  defaultInstanceIdForDriver,
  EDITORS,
  EventId,
  F5_PROTOCOL_QUERY,
  F5_PROTOCOL_VERSION,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  ProviderItemId,
  ThreadId,
  TurnId,
  WS_CHANNELS,
  type KeybindingsConfig,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type WebSocketResponse,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
} from "@t3tools/contracts";
import { mergeWithDefaultKeybindings } from "@t3tools/shared/keybindings";
import { Data, Effect, Exit, Layer, PlatformError, PubSub, Scope, Stream } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as Http from "node:http";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, vi } from "vitest";
import WebSocket from "ws";
import {
  CodexControlClientRegistry,
  CodexControlClientRegistryError,
} from "./codex/CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "./codex/CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "./codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "./codex/CodexOAuthManager.ts";
import { ComputerAutomationBrokerLive } from "./computer/ComputerAutomationBroker";
import { ServerConfig, type ServerConfigShape } from "./config";
import type { GitCoreShape } from "./git/Services/GitCore.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { makeFakeGitCore } from "./git/testDoubles.ts";
import { compileResolvedKeybindingRule, DEFAULT_KEYBINDINGS } from "./keybindings";
import { McpRuntimeService } from "./mcp/McpRuntimeService.ts";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "./mcp/PreviewAutomationBroker.ts";
import { ProjectMcpConfigService } from "./mcp/ProjectMcpConfigService.ts";
import { Open, type OpenShape } from "./open";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import {
  HarnessValidation,
  type HarnessValidationShape,
} from "./provider/Services/HarnessValidation";
import {
  ProviderAdvisoryProjection,
  type ProviderAdvisoryProjectionShape,
} from "./provider/Services/ProviderAdvisoryProjection.ts";
import { ProviderHealth, type ProviderHealthShape } from "./provider/Services/ProviderHealth";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import {
  ProviderUpdateAdvisor,
  type ProviderUpdateAdvisorShape,
} from "./provider/Services/ProviderUpdateAdvisor.ts";
import { makeServerRuntimeServicesLayer } from "./serverLayers";
import { ServerSettingsLive } from "./serverSettings.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager";
import { createServer } from "./wsServer";

export const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

export const asProviderItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

export const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

export const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

export const defaultOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
  revealInFileManager: () => Effect.void,
};

export const defaultProviderSnapshots: ReadonlyArray<ServerProvider> = [
  {
    instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
    driver: ProviderDriverKind.make("codex"),
    displayName: PROVIDER_DISPLAY_NAMES.codex,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

export const defaultProviderHealthService: ProviderHealthShape = {
  getStatuses: Effect.succeed([]),
};

export const defaultProviderRegistryService: ProviderRegistryShape = {
  getProviders: Effect.succeed(defaultProviderSnapshots),
  refresh: () => Effect.succeed(defaultProviderSnapshots),
  refreshInstance: () => Effect.succeed(defaultProviderSnapshots),
  streamChanges: Stream.empty,
};

export const defaultProviderUpdateAdvisorService: ProviderUpdateAdvisorShape = {
  getAdvisoryFor: ({ currentVersion }) =>
    Effect.succeed({
      status: "unknown",
      currentVersion,
      latestVersion: null,
      updateCommand: null,
      checkedAt: null,
      message: null,
    }),
  streamChanges: Stream.empty,
  noteRegistryChanged: Effect.void,
  refreshAdvisories: () => Effect.void,
  runUpdate: () => Effect.die("Unexpected provider update"),
};

export const defaultProviderAdvisoryProjectionService: ProviderAdvisoryProjectionShape = {
  getProviders: Effect.succeed(defaultProviderSnapshots),
  streamChanges: Stream.empty,
};

export const defaultHarnessValidationService: HarnessValidationShape = {
  validate: () =>
    Effect.succeed([
      {
        provider: "claudeAgent",
        status: "error",
        installed: false,
        authStatus: "unknown",
        failureKind: "notInstalled",
        checkedAt: "2026-01-01T00:00:00.000Z",
        message: "Claude Agent CLI (`claude`) is not installed or not on PATH.",
      },
      {
        provider: "codex",
        status: "ready",
        installed: true,
        authStatus: "authenticated",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
};

export const unsupportedProviderCall = () =>
  Effect.die(new Error("Unsupported provider call in test")) as never;

export const defaultProviderService: ProviderServiceShape = {
  startSession: () => unsupportedProviderCall(),
  replaceSession: () => unsupportedProviderCall(),
  sendTurn: () => unsupportedProviderCall(),
  interruptTurn: () => unsupportedProviderCall(),
  respondToRequest: () => unsupportedProviderCall(),
  respondToUserInput: () => unsupportedProviderCall(),
  respondToElicitation: () => unsupportedProviderCall(),
  stopSession: () => unsupportedProviderCall(),
  listStartingWorkspaces: () => Effect.succeed([]),
  listSessions: () => Effect.succeed([]),
  getSessionCapabilities: () => Effect.succeed(null),
  assertSessionAction: () => Effect.die(new Error("assertSessionAction is unused here")),
  getCapabilities: () => Effect.succeed({ sessionModelSwitch: "unsupported" }),
  readThread: () => unsupportedProviderCall(),
  rollbackConversation: () => unsupportedProviderCall(),
  runOneOffPrompt: () => unsupportedProviderCall(),
  compactConversation: () => unsupportedProviderCall(),
  reloadMcpConfigForProject: () => Effect.succeed({ sessions: [] }),
  streamEvents: Stream.empty,
};

export function makeProviderRuntimeTestLayer(providerLayer: Layer.Layer<ProviderService, never>) {
  return Layer.mergeAll(
    providerLayer,
    Layer.succeed(ProviderRegistry, defaultProviderRegistryService),
    Layer.succeed(ProviderUpdateAdvisor, defaultProviderUpdateAdvisorService),
    Layer.succeed(ProviderAdvisoryProjection, defaultProviderAdvisoryProjectionService),
    Layer.succeed(ProviderInstanceRegistry, {
      getInstance: () => Effect.sync(() => undefined as ProviderInstance | undefined),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
        Effect.flatMap(PubSub.subscribe),
      ),
    }),
    Layer.succeed(CodexMcpEventBus, {
      publishStatusUpdated: () => Effect.void,
      streamStatusUpdates: Stream.empty,
    }),
    Layer.succeed(CodexControlClientRegistry, {
      getAdminClient: () =>
        Effect.fail(
          new CodexControlClientRegistryError({ message: "unused Codex account client" }),
        ),
      hasOauthLease: () => Effect.succeed(false),
      acquireOauthClient: () => Effect.die("unused Codex OAuth client"),
    }),
    Layer.succeed(CodexMcpSyncService, {
      getStatus: ({ projectId }) =>
        Effect.succeed({
          projectId,
          support: "supported" as const,
        }),
    }),
    Layer.succeed(ProjectMcpConfigService, {
      readCommonStoredConfig: () =>
        Effect.succeed({
          scope: "common" as const,
          version: "mcp-version-test",
          servers: {},
        }),
      readProjectStoredConfig: (projectId: ProjectId) =>
        Effect.succeed({
          scope: "project" as const,
          projectId,
          version: "mcp-version-test",
          servers: {},
        }),
      readEffectiveStoredConfig: (projectId: ProjectId) =>
        Effect.succeed({
          projectId,
          commonVersion: "mcp-version-test",
          projectVersion: "mcp-version-test",
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
      readEffectiveRuntimeConfig: (projectId: ProjectId) =>
        Effect.succeed({
          projectId,
          commonVersion: "mcp-version-test",
          projectVersion: "mcp-version-test",
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
      readCommonConfig: () =>
        Effect.succeed({
          version: "mcp-version-test",
          servers: {},
        }),
      replaceCommonConfig: (_input) =>
        Effect.succeed({
          version: "mcp-version-test",
          servers: {},
        }),
      readProjectConfig: (projectId) =>
        Effect.succeed({
          projectId,
          version: "mcp-version-test",
          servers: {},
        }),
      readEffectiveConfig: (projectId: ProjectId) =>
        Effect.succeed({
          projectId,
          commonVersion: "mcp-version-test",
          projectVersion: "mcp-version-test",
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
      replaceProjectConfig: (input) =>
        Effect.succeed({
          projectId: input.projectId,
          version: "mcp-version-test",
          servers: {},
        }),
      readCodexServers: (projectId) =>
        Effect.succeed({
          projectId,
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
    }),
    Layer.succeed(CodexOAuthManager, {
      startLogin: (input) =>
        Effect.succeed({
          projectId: input.projectId,
          serverName: input.serverName,
          status: "idle" as const,
        }),
      getStatus: (input) =>
        Effect.succeed({
          projectId: input.projectId,
          serverName: input.serverName,
          status: "idle" as const,
        }),
    }),
    Layer.succeed(McpRuntimeService, {
      sanitizeReconnectResult: (_input, result) => Effect.succeed(result),
      inspectServer: () => Effect.die("unused inspector"),
      reconnectServer: () =>
        Effect.succeed({
          settingsConnectionReloaded: true,
          sessionsMatched: 0,
          sessionsReconnected: 0,
          failures: [],
        }),
      getProviderStatus: ({ provider, projectId }) =>
        Effect.succeed({
          provider,
          projectId,
          support: "supported" as const,
          available: true,
          authStatus: "authenticated" as const,
          configVersion: "mcp-version-test",
        }),
      getServerStatuses: ({ provider, projectId }) =>
        Effect.succeed({
          provider,
          projectId,
          support: "supported" as const,
          configVersion: "mcp-version-test",
          statuses: [],
        }),
      startLogin: ({ provider, projectId, serverName }) =>
        Effect.succeed({
          target: serverName ? ("server" as const) : ("provider" as const),
          mode: "cli" as const,
          provider,
          projectId,
          ...(serverName ? { serverName } : {}),
          status: "idle" as const,
        }),
      getLoginStatus: ({ provider, projectId, serverName }) =>
        Effect.succeed({
          target: serverName ? ("server" as const) : ("provider" as const),
          mode: "cli" as const,
          provider,
          projectId,
          ...(serverName ? { serverName } : {}),
          status: "idle" as const,
        }),
    }),
  );
}

export class TestRealPathError extends Data.TaggedError("TestRealPathError")<{
  cause: unknown;
}> {}

export class MockTerminalManager implements TerminalManagerShape {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  private key(threadId: string, terminalId: string): string {
    return `${threadId}\u0000${terminalId}`;
  }

  emitEvent(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscriptionCount(): number {
    return this.listeners.size;
  }

  readonly snapshot: TerminalManagerShape["snapshot"] = (input) =>
    Effect.sync(
      () =>
        this.sessions.get(this.key(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID)) ??
        null,
    );

  readonly open: TerminalManagerShape["open"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        epoch: "test",
        generation: 1,
        revision: 1,
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 4242,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "started",
          epoch: "test",
          generation: 1,
          revision: 1,
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly write: TerminalManagerShape["write"] = (input: TerminalWriteInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const existing = this.sessions.get(this.key(input.threadId, terminalId));
      if (!existing) {
        throw new Error(`Unknown terminal thread: ${input.threadId}`);
      }
      queueMicrotask(() => {
        this.emitEvent({
          type: "output",
          epoch: "test",
          generation: 1,
          revision: 1,
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
          data: input.data,
        });
      });
    });

  readonly resize: TerminalManagerShape["resize"] = (_input: TerminalResizeInput) => Effect.void;

  readonly clear: TerminalManagerShape["clear"] = (input: TerminalClearInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      queueMicrotask(() => {
        this.emitEvent({
          type: "cleared",
          epoch: "test",
          generation: 1,
          revision: 1,
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
        });
      });
    });

  readonly restart: TerminalManagerShape["restart"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        epoch: "test",
        generation: 1,
        revision: 1,
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 5252,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "restarted",
          epoch: "test",
          generation: 1,
          revision: 1,
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly close: TerminalManagerShape["close"] = (input: TerminalCloseInput) =>
    Effect.sync(() => {
      if (input.terminalId) {
        this.sessions.delete(this.key(input.threadId, input.terminalId));
        return;
      }
      for (const key of this.sessions.keys()) {
        if (key.startsWith(`${input.threadId}\u0000`)) {
          this.sessions.delete(key);
        }
      }
    });

  readonly subscribe: TerminalManagerShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });

  readonly listSessions: TerminalManagerShape["listSessions"] = Effect.succeed([]);
  readonly dispose: TerminalManagerShape["dispose"] = Effect.void;
}

export interface MessageChannel<T> {
  queue: T[];
  waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout> | null;
  }>;
}

export interface SocketChannels {
  push: MessageChannel<WsPush>;
  response: MessageChannel<WebSocketResponse>;
}

export const channelsBySocket = new WeakMap<WebSocket, SocketChannels>();

export function enqueue<T>(channel: MessageChannel<T>, item: T) {
  const waiter = channel.waiters.shift();
  if (waiter) {
    if (waiter.timeoutId !== null) clearTimeout(waiter.timeoutId);
    waiter.resolve(item);
    return;
  }
  channel.queue.push(item);
}

export function dequeue<T>(channel: MessageChannel<T>, timeoutMs: number): Promise<T> {
  const queued = channel.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timeoutId: setTimeout(() => {
        const index = channel.waiters.indexOf(waiter);
        if (index >= 0) channel.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs) as ReturnType<typeof setTimeout>,
    };
    channel.waiters.push(waiter);
  });
}

export function isWsPushEnvelope(message: unknown): message is WsPush {
  if (typeof message !== "object" || message === null) return false;
  if (!("type" in message) || !("channel" in message)) return false;
  return (message as { type?: unknown }).type === "push";
}

export function asWebSocketResponse(message: unknown): WebSocketResponse | null {
  if (typeof message !== "object" || message === null) return null;
  if (!("id" in message)) return null;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== "string") return null;
  return message as WebSocketResponse;
}

export function connectWsOnce(
  port: number,
  token?: string,
  headers?: Readonly<Record<string, string>>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = `?${F5_PROTOCOL_QUERY}=${F5_PROTOCOL_VERSION}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, { headers });
    const channels: SocketChannels = {
      push: { queue: [], waiters: [] },
      response: { queue: [], waiters: [] },
    };
    channelsBySocket.set(ws, channels);

    ws.on("message", (raw) => {
      if (vi.isMockFunction(console.log)) console.log("test websocket received", String(raw));
      const parsed = JSON.parse(String(raw));
      if (isWsPushEnvelope(parsed)) {
        enqueue(channels.push, parsed);
      } else {
        const response = asWebSocketResponse(parsed);
        if (response) {
          enqueue(channels.response, response);
        }
      }
    });

    ws.once("open", () => resolve(ws));
    ws.once("close", (code, reason) => {
      if (vi.isMockFunction(console.log))
        console.log("test websocket closed", code, String(reason));
    });
    ws.once("error", (cause) => reject(new Error("WebSocket connection failed", { cause })));
  });
}

export async function connectWs(
  port: number,
  token?: string,
  attempts = 5,
  headers?: Readonly<Record<string, string>>,
): Promise<WebSocket> {
  let lastError: unknown = new Error("WebSocket connection failed");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await connectWsOnce(port, token, headers);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  throw lastError;
}

export async function connectAndAwaitWelcome(
  port: number,
  token?: string,
  headers?: Readonly<Record<string, string>>,
): Promise<[WebSocket, WsPushMessage<typeof WS_CHANNELS.serverWelcome>]> {
  const ws = await connectWs(port, token, 5, headers);
  try {
    const welcome = await waitForPush(ws, WS_CHANNELS.serverWelcome);
    expect(welcome.data.backendIncarnation).toEqual(expect.any(String));
    expect(welcome.data.backendIncarnation!.length).toBeGreaterThan(0);
    return [ws, welcome];
  } catch (cause) {
    // Callers only register successful connections for teardown. A failed
    // welcome must not leave a socket keeping server shutdown alive.
    ws.terminate();
    if (vi.isMockFunction(console.log)) {
      throw new Error(
        `${String(cause)}\nServer logs:\n${inspect(vi.mocked(console.log).mock.calls.slice(-40), { depth: 5 })}`,
        { cause },
      );
    }
    throw cause;
  }
}

/**
 * Like the web client, resends a request answered `ServerStarting` (nothing
 * ran) until the runtime is ready, unless `retryServerStarting` is false.
 */
export async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
  options: { readonly retryServerStarting?: boolean } = {},
): Promise<WebSocketResponse> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await sendRequestOnce(ws, method, params);
    if (
      options.retryServerStarting === false ||
      response.error?.code !== "ServerStarting" ||
      Date.now() > deadline
    )
      return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function sendRequestOnce(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<WebSocketResponse> {
  const channels = channelsBySocket.get(ws);
  if (!channels) throw new Error("WebSocket not initialized");

  const id = crypto.randomUUID();
  const body =
    method === ORCHESTRATION_WS_METHODS.dispatchCommand
      ? { _tag: method, command: params }
      : params && typeof params === "object" && !Array.isArray(params)
        ? { _tag: method, ...(params as Record<string, unknown>) }
        : { _tag: method };
  ws.send(JSON.stringify({ id, body }));

  // Response channel only contains responses — no push filtering needed
  while (true) {
    const response = await dequeue(channels.response, 60_000);
    if (response.id === id || response.id === "unknown") {
      return response;
    }
  }
}

export async function waitForPush<C extends WsPushChannel>(
  ws: WebSocket,
  channel: C,
  predicate?: (push: WsPushMessage<C>) => boolean,
  maxMessages = 120,
  idleTimeoutMs = 5_000,
): Promise<WsPushMessage<C>> {
  const channels = channelsBySocket.get(ws);
  if (!channels) throw new Error("WebSocket not initialized");

  for (let remaining = maxMessages; remaining > 0; remaining--) {
    const push = await dequeue(channels.push, idleTimeoutMs);
    if (push.channel !== channel) continue;
    const typed = push as WsPushMessage<C>;
    if (!predicate || predicate(typed)) return typed;
  }
  throw new Error(`Timed out waiting for push on ${channel}`);
}

export async function rewriteKeybindingsAndWaitForPush(
  ws: WebSocket,
  keybindingsPath: string,
  contents: string,
  predicate: (push: WsPushMessage<typeof WS_CHANNELS.serverConfigUpdated>) => boolean,
  attempts = 3,
): Promise<WsPushMessage<typeof WS_CHANNELS.serverConfigUpdated>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    fs.writeFileSync(keybindingsPath, contents, "utf8");
    try {
      return await waitForPush(ws, WS_CHANNELS.serverConfigUpdated, predicate, 20, 3_000);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function requestPath(
  port: number,
  requestPath: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = Http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

export function compileKeybindings(bindings: KeybindingsConfig): ResolvedKeybindingsConfig {
  const resolved: Array<ResolvedKeybindingsConfig[number]> = [];
  for (const binding of bindings) {
    const compiled = compileResolvedKeybindingRule(binding);
    if (!compiled) {
      throw new Error(`Unexpected invalid keybinding in test setup: ${binding.command}`);
    }
    resolved.push(compiled);
  }
  return resolved;
}

export function compileMergedKeybindings(bindings: KeybindingsConfig): ResolvedKeybindingsConfig {
  return mergeWithDefaultKeybindings(compileKeybindings(bindings));
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileKeybindings([...DEFAULT_KEYBINDINGS]);

export const VALID_EDITOR_IDS = new Set(EDITORS.map((editor) => editor.id));

export function expectAvailableEditors(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  for (const editorId of value as unknown[]) {
    expect(typeof editorId).toBe("string");
    expect(VALID_EDITOR_IDS.has(editorId as (typeof EDITORS)[number]["id"])).toBe(true);
  }
}

export function createWsServerTestHarness() {
  let server: Http.Server | null = null;

  let serverScope: Scope.Closeable | null = null;

  const connections: WebSocket[] = [];

  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function sha256Hex(input: string | Uint8Array): string {
    return createHash("sha256").update(input).digest("hex");
  }

  function makeTurnCapturingProviderService(
    sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]>,
  ): ProviderServiceShape {
    return {
      ...defaultProviderService,
      startSession: (threadId, input) =>
        Effect.succeed({
          provider: "codex",
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      sendTurn: (input) =>
        Effect.sync(() => {
          sentTurns.push(input);
          return {
            threadId: input.threadId,
            turnId: asTurnId(`provider-${input.threadId}`),
          };
        }),
      getSessionCapabilities: () => Effect.succeed(null),
      assertSessionAction: () => Effect.die(new Error("assertSessionAction is unused here")),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    };
  }

  async function createTestServer(
    options: {
      persistenceLayer?: Layer.Layer<
        SqlClient.SqlClient,
        SqlError.SqlError | MigrationError | PlatformError.PlatformError
      >;
      mode?: ServerConfigShape["mode"];
      port?: number;
      cwd?: string;
      autoBootstrapProjectFromCwd?: boolean;
      logWebSocketEvents?: boolean;
      devUrl?: string;
      authToken?: string;
      stateDir?: string;
      staticDir?: string;
      providerLayer?: Layer.Layer<ProviderService, never>;
      providerInstanceRegistryLayer?: Layer.Layer<ProviderInstanceRegistry, never>;
      providerUpdateAdvisor?: ProviderUpdateAdvisorShape;
      providerHealth?: ProviderHealthShape;
      harnessValidation?: HarnessValidationShape;
      open?: OpenShape;
      gitManager?: GitManagerShape;
      gitCore?: Partial<GitCoreShape>;
      terminalManager?: TerminalManagerShape;
      observabilityEnabled?: boolean;
      createServerFactory?: typeof createServer;
      computerAccess?: boolean;
    } = {},
  ): Promise<Http.Server> {
    if (serverScope) {
      throw new Error("Test server is already running");
    }

    const stateDir = options.stateDir ?? makeTempDir("t3code-ws-state-");
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const persistenceLayer = options.persistenceLayer ?? SqlitePersistenceMemory;
    const providerLayer = Layer.merge(
      makeProviderRuntimeTestLayer(
        options.providerLayer ?? Layer.succeed(ProviderService, defaultProviderService),
      ),
      Layer.merge(
        options.providerInstanceRegistryLayer ?? Layer.empty,
        options.providerUpdateAdvisor
          ? Layer.succeed(ProviderUpdateAdvisor, options.providerUpdateAdvisor)
          : Layer.empty,
      ),
    );
    const providerHealthLayer = Layer.succeed(
      ProviderHealth,
      options.providerHealth ?? defaultProviderHealthService,
    );
    const harnessValidationLayer = Layer.succeed(
      HarnessValidation,
      options.harnessValidation ?? defaultHarnessValidationService,
    );
    const openLayer = Layer.succeed(Open, options.open ?? defaultOpenService);
    const previewAutomationBrokerLayer = Layer.succeed(
      PreviewAutomationBroker,
      makePreviewAutomationBroker(),
    );
    const serverConfigLayer = Layer.succeed(ServerConfig, {
      mode: options.mode ?? "web",
      port: options.port ?? 0,
      // Match the client's address family. On macOS an IPv6 wildcard listener
      // can share a port with an unrelated IPv4 listener, which receives our client.
      host: "127.0.0.1",
      cwd: options.cwd ?? "/test/project",
      baseDir: path.dirname(stateDir),
      stateDir,
      dbPath: path.join(stateDir, "state.sqlite"),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      worktreesDir: path.join(path.dirname(stateDir), "worktrees"),
      attachmentsDir: path.join(stateDir, "attachments"),
      logsDir: path.join(stateDir, "logs"),
      serverLogPath: path.join(stateDir, "logs", "server.log"),
      providerLogsDir: path.join(stateDir, "logs", "provider"),
      providerEventLogPath: path.join(stateDir, "logs", "provider", "events.log"),
      terminalLogsDir: path.join(stateDir, "logs", "terminals"),
      anonymousIdPath: path.join(stateDir, "anonymous-id"),
      staticDir: options.staticDir,
      devUrl: options.devUrl ? new URL(options.devUrl) : undefined,
      noBrowser: true,
      authToken: options.authToken,
      autoBootstrapProjectFromCwd: options.autoBootstrapProjectFromCwd ?? false,
      logWebSocketEvents: options.logWebSocketEvents ?? Boolean(options.devUrl),
      observabilityEnabled: options.observabilityEnabled ?? false,
      acpHardeningEnabled: false,
    } satisfies ServerConfigShape);
    const infrastructureLayer = providerLayer.pipe(Layer.provideMerge(persistenceLayer));
    const runtimeOverrides = Layer.mergeAll(
      options.computerAccess
        ? ComputerAutomationBrokerLive.pipe(Layer.provide(persistenceLayer))
        : Layer.empty,
      options.gitManager ? Layer.succeed(GitManager, options.gitManager) : Layer.empty,
      options.gitCore
        ? Layer.succeed(GitCore, makeFakeGitCore(options.gitCore).service)
        : Layer.empty,
      options.terminalManager
        ? Layer.succeed(TerminalManager, options.terminalManager)
        : Layer.empty,
    );

    const runtimeLayer = Layer.merge(
      Layer.merge(
        makeServerRuntimeServicesLayer().pipe(Layer.provide(infrastructureLayer)),
        infrastructureLayer,
      ),
      runtimeOverrides,
    );
    const dependenciesLayer = Layer.empty.pipe(
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(ServerSettingsLive),
      Layer.provideMerge(providerHealthLayer),
      Layer.provideMerge(harnessValidationLayer),
      Layer.provideMerge(openLayer),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(previewAutomationBrokerLayer),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtimeServices = await Effect.runPromise(
      Layer.build(dependenciesLayer).pipe(Scope.provide(scope)),
    );

    try {
      const createServerEffect = (options.createServerFactory ?? createServer)();
      const runtime = await Effect.runPromise(
        createServerEffect.pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
      );
      serverScope = scope;
      return runtime;
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  async function closeTestServer() {
    if (!serverScope) return;
    const scope = serverScope;
    serverScope = null;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  afterEach(async () => {
    for (const ws of connections) {
      ws.close();
    }
    connections.length = 0;
    await closeTestServer();
    server = null;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.doUnmock("./serverLayers.ts");
    vi.resetModules();
    vi.restoreAllMocks();
  });
  return {
    get server() {
      return server;
    },
    set server(value: Http.Server | null) {
      server = value;
    },
    connections,
    makeTempDir,
    sha256Hex,
    makeTurnCapturingProviderService,
    createTestServer,
    closeTestServer,
  };
}
