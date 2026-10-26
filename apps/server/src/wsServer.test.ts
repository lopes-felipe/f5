import { WorkspaceTransition } from "./project/Services/WorkspaceTransition.ts";
import { makeFakeGitCore } from "./git/testDoubles.ts";
import { WorktreePreparation } from "./project/Services/WorktreePreparation.ts";
import {
  F5_PROTOCOL_VERSION,
  F5_PROTOCOL_QUERY,
  F5_PROTOCOL_HEADER,
  F5_UPGRADE_REQUIRED_CLOSE_CODE,
} from "@t3tools/contracts";
import { SERVER_BOOTSTRAP } from "./wsServer/protocol";
import * as Http from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ComputerAutomationBroker,
  ComputerAutomationBrokerRuntime,
  ComputerAutomationBrokerLive,
} from "./computer/ComputerAutomationBroker";
import { DesktopComputerHost } from "./computer/DesktopComputerHost";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { AGENT_BRIDGE_LISTENER_AVAILABLE } from "./agentBridge/AgentBridgeService.ts";
import { runAgentBridgeStdio } from "./agentBridge/stdioShim.ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PlatformError,
  PubSub,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { describe, expect, it, afterEach, vi } from "vitest";
import { withProviderThreadAccess } from "./provider/providerThreadAccess.ts";
import { createServer, readWebSocketRequestId, resolveWorkspaceReadPath } from "./wsServer";
import WebSocket from "ws";
import { ServerConfig, type ServerConfigShape } from "./config";
import { makeServerRuntimeServicesLayer } from "./serverLayers";

import {
  AGENT_BRIDGE_WS_METHODS,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
  type WorktreeSetupSnapshot,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TERMINAL_ID,
  EDITORS,
  EventId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROJECT_READ_FILE_MAX_SIZE,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderItemId,
  ProjectId,
  ThreadId,
  TurnId,
  USAGE_WS_METHODS,
  AGENTS_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  type WebSocketResponse,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  type ServerSettings,
  type ServerProvider,
  type KeybindingsConfig,
  type ResolvedKeybindingsConfig,
  type WsPushChannel,
  type WsPushMessage,
  type WsPush,
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { compileResolvedKeybindingRule, DEFAULT_KEYBINDINGS } from "./keybindings";
import { mergeWithDefaultKeybindings } from "@t3tools/shared/keybindings";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { ProviderHealth, type ProviderHealthShape } from "./provider/Services/ProviderHealth";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderAdvisoryProjection,
  type ProviderAdvisoryProjectionShape,
} from "./provider/Services/ProviderAdvisoryProjection.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import {
  ProviderUpdateAdvisor,
  ProviderUpdateRunError,
  type ProviderUpdateAdvisorShape,
} from "./provider/Services/ProviderUpdateAdvisor.ts";
import {
  HarnessValidation,
  type HarnessValidationShape,
} from "./provider/Services/HarnessValidation";
import { ProviderValidationBusyError } from "./provider/Errors.ts";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import { Open, type OpenShape } from "./open";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import type { GitCoreShape } from "./git/Services/GitCore.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { GitCommandError, GitManagerError } from "./git/Errors.ts";
import { MigrationError } from "@effect/sql-sqlite-bun/SqliteMigrator";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { CodexMcpEventBus } from "./codex/CodexMcpEventBus.ts";
import {
  CodexControlClientRegistry,
  CodexControlClientRegistryError,
} from "./codex/CodexControlClientRegistry.ts";
import { CodexMcpSyncService } from "./codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "./codex/CodexOAuthManager.ts";
import { ProjectMcpConfigService } from "./mcp/ProjectMcpConfigService.ts";
import {
  makeAccountUsageCapability,
  emptyAccountSection,
} from "./usage/Layers/AccountUsageService.ts";
import { McpRuntimeService } from "./mcp/McpRuntimeService.ts";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "./mcp/PreviewAutomationBroker.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProviderItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const defaultOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
  revealInFileManager: () => Effect.void,
};

const defaultProviderSnapshots: ReadonlyArray<ServerProvider> = [
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

const defaultProviderHealthService: ProviderHealthShape = {
  getStatuses: Effect.succeed([]),
};

const defaultProviderRegistryService: ProviderRegistryShape = {
  getProviders: Effect.succeed(defaultProviderSnapshots),
  refresh: () => Effect.succeed(defaultProviderSnapshots),
  refreshInstance: () => Effect.succeed(defaultProviderSnapshots),
  streamChanges: Stream.empty,
};

const defaultProviderUpdateAdvisorService: ProviderUpdateAdvisorShape = {
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

const defaultProviderAdvisoryProjectionService: ProviderAdvisoryProjectionShape = {
  getProviders: Effect.succeed(defaultProviderSnapshots),
  streamChanges: Stream.empty,
};

const defaultHarnessValidationService: HarnessValidationShape = {
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

const unsupportedProviderCall = () =>
  Effect.die(new Error("Unsupported provider call in test")) as never;

const defaultProviderService: ProviderServiceShape = {
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

function makeProviderRuntimeTestLayer(providerLayer: Layer.Layer<ProviderService, never>) {
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

class TestRealPathError extends Data.TaggedError("TestRealPathError")<{
  cause: unknown;
}> {}

class MockTerminalManager implements TerminalManagerShape {
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

// ---------------------------------------------------------------------------
// WebSocket test harness
//
// Incoming messages are split into two channels:
//   - pushChannel: server push envelopes (type === "push")
//   - responseChannel: request/response envelopes (have an "id" field)
//
// This means sendRequest never has to skip push messages and waitForPush
// never has to skip response messages, eliminating a class of ordering bugs.
// ---------------------------------------------------------------------------

interface MessageChannel<T> {
  queue: T[];
  waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout> | null;
  }>;
}

interface SocketChannels {
  push: MessageChannel<WsPush>;
  response: MessageChannel<WebSocketResponse>;
}

const channelsBySocket = new WeakMap<WebSocket, SocketChannels>();

function enqueue<T>(channel: MessageChannel<T>, item: T) {
  const waiter = channel.waiters.shift();
  if (waiter) {
    if (waiter.timeoutId !== null) clearTimeout(waiter.timeoutId);
    waiter.resolve(item);
    return;
  }
  channel.queue.push(item);
}

function dequeue<T>(channel: MessageChannel<T>, timeoutMs: number): Promise<T> {
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

function isWsPushEnvelope(message: unknown): message is WsPush {
  if (typeof message !== "object" || message === null) return false;
  if (!("type" in message) || !("channel" in message)) return false;
  return (message as { type?: unknown }).type === "push";
}

function asWebSocketResponse(message: unknown): WebSocketResponse | null {
  if (typeof message !== "object" || message === null) return null;
  if (!("id" in message)) return null;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== "string") return null;
  return message as WebSocketResponse;
}

function connectWsOnce(
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

async function connectWs(
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

/** Connect and wait for the server.welcome push. Returns [ws, welcomeData]. */
async function connectAndAwaitWelcome(
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

async function sendRequest(
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

async function waitForPush<C extends WsPushChannel>(
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

async function rewriteKeybindingsAndWaitForPush(
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

async function requestPath(
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

function compileKeybindings(bindings: KeybindingsConfig): ResolvedKeybindingsConfig {
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

function compileMergedKeybindings(bindings: KeybindingsConfig): ResolvedKeybindingsConfig {
  return mergeWithDefaultKeybindings(compileKeybindings(bindings));
}

const DEFAULT_RESOLVED_KEYBINDINGS = compileKeybindings([...DEFAULT_KEYBINDINGS]);
const VALID_EDITOR_IDS = new Set(EDITORS.map((editor) => editor.id));

function expectAvailableEditors(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  for (const editorId of value as unknown[]) {
    expect(typeof editorId).toBe("string");
    expect(VALID_EDITOR_IDS.has(editorId as (typeof EDITORS)[number]["id"])).toBe(true);
  }
}

describe("WebSocket Server", () => {
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

  it.each(['[{"appId":"private-sentinel"', '[{"tier":"future","appId":"x","projectId":"p"}]'])(
    "starts the real headless backend with invalid remembered grants: %s",
    async (contents) => {
      const stateDir = makeTempDir("f5-corrupt-grants-");
      fs.writeFileSync(path.join(stateDir, "computer-access.json"), contents);
      server = await createTestServer({ stateDir, computerAccess: true });
      const address = server.address();
      const [ws] = await connectAndAwaitWelcome(
        typeof address === "object" && address ? address.port : 0,
      );
      connections.push(ws);
      expect(fs.existsSync(path.join(stateDir, "computer-access.json"))).toBe(false);
      const saved = fs
        .readdirSync(stateDir)
        .find((name) => name.startsWith("computer-access.corrupt-"));
      expect(saved).toBeDefined();
      expect(fs.readFileSync(path.join(stateDir, saved!), "utf8")).toBe(contents);
    },
  );

  it.each([false, true])(
    "preview resume remains typed and only requires main approval for computer pause=%s",
    async (computerPaused) => {
      const ipc = Object.assign(new EventEmitter(), {
        connected: true,
        send: (_message: unknown, callback: (error: Error | null) => void) => {
          callback(null);
          return true;
        },
      });
      const host = new DesktopComputerHost("profile", "backend", ipc, true);
      const broker = new ComputerAutomationBrokerRuntime(host, {
        platform: "darwin",
        storage: { load: async () => [], save: async () => {} },
        resolve: async () => {
          throw new Error("Computer tools must not execute in this test.");
        },
      });
      const threadId = ThreadId.makeUnsafe("preview-with-computer-tools");
      broker.bindSession(threadId, "session", "claude");
      ipc.emit("message", {
        type: "status",
        status: { available: false, reason: "helper-missing" },
      });
      if (computerPaused) ipc.emit("message", { type: "pauseChanged", threadId, paused: true });
      try {
        server = await createTestServer({
          createServerFactory: () =>
            createServer().pipe(Effect.provideService(ComputerAutomationBroker, broker)),
        });
        const address = server.address();
        const [ws] = await connectAndAwaitWelcome(
          typeof address === "object" && address ? address.port : 0,
        );
        connections.push(ws);
        const response = await sendRequest(ws, WS_METHODS.previewAutomationSetPaused, {
          threadId,
          paused: false,
        });
        if (computerPaused) {
          expect(response.error?.message).toContain("computer running F5");
          expect(broker.pause.has(threadId)).toBe(true);
        } else expect(response.error).toBeUndefined();
      } finally {
        broker.close();
      }
    },
  );

  it("delivers native action summaries and suppresses uncorrelated IPC thumbnails", async () => {
    const ipc = Object.assign(new EventEmitter(), {
      connected: true,
      send: (_message: unknown, callback: (error: Error | null) => void) => {
        callback(null);
        return true;
      },
    });
    const host = new DesktopComputerHost("profile", "backend", ipc, true);
    const broker = new ComputerAutomationBrokerRuntime(host, {
      platform: "darwin",
      storage: { load: async () => [], save: async () => {} },
      resolve: async () => {
        throw new Error("No native action should execute in this transport test.");
      },
    });
    try {
      server = await createTestServer({
        createServerFactory: () =>
          createServer().pipe(Effect.provideService(ComputerAutomationBroker, broker)),
      });
      const address = server.address();
      const [ws] = await connectAndAwaitWelcome(
        typeof address === "object" && address ? address.port : 0,
      );
      connections.push(ws);
      const activity = {
        threadId: "fixture-thread",
        backend: "native",
        op: "activateApp",
        status: "completed",
        thumbnailDataUrl: "data:image/jpeg;base64,SYNTHETIC",
      };
      ipc.emit("message", { type: "activity", activity });
      const push = await waitForPush(ws, WS_CHANNELS.computerActivity);
      const { thumbnailDataUrl: _thumbnail, ...summary } = activity;
      expect(push.data).toEqual(summary);
      const failed = {
        threadId: "fixture-thread",
        backend: "native",
        op: "elementAction",
        status: "failed",
        outcome: "app-resolution-failed",
      };
      ipc.emit("message", { type: "activity", activity: failed });
      const failurePush = await waitForPush(ws, WS_CHANNELS.computerActivity);
      expect(failurePush.data).toEqual(failed);
    } finally {
      broker.close();
    }
  });

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

  it("cannot silently bind another address family over an occupied IPv4 port", async () => {
    const foreign = Http.createServer((_request, response) => {
      response.writeHead(403);
      response.end();
    });
    await new Promise<void>((resolve) => foreign.listen({ host: "127.0.0.1", port: 0 }, resolve));
    try {
      const address = foreign.address();
      if (!address || typeof address === "string") throw new Error("Fixture listener missing");
      await expect(createTestServer({ port: address.port })).rejects.toMatchObject({
        _tag: "ServerLifecycleError",
        operation: "httpServerListen",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        foreign.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("sends welcome message on connect", async () => {
    server = await createTestServer({ cwd: "/test/project" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);
    expect(typeof addr === "object" && addr?.family).toBe("IPv4");

    const [ws, welcome] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    expect(welcome.type).toBe("push");
    expect(welcome.data).toMatchObject({
      cwd: "/test/project",
      projectName: "project",
      profile: { isDefault: true, slug: "default", isActive: true },
    });
  });

  it.each(["binaryPath", "homePath"])("rejects client-supplied %s in MCP Apply", async (field) => {
    server = await createTestServer({ cwd: "/test/project" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.mcpApplyToLiveSessions, {
      scope: "common",
      [field]: "/tmp/untrusted",
    });
    expect(response.error?.message).toContain("Invalid request format");
    expect(response.error?.message).toContain(`["body"]["${field}"]`);
    expect(response.result).toBeUndefined();
  });

  it.each(["claudeAgent", "codex"] as const)(
    "discovers MCP reconnect targets only for Codex: %s",
    async (provider) => {
      const getMcpReconnectTargets = vi.fn(() =>
        Effect.succeed({
          threadIds: [],
          failures: [
            {
              threadId: ThreadId.make("stale-conversation"),
              message: "The provider session no longer exists.",
            },
          ],
        }),
      );
      server = await createTestServer({
        providerLayer: Layer.succeed(ProviderService, {
          ...defaultProviderService,
          getMcpReconnectTargets,
        }),
      });
      const addr = server.address();
      const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
      connections.push(ws);
      const response = await sendRequest(ws, WS_METHODS.mcpReconnectServer, {
        provider,
        instanceId: provider,
        projectId: "reconnect-project",
        serverName: "docs",
      });
      expect(response.error).toBeUndefined();
      expect(getMcpReconnectTargets).toHaveBeenCalledTimes(provider === "codex" ? 1 : 0);
      expect(response.result).toMatchObject({
        settingsConnectionReloaded: true,
        sessionsReconnected: 0,
        failures:
          provider === "codex"
            ? [
                {
                  threadId: "stale-conversation",
                  message: "The provider session no longer exists.",
                },
              ]
            : [],
      });
    },
  );

  it("returns a bounded usage summary with explicit coverage", async () => {
    server = await createTestServer({ cwd: "/test/project" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, USAGE_WS_METHODS.getSummary, {
      range: "24h",
      timeZone: "UTC",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(
      expect.objectContaining({
        range: "24h",
        timeZone: "UTC",
        metrics: expect.objectContaining({ turnCount: 0, providerReportedCostUsd: null }),
        buckets: expect.arrayContaining([expect.objectContaining({ metrics: expect.any(Object) })]),
        coverage: expect.objectContaining({ coverageStartedAt: expect.any(String) }),
      }),
    );
    expect((response.result as { buckets: unknown[] }).buckets).toHaveLength(24);
    const accounts = await sendRequest(ws, USAGE_WS_METHODS.getAccounts, { refresh: "none" });
    expect(accounts.error).toBeUndefined();
    // This server has no registered instances. Never synthesize a legacy
    // machine-account probe outside the active profile's provider registry.
    expect(accounts.result).toEqual([]);
    const refreshedAccounts = await sendRequest(ws, USAGE_WS_METHODS.getAccounts, {
      refresh: "force",
    });
    expect(refreshedAccounts.error).toBeUndefined();
    expect(refreshedAccounts.result).toEqual([]);
    expect(response.result).not.toHaveProperty("codexAccount");
    const history = await sendRequest(ws, USAGE_WS_METHODS.getQuotaHistory, {});
    expect(history.error).toBeUndefined();
    expect(history.result).toEqual({ generatedAt: expect.any(String), series: [] });
  });

  it("routes thread-scoped agent snapshots and dismissals", async () => {
    server = await createTestServer({ cwd: "/test/project" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const global = await sendRequest(ws, AGENTS_WS_METHODS.getSnapshot, {});
    expect(global.error).toBeUndefined();
    expect(global.result).toEqual({ entries: [], generatedAt: expect.any(String) });

    const scoped = await sendRequest(ws, AGENTS_WS_METHODS.getSnapshot, {
      threadId: "thread-agents",
    });
    expect(scoped.error).toBeUndefined();
    expect(scoped.result).toEqual({ entries: [], generatedAt: expect.any(String) });

    const dismissed = await sendRequest(ws, AGENTS_WS_METHODS.dismiss, {
      threadId: "thread-agents",
      workItemIds: ["task-1"],
    });
    expect(dismissed.error).toBeUndefined();
    expect(dismissed.result).toEqual({ dismissedCount: 0 });

    const invalid = await sendRequest(ws, AGENTS_WS_METHODS.dismiss, { workItemIds: [""] });
    expect(invalid.error).toBeDefined();
  });

  it.each([
    ["reset", false, false],
    ["alreadyRedeemed", false, false],
    ["nothingToReset", false, false],
    ["noCredit", false, false],
    ["reset", true, false],
    ["alreadyRedeemed", true, false],
    ["reset", true, true],
    ["reset", true, true, true],
  ] as const)(
    "refreshes after reset-credit outcome %s (recent refresh: %s; elapsed retry hint: %s) with the real account throttle",
    async (outcome, recentRefresh, elapsedRetryHint, persistentRefusal: boolean = false) => {
      const instanceId = ProviderInstanceId.makeUnsafe("claudeAgent-credit-test");
      let refreshCalls = 0;
      let probeCalls = 0;
      const registryLayer = Layer.effect(
        ProviderInstanceRegistry,
        Effect.gen(function* () {
          const capability = yield* makeAccountUsageCapability(
            {
              key: instanceId,
              provider: "claudeAgent",
              providerInstanceId: instanceId,
              displayName: "Credit test",
              enabled: true,
              refreshState: "idle",
              sections: [emptyAccountSection("claude-usage")],
            },
            Effect.sync(() => {
              probeCalls++;
              const fetchedAt = new Date().toISOString();
              return [
                {
                  kind: "claude-usage" as const,
                  outcome: "available" as const,
                  lastAttemptAt: fetchedAt,
                  errorCode: null,
                  snapshot: {
                    fetchedAt,
                    data: {
                      subscriptionLabel: "Max",
                      limitsAvailable: true,
                      windows: [],
                      extraUsage: null,
                    },
                  },
                },
              ];
            }),
            { identity: "test:claude" },
          );
          const instance = {
            instanceId,
            driverKind: ProviderDriverKind.make("claudeAgent"),
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("claudeAgent"),
              continuationKey: instanceId,
            },
            displayName: undefined,
            snapshot: {
              getSnapshot: Effect.succeed(defaultProviderSnapshots[0]!),
              refresh: Effect.succeed(defaultProviderSnapshots[0]!),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
            enabled: true,
            consumeResetCredit: () =>
              Effect.gen(function* () {
                if (recentRefresh) yield* capability.refreshAccount!(yield* Semaphore.make(2));
                return { outcome };
              }),
            accountUsage: {
              ...capability,
              refreshAccount: (permits) => {
                refreshCalls++;
                if (persistentRefusal)
                  return Effect.succeed({
                    snapshot: null,
                    fresh: false,
                    nextAllowedAt: new Date(0).toISOString(),
                  });
                const refresh = capability.refreshAccount!(permits);
                // Reproduce crossing the deadline between capability refusal and
                // the route inspecting its hint. Keep the real five-second gate.
                return elapsedRetryHint && refreshCalls === 1
                  ? refresh.pipe(
                      Effect.map((reply) => ({
                        ...reply,
                        nextAllowedAt: new Date(0).toISOString(),
                      })),
                    )
                  : refresh;
              },
            },
          } as ProviderInstance;
          return {
            getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
              Effect.flatMap(PubSub.subscribe),
            ),
          };
        }),
      );
      server = await createTestServer({ providerInstanceRegistryLayer: registryLayer });
      const address = server.address();
      const [ws] = await connectAndAwaitWelcome(
        typeof address === "object" && address ? address.port : 0,
      );
      connections.push(ws);
      const response = await sendRequest(ws, USAGE_WS_METHODS.consumeResetCredit, {
        providerInstanceId: instanceId,
        idempotencyKey: "credit-route-test",
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ outcome });
      expect(refreshCalls).toBe(1);
      expect(probeCalls).toBe(1);
      if (persistentRefusal) {
        await vi.waitFor(() => expect(refreshCalls).toBe(4));
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(refreshCalls).toBe(4);
        expect(probeCalls).toBe(1);
      } else if (recentRefresh) {
        // The response arrives while the real capability is throttled. The
        // scoped retry must perform a second probe after its five-second gate.
        await vi.waitFor(() => expect(probeCalls).toBe(2), { timeout: 7000 });
        // A timer can wake just before the gate, causing another refused
        // in-memory refresh attempt. The real probe count must still be exactly two.
        expect(refreshCalls).toBeGreaterThanOrEqual(2);
      }
    },
    15000,
  );

  it("writes rpc and websocket observability records when enabled", async () => {
    const stateDir = makeTempDir("t3code-ws-observability-");
    server = await createTestServer({
      cwd: "/test/project",
      stateDir,
      observabilityEnabled: true,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
    connections.splice(connections.indexOf(ws), 1);
    await closeTestServer();
    server = null;

    const tracePath = path.join(stateDir, "logs", "observability", "traces.ndjson");
    const metricsPath = path.join(stateDir, "logs", "observability", "metrics.ndjson");

    expect(fs.existsSync(tracePath)).toBe(true);
    expect(fs.existsSync(metricsPath)).toBe(true);

    const traces = fs
      .readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name: string; attributes: Record<string, unknown> });
    const metricSnapshots = fs
      .readFileSync(metricsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            metrics: Array<{
              id: string;
              attributes: Record<string, string>;
              value?: number;
            }>;
          },
      );

    expect(
      traces.some(
        (record) =>
          record.name === "rpc.server.getConfig" &&
          record.attributes["rpc.method"] === "server.getConfig",
      ),
    ).toBe(true);

    const latestSnapshot = metricSnapshots.at(-1);
    expect(latestSnapshot?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "t3_rpc_requests_total",
          attributes: {
            method: "server.getConfig",
            outcome: "success",
          },
        }),
        expect.objectContaining({
          id: "t3_websocket_connections_total",
          attributes: {
            event: "connect",
          },
          value: expect.any(Number),
        }),
        expect.objectContaining({
          id: "t3_websocket_connections_total",
          attributes: {
            event: "disconnect",
          },
          value: expect.any(Number),
        }),
      ]),
    );
    expect(
      latestSnapshot?.metrics.find(
        (metric) =>
          metric.id === "t3_websocket_connections_total" &&
          metric.attributes.event === "connect" &&
          typeof metric.value === "number",
      )?.value,
    ).toBeGreaterThanOrEqual(1);
    expect(
      latestSnapshot?.metrics.find(
        (metric) =>
          metric.id === "t3_websocket_connections_total" &&
          metric.attributes.event === "disconnect" &&
          typeof metric.value === "number",
      )?.value,
    ).toBeGreaterThanOrEqual(1);
  });

  it("does not write observability files when disabled", async () => {
    const stateDir = makeTempDir("t3code-ws-observability-disabled-");
    server = await createTestServer({
      cwd: "/test/project",
      stateDir,
      observabilityEnabled: false,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();

    await closeTestServer();
    server = null;

    expect(fs.existsSync(path.join(stateDir, "logs", "observability", "traces.ndjson"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(stateDir, "logs", "observability", "metrics.ndjson"))).toBe(
      false,
    );
  });

  it("serves persisted attachments from stateDir", async () => {
    const stateDir = makeTempDir("t3code-state-attachments-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-a", "message-a", "0.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-attachment"));

    server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/attachments/thread-a/message-a/0.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    // Stored attachments are write-once, so remounts and gallery views reuse the cache.
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-attachment"));
  });

  it("serves persisted attachments for URL-encoded paths", async () => {
    const stateDir = makeTempDir("t3code-state-attachments-encoded-");
    const attachmentPath = path.join(
      stateDir,
      "attachments",
      "thread%20folder",
      "message%20folder",
      "file%20name.png",
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-encoded-attachment"));

    server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(
      `http://127.0.0.1:${port}/attachments/thread%20folder/message%20folder/file%20name.png`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-encoded-attachment"));
  });

  it("serves project favicons only through registered project identities", async () => {
    const workspaceRoot = makeTempDir("f5-ws-project-favicon-");
    fs.writeFileSync(path.join(workspaceRoot, "favicon.svg"), "<svg>registered</svg>", "utf8");
    const projectId = ProjectId.makeUnsafe("project-favicon-route");
    server = await createTestServer({ cwd: "/test/project" });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const [socket] = await connectAndAwaitWelcome(port);
    connections.push(socket);

    const createProjectResponse = await sendRequest(
      socket,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "project.create",
        commandId: "cmd-project-favicon-route",
        projectId,
        title: "Favicon project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createProjectResponse.error).toBeUndefined();

    const response = await fetch(
      `http://127.0.0.1:${port}/api/project-favicon?projectId=${projectId}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("<svg>registered</svg>");

    const arbitraryRootResponse = await fetch(
      `http://127.0.0.1:${port}/api/project-favicon?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(arbitraryRootResponse.status).toBe(404);
    await arbitraryRootResponse.arrayBuffer();
  });

  it("serves static index for root path", async () => {
    const stateDir = makeTempDir("t3code-state-static-root-");
    const staticDir = makeTempDir("t3code-static-root-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>static-root</h1>", "utf8");

    server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("static-root");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>updated app</h1>", "utf8");
    const refreshed = await fetch(`http://127.0.0.1:${port}/index.html`, {
      headers: { "If-None-Match": "old-client" },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("cache-control")).toBe("no-cache");
    expect(await refreshed.text()).toContain("updated app");
  });

  it("streams app bundles with HEAD and immutable caching while missing bundles return 404", async () => {
    const stateDir = makeTempDir("f5-streamed-state-"),
      staticDir = makeTempDir("f5-streamed-app-");
    fs.mkdirSync(path.join(staticDir, "assets"));
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>Application shell</h1>");
    fs.writeFileSync(
      path.join(staticDir, "assets", "main-abcdef12.js"),
      "globalThis.bundleLoaded = true;",
    );
    server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const bundle = await fetch(`http://127.0.0.1:${port}/assets/main-abcdef12.js`);
    expect(await bundle.text()).toBe("globalThis.bundleLoaded = true;");
    expect(bundle.headers.get("cache-control")).toContain("immutable");
    expect(bundle.headers.get("content-security-policy")).toBeNull();
    fs.writeFileSync(path.join(staticDir, "assets", "code-highlight-worker.js"), "// worker");
    const worker = await fetch(`http://127.0.0.1:${port}/assets/code-highlight-worker.js`);
    expect(worker.headers.get("cache-control")).toBe("no-cache");
    expect(await worker.text()).toBe("// worker");
    const head = await fetch(`http://127.0.0.1:${port}/assets/main-abcdef12.js`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String(Buffer.byteLength("globalThis.bundleLoaded = true;")),
    );
    expect(await head.text()).toBe("");
    for (const file of ["missing.js", "missing.css"]) {
      const missing = await fetch(`http://127.0.0.1:${port}/assets/${file}`, {
        headers: { Accept: "text/html" },
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("Not Found");
    }
    const navigation = await fetch(`http://127.0.0.1:${port}/thread/client-route`, {
      headers: { Accept: "text/html" },
    });
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toContain("Application shell");
    expect(navigation.headers.get("cache-control")).toBe("no-cache");
    const request = await fetch(`http://127.0.0.1:${port}/thread/client-route`, {
      headers: { Accept: "application/json" },
    });
    expect(request.status).toBe(404);
    await request.text();
  });

  it("rejects static path traversal attempts", async () => {
    const stateDir = makeTempDir("t3code-state-static-traversal-");
    const staticDir = makeTempDir("t3code-static-traversal-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>safe</h1>", "utf8");

    server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await requestPath(port, "/..%2f..%2fetc/passwd");
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe("Invalid static file path");
  });

  it("bootstraps the cwd project on startup when enabled", async () => {
    vi.spyOn(console, "log");
    const cwd = path.join(makeTempDir("t3code-bootstrap-"), "bootstrap-workspace");
    fs.mkdirSync(cwd);
    server = await createTestServer({
      cwd,
      autoBootstrapProjectFromCwd: true,
      logWebSocketEvents: true,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws, welcome] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    expect(welcome.data).toEqual(
      expect.objectContaining({
        cwd,
        projectName: "bootstrap-workspace",
        bootstrapProjectId: expect.any(String),
        bootstrapThreadId: expect.any(String),
      }),
    );

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(snapshotResponse.error).toBeUndefined();
    const snapshot = snapshotResponse.result as {
      projects: Array<{
        id: string;
        workspaceRoot: string;
        title: string;
        defaultModel: string | null;
      }>;
      threads: Array<{
        id: string;
        projectId: string;
        title: string;
        model: string;
        branch: string | null;
        worktreePath: string | null;
      }>;
    };
    const bootstrapProjectId = (welcome.data as { bootstrapProjectId?: string }).bootstrapProjectId;
    const bootstrapThreadId = (welcome.data as { bootstrapThreadId?: string }).bootstrapThreadId;
    expect(bootstrapProjectId).toBeDefined();
    expect(bootstrapThreadId).toBeDefined();

    expect(snapshot.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapProjectId,
          workspaceRoot: cwd,
          title: "bootstrap-workspace",
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
        }),
      ]),
    );
    expect(snapshot.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapThreadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          branch: null,
          worktreePath: null,
        }),
      ]),
    );
  });

  it("includes bootstrap ids in welcome when cwd project and thread already exist", async () => {
    vi.spyOn(console, "log");
    const stateDir = makeTempDir("t3code-state-bootstrap-existing-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const cwd = path.join(stateDir, "bootstrap-existing");
    fs.mkdirSync(cwd);

    server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
      logWebSocketEvents: true,
    });
    let addr = server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [firstWs, firstWelcome] = await connectAndAwaitWelcome(port);
    connections.push(firstWs);
    const firstBootstrapProjectId = (firstWelcome.data as { bootstrapProjectId?: string })
      .bootstrapProjectId;
    const firstBootstrapThreadId = (firstWelcome.data as { bootstrapThreadId?: string })
      .bootstrapThreadId;
    expect(firstBootstrapProjectId).toBeDefined();
    expect(firstBootstrapThreadId).toBeDefined();

    firstWs.close();
    await closeTestServer();
    server = null;

    server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
    });
    addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [secondWs, secondWelcome] = await connectAndAwaitWelcome(port);
    connections.push(secondWs);
    expect(secondWelcome.data).toEqual(
      expect.objectContaining({
        cwd,
        projectName: "bootstrap-existing",
        bootstrapProjectId: firstBootstrapProjectId,
        bootstrapThreadId: firstBootstrapThreadId,
      }),
    );
  });

  it("returns thread details from projections while orchestration runtime startup is still pending", async () => {
    const stateDir = makeTempDir("t3code-state-thread-details-pending-runtime-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const workspaceRoot = stateDir;

    server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
    });
    let addr = server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [seedWs] = await connectAndAwaitWelcome(port);
    connections.push(seedWs);

    const createProjectResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "project.create",
        commandId: "cmd-project-pending-runtime-create",
        projectId: "project-pending-runtime",
        title: "Pending Runtime Project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createProjectResponse.error).toBeUndefined();

    const createThreadResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "thread.create",
        commandId: "cmd-thread-pending-runtime-create",
        threadId: "thread-pending-runtime",
        projectId: "project-pending-runtime",
        title: "Pending Runtime Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createThreadResponse.error).toBeUndefined();

    await closeTestServer();
    server = null;

    vi.resetModules();
    vi.doMock("./serverLayers.ts", async () => {
      const actual = await vi.importActual<typeof import("./serverLayers.ts")>("./serverLayers.ts");
      const orchestrationEngineModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationEngine.ts")
      >("./orchestration/Services/OrchestrationEngine.ts");
      const orchestrationReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationReactor.ts")
      >("./orchestration/Services/OrchestrationReactor.ts");
      const providerCommandReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderCommandReactor.ts")
      >("./orchestration/Services/ProviderCommandReactor.ts");
      const providerTurnDeliveryWorkerModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderTurnDeliveryWorker.ts")
      >("./orchestration/Services/ProviderTurnDeliveryWorker.ts");
      const workflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/WorkflowService.ts")
      >("./orchestration/Services/WorkflowService.ts");
      const codeReviewWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/CodeReviewWorkflowService.ts")
      >("./orchestration/Services/CodeReviewWorkflowService.ts");
      const investigationWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/InvestigationWorkflowService.ts")
      >("./orchestration/Services/InvestigationWorkflowService.ts");
      const projectSetupScriptRunnerModule = await vi.importActual<
        typeof import("./project/Services/ProjectSetupScriptRunner.ts")
      >("./project/Services/ProjectSetupScriptRunner.ts");
      const providerSessionDirectoryModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionDirectory.ts")
      >("./provider/Services/ProviderSessionDirectory.ts");
      const providerSessionReaperModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionReaper.ts")
      >("./provider/Services/ProviderSessionReaper.ts");
      const threadBackgroundWorkModule = await vi.importActual<
        typeof import("./orchestration/Services/ThreadBackgroundWork.ts")
      >("./orchestration/Services/ThreadBackgroundWork.ts");
      const usageServiceModule = await vi.importActual<
        typeof import("./usage/Services/UsageService.ts")
      >("./usage/Services/UsageService.ts");
      const nextTurnQueueDispatcherModule = await vi.importActual<
        typeof import("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts")
      >("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts");
      const storageMaintenanceModule = await vi.importActual<
        typeof import("./storage/StorageMaintenance.ts")
      >("./storage/StorageMaintenance.ts");
      const worktreeManagerModule = await vi.importActual<
        typeof import("./project/Services/WorktreeManager.ts")
      >("./project/Services/WorktreeManager.ts");
      const worktreeSetupModule = await vi.importActual<
        typeof import("./project/Services/WorktreeSetup.ts")
      >("./project/Services/WorktreeSetup.ts");
      const storageCleanupWorkerModule = await vi.importActual<
        typeof import("./storage/StorageCleanupWorker.ts")
      >("./storage/StorageCleanupWorker.ts");
      const skillSyncModule = await vi.importActual<
        typeof import("./orchestration/Services/ProjectSkillSyncService.ts")
      >("./orchestration/Services/ProjectSkillSyncService.ts");
      const defaultBranchAutoPullModule = await vi.importActual<
        typeof import("./git/DefaultBranchAutoPull.ts")
      >("./git/DefaultBranchAutoPull.ts");
      const pendingRuntimeLayer = Layer.mergeAll(
        Layer.succeed(orchestrationEngineModule.OrchestrationEngineService, {
          getReadModel: () => Effect.die(new Error("unused in pending-runtime ws test")),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.die(new Error("unused in pending-runtime ws test")),
          acquireMaintenanceLock: () => Scope.make("sequential"),
          streamDomainEvents: Stream.empty,
        }),
        Layer.succeed(orchestrationReactorModule.OrchestrationReactor, {
          start: Effect.never,
        }),
        Layer.succeed(providerCommandReactorModule.ProviderCommandReactor, {} as any),
        Layer.succeed(providerTurnDeliveryWorkerModule.ProviderTurnDeliveryWorker, {} as any),
        Layer.succeed(providerSessionReaperModule.ProviderSessionReaper, {
          sweep: () => Effect.void,
          start: () => Effect.void,
        }),
        Layer.succeed(threadBackgroundWorkModule.ThreadBackgroundWork, {
          recordProviderEvent: () => Effect.void,
          getSnapshot: Effect.succeed({
            entries: [],
            generatedAt: "2026-01-01T00:00:00.000Z",
          }),
          getThreadSnapshot: () =>
            Effect.succeed({ entries: [], generatedAt: "2026-01-01T00:00:00.000Z" }),
          dismiss: () => Effect.succeed({ dismissedCount: 0 }),
          expireStale: () => Effect.void,
          listProtectedThreadIds: () => Effect.succeed(new Set()),
          hasFreshProtectingWork: () => Effect.succeed(false),
          changes: Stream.empty,
        }),
        Layer.succeed(usageServiceModule.UsageService, {
          consumeResetCredit: () => Effect.die("unused reset credit"),
          refreshAccount: () => Effect.succeed({ snapshot: null, fresh: false }),
          getSummary: () => Effect.die("unused usage summary"),
          getAccounts: () => Effect.succeed([]),
          getQuotaHistory: Effect.die("unused quota history"),
        }),
        Layer.succeed(providerSessionDirectoryModule.ProviderSessionDirectory, {} as any),
        Layer.succeed(skillSyncModule.ProjectSkillSyncService, {
          start: Effect.void,
          drain: Effect.void,
          getWarnings: () => Effect.succeed([]),
        }),
        Layer.succeed(workflowServiceModule.WorkflowService, {} as any),
        Layer.succeed(codeReviewWorkflowServiceModule.CodeReviewWorkflowService, {} as any),
        Layer.succeed(investigationWorkflowServiceModule.InvestigationWorkflowService, {} as any),
        Layer.succeed(projectSetupScriptRunnerModule.ProjectSetupScriptRunner, {} as any),
        Layer.succeed(storageMaintenanceModule.StorageMaintenance, {} as any),
        Layer.succeed(WorktreePreparation, {
          prepare: () => Effect.void,
          needsPreparation: () => Effect.succeed(false),
          startBackground: () => Effect.void,
          startup: Effect.void,
        }),
        Layer.succeed(worktreeManagerModule.WorktreeManager, {} as never),
        Layer.succeed(WorkspaceTransition, {} as never),
        Layer.succeed(worktreeSetupModule.WorktreeSetup, {
          startup: Effect.void,
          changes: Stream.empty,
        } as any),
        Layer.succeed(storageCleanupWorkerModule.StorageCleanupWorker, {
          start: Effect.void,
        } as any),
        Layer.succeed(defaultBranchAutoPullModule.DefaultBranchAutoPull, {
          start: Effect.void,
        } as any),
        Layer.succeed(nextTurnQueueDispatcherModule.NextTurnQueueDispatcher, {
          start: Effect.void,
          notify: () => Effect.void,
          drain: Effect.void,
          getSnapshot: () => Effect.die("unused queue snapshot"),
          getSummary: Effect.succeed({ threads: [] }),
          submitAndSettle: () => Effect.die("unused queue submission"),
          promote: () => Effect.die("unused queue promote"),
          refreshGate: () => Effect.die("unused queue refresh"),
          changes: Stream.empty,
          summaryChanges: Stream.empty,
        } as any),
      );
      return {
        ...actual,
        makeServerOrchestrationRuntimeLayer: () => pendingRuntimeLayer,
      };
    });
    const { createServer: createServerWithPendingRuntime } = await import("./wsServer");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
      createServerFactory: createServerWithPendingRuntime,
    });
    addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const settingsResponse = await Promise.race([
      sendRequest(ws, WS_METHODS.serverGetProjectSettings, {
        projectId: "project-pending-runtime",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Project settings waited for runtime startup")), 1000),
      ),
    ]);
    expect(settingsResponse.error).toBeUndefined();
    expect(settingsResponse.result).toMatchObject({ skillScanWarnings: [] });

    const threadDetailsResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getThreadDetails, {
      threadId: "thread-pending-runtime",
    });
    expect(threadDetailsResponse.error).toBeUndefined();
    expect(threadDetailsResponse.result).toEqual(
      expect.objectContaining({
        threadId: "thread-pending-runtime",
        messages: [],
        checkpoints: [],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const loggedLines = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map(([message]) => (typeof message === "string" ? message : ""))
      .filter(Boolean);
    expect(loggedLines.some((line) => line.includes("startup timed out"))).toBe(false);
  });

  it("returns thread tail details without waiting for passive codex reconciliation", async () => {
    const stateDir = makeTempDir("t3code-state-thread-tail-reconcile-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const workspaceRoot = stateDir;
    const projectId = ProjectId.makeUnsafe("project-tail-reconcile");
    const threadId = asThreadId("thread-tail-reconcile");
    const turnId = asTurnId("turn-tail-reconcile");

    server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
    });
    let addr = server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [seedWs] = await connectAndAwaitWelcome(port);
    connections.push(seedWs);

    const createProjectResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "project.create",
        commandId: "cmd-project-tail-reconcile-create",
        projectId,
        title: "Tail Reconcile Project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createProjectResponse.error).toBeUndefined();

    const createThreadResponse = await sendRequest(
      seedWs,
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      {
        type: "thread.create",
        commandId: "cmd-thread-tail-reconcile-create",
        threadId,
        projectId,
        title: "Tail Reconcile Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(createThreadResponse.error).toBeUndefined();

    await closeTestServer();
    server = null;

    let readThreadStarted = false;

    vi.resetModules();
    vi.doMock("./serverLayers.ts", async () => {
      const actual = await vi.importActual<typeof import("./serverLayers.ts")>("./serverLayers.ts");
      const { McpAppService } = await vi.importActual<typeof import("./mcpApps/McpAppService.ts")>(
        "./mcpApps/McpAppService.ts",
      );
      const { ThreadSettlementService } = await vi.importActual<
        typeof import("./orchestration/Layers/ThreadSettlementService.ts")
      >("./orchestration/Layers/ThreadSettlementService.ts");
      const { PullRequestWatchService } = await vi.importActual<
        typeof import("./orchestration/Layers/PullRequestWatchService.ts")
      >("./orchestration/Layers/PullRequestWatchService.ts");
      const orchestrationEngineModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationEngine.ts")
      >("./orchestration/Services/OrchestrationEngine.ts");
      const orchestrationReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/OrchestrationReactor.ts")
      >("./orchestration/Services/OrchestrationReactor.ts");
      const providerCommandReactorModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderCommandReactor.ts")
      >("./orchestration/Services/ProviderCommandReactor.ts");
      const providerTurnDeliveryWorkerModule = await vi.importActual<
        typeof import("./orchestration/Services/ProviderTurnDeliveryWorker.ts")
      >("./orchestration/Services/ProviderTurnDeliveryWorker.ts");
      const workflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/WorkflowService.ts")
      >("./orchestration/Services/WorkflowService.ts");
      const codeReviewWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/CodeReviewWorkflowService.ts")
      >("./orchestration/Services/CodeReviewWorkflowService.ts");
      const investigationWorkflowServiceModule = await vi.importActual<
        typeof import("./orchestration/Services/InvestigationWorkflowService.ts")
      >("./orchestration/Services/InvestigationWorkflowService.ts");
      const projectSetupScriptRunnerModule = await vi.importActual<
        typeof import("./project/Services/ProjectSetupScriptRunner.ts")
      >("./project/Services/ProjectSetupScriptRunner.ts");
      const providerSessionDirectoryModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionDirectory.ts")
      >("./provider/Services/ProviderSessionDirectory.ts");
      const providerSessionReaperModule = await vi.importActual<
        typeof import("./provider/Services/ProviderSessionReaper.ts")
      >("./provider/Services/ProviderSessionReaper.ts");
      const threadBackgroundWorkModule = await vi.importActual<
        typeof import("./orchestration/Services/ThreadBackgroundWork.ts")
      >("./orchestration/Services/ThreadBackgroundWork.ts");
      const usageServiceModule = await vi.importActual<
        typeof import("./usage/Services/UsageService.ts")
      >("./usage/Services/UsageService.ts");
      const storageMaintenanceModule = await vi.importActual<
        typeof import("./storage/StorageMaintenance.ts")
      >("./storage/StorageMaintenance.ts");
      const worktreeManagerModule = await vi.importActual<
        typeof import("./project/Services/WorktreeManager.ts")
      >("./project/Services/WorktreeManager.ts");
      const worktreeSetupModule = await vi.importActual<
        typeof import("./project/Services/WorktreeSetup.ts")
      >("./project/Services/WorktreeSetup.ts");
      const storageCleanupWorkerModule = await vi.importActual<
        typeof import("./storage/StorageCleanupWorker.ts")
      >("./storage/StorageCleanupWorker.ts");
      const skillSyncModule = await vi.importActual<
        typeof import("./orchestration/Services/ProjectSkillSyncService.ts")
      >("./orchestration/Services/ProjectSkillSyncService.ts");
      const defaultBranchAutoPullModule = await vi.importActual<
        typeof import("./git/DefaultBranchAutoPull.ts")
      >("./git/DefaultBranchAutoPull.ts");
      const nextTurnQueueDispatcherModule = await vi.importActual<
        typeof import("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts")
      >("./nextTurnQueue/Services/NextTurnQueueDispatcher.ts");

      const readModelThread: OrchestrationThread = {
        id: threadId,
        projectId,
        title: "Tail Reconcile Thread",
        model: "gpt-5-codex",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          assistantMessageId: null,
        },
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastInteractionAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        deletedAt: null,
        estimatedContextTokens: null,
        modelContextWindowTokens: null,
        messages: [],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        compaction: null,
        sessionNotes: null,
        threadReferences: [],
        activities: [],
        checkpoints: [],
        session: null,
      };

      const readModel: OrchestrationReadModel = {
        snapshotSequence: 1,
        projects: [],
        threads: [readModelThread],
        planningWorkflows: [],
        codeReviewWorkflows: [],
        investigationWorkflows: [],
        updatedAt: "2026-01-01T00:00:01.000Z",
      };

      const runtimeLayer = Layer.mergeAll(
        Layer.mock(McpAppService)({}),
        Layer.mock(ThreadSettlementService)({ start: Effect.void }),
        Layer.mock(PullRequestWatchService)({ start: Effect.void, changes: Stream.empty }),
        Layer.succeed(orchestrationEngineModule.OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(readModel),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          acquireMaintenanceLock: () => Scope.make("sequential"),
          streamDomainEvents: Stream.empty,
        }),
        Layer.succeed(orchestrationReactorModule.OrchestrationReactor, {
          start: Effect.void,
        }),
        Layer.succeed(providerCommandReactorModule.ProviderCommandReactor, {} as any),
        Layer.succeed(providerTurnDeliveryWorkerModule.ProviderTurnDeliveryWorker, {} as any),
        Layer.succeed(providerSessionReaperModule.ProviderSessionReaper, {
          sweep: () => Effect.void,
          start: () => Effect.void,
        }),
        Layer.succeed(threadBackgroundWorkModule.ThreadBackgroundWork, {
          recordProviderEvent: () => Effect.void,
          getSnapshot: Effect.succeed({
            entries: [],
            generatedAt: "2026-01-01T00:00:00.000Z",
          }),
          getThreadSnapshot: () =>
            Effect.succeed({ entries: [], generatedAt: "2026-01-01T00:00:00.000Z" }),
          dismiss: () => Effect.succeed({ dismissedCount: 0 }),
          expireStale: () => Effect.void,
          listProtectedThreadIds: () => Effect.succeed(new Set()),
          hasFreshProtectingWork: () => Effect.succeed(false),
          changes: Stream.empty,
        }),
        Layer.succeed(usageServiceModule.UsageService, {
          consumeResetCredit: () => Effect.die("unused reset credit"),
          refreshAccount: () => Effect.succeed({ snapshot: null, fresh: false }),
          getSummary: () => Effect.die("unused usage summary"),
          getAccounts: () => Effect.succeed([]),
          getQuotaHistory: Effect.die("unused quota history"),
        }),
        Layer.succeed(providerSessionDirectoryModule.ProviderSessionDirectory, {
          getBinding: (requestedThreadId: ThreadId) =>
            Effect.succeed(
              requestedThreadId === threadId
                ? Option.some({
                    threadId,
                    projectId,
                    provider: "codex" as const,
                    status: "running" as const,
                    lastSeenAt: "2026-01-01T00:00:00.000Z",
                  })
                : Option.none(),
            ),
        } as any),
        Layer.succeed(skillSyncModule.ProjectSkillSyncService, {
          start: Effect.void,
          drain: Effect.void,
          getWarnings: () => Effect.succeed([]),
        }),
        Layer.succeed(workflowServiceModule.WorkflowService, {} as any),
        Layer.succeed(codeReviewWorkflowServiceModule.CodeReviewWorkflowService, {} as any),
        Layer.succeed(investigationWorkflowServiceModule.InvestigationWorkflowService, {} as any),
        Layer.succeed(projectSetupScriptRunnerModule.ProjectSetupScriptRunner, {} as any),
        Layer.succeed(storageMaintenanceModule.StorageMaintenance, {} as any),
        Layer.succeed(WorktreePreparation, {
          prepare: () => Effect.void,
          needsPreparation: () => Effect.succeed(false),
          startBackground: () => Effect.void,
          startup: Effect.void,
        }),
        Layer.succeed(worktreeManagerModule.WorktreeManager, {} as never),
        Layer.succeed(WorkspaceTransition, {} as never),
        Layer.succeed(worktreeSetupModule.WorktreeSetup, {
          startup: Effect.void,
          changes: Stream.empty,
        } as any),
        Layer.succeed(storageCleanupWorkerModule.StorageCleanupWorker, {
          start: Effect.void,
        } as any),
        Layer.succeed(defaultBranchAutoPullModule.DefaultBranchAutoPull, {
          start: Effect.void,
        } as any),
        Layer.succeed(nextTurnQueueDispatcherModule.NextTurnQueueDispatcher, {
          start: Effect.void,
          notify: () => Effect.void,
          drain: Effect.void,
          getSnapshot: () => Effect.die("unused queue snapshot"),
          getSummary: Effect.succeed({ threads: [] }),
          submitAndSettle: () => Effect.die("unused queue submission"),
          promote: () => Effect.die("unused queue promote"),
          refreshGate: () => Effect.die("unused queue refresh"),
          changes: Stream.empty,
          summaryChanges: Stream.empty,
        } as any),
      );

      return {
        ...actual,
        makeServerOrchestrationRuntimeLayer: () => runtimeLayer,
      };
    });
    const { createServer: createServerWithMockedRuntime } = await import("./wsServer");

    const providerLayer = Layer.succeed(ProviderService, {
      ...defaultProviderService,
      readThread: () =>
        Effect.sync(() => {
          readThreadStarted = true;
        }).pipe(Effect.andThen(Effect.never)),
    } as unknown as ProviderServiceShape);

    server = await createTestServer({
      cwd: workspaceRoot,
      stateDir,
      persistenceLayer,
      providerLayer,
      createServerFactory: createServerWithMockedRuntime,
    });
    addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const tailResponse = await Promise.race([
      sendRequest(ws, ORCHESTRATION_WS_METHODS.getThreadTailDetails, {
        threadId,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Timed out waiting for thread tail details"));
        }, 1_000);
      }),
    ]);

    expect(tailResponse.error).toBeUndefined();
    expect(tailResponse.result).toEqual(
      expect.objectContaining({
        threadId,
        messages: [],
        checkpoints: [],
        hasOlderMessages: false,
        hasOlderCheckpoints: false,
      }),
    );

    await vi.waitFor(() => expect(readThreadStarted).toBe(true), { timeout: 1_000 });
  });

  it("logs outbound websocket push events in dev mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output clean while verifying websocket logs.
    });

    server = await createTestServer({
      cwd: "/test/project",
      devUrl: "http://localhost:5173",
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    expect(
      logSpy.mock.calls.some(([message]) => {
        if (typeof message !== "string") return false;
        return (
          message.includes("[ws]") &&
          message.includes("outgoing push") &&
          message.includes(`channel="${WS_CHANNELS.serverWelcome}"`)
        );
      }),
    ).toBe(true);
  });

  it("responds to server.probe without waiting for provider or orchestration work", async () => {
    server = await createTestServer();

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const [ws] = await connectAndAwaitWelcome(address.port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverProbe);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({});
  });

  it("resolves project settings over files, replaces overrides and prunes deleted projects", async () => {
    const workspaceRoot = makeTempDir("f5-project-scope-");
    fs.writeFileSync(
      path.join(workspaceRoot, "f5.json"),
      JSON.stringify({ defaultRuntimeMode: "approval-required", worktreeSubmodules: "none" }),
    );
    server = await createTestServer({ cwd: workspaceRoot });
    const address = server.address();
    const [ws] = await connectAndAwaitWelcome(
      typeof address === "object" && address ? address.port : 0,
    );
    connections.push(ws);
    const projectId = "scoped-project";
    const createdAt = new Date().toISOString();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "scope-project-create",
          projectId,
          title: "Scoped",
          workspaceRoot,
          defaultModel: "gpt-5",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    const original = await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId });
    expect(original.error).toBeUndefined();
    expect(original.result).toMatchObject({
      settings: { defaultRuntimeMode: "approval-required", worktreeSubmodules: "none" },
      sources: { defaultRuntimeMode: "f5.json" },
    });
    expect(
      (
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" } },
        })
      ).error,
    ).toBeUndefined();
    expect(
      (await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId })).result,
    ).toMatchObject({
      settings: { defaultRuntimeMode: "full-access" },
      sources: { defaultRuntimeMode: "project" },
    });
    expect(
      (
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          projectSettingsOverrides: { [projectId]: { enableAssistantStreaming: true } },
        })
      ).error,
    ).toBeUndefined();
    expect(
      (await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId })).result,
    ).toMatchObject({
      overrides: { enableAssistantStreaming: true },
      settings: { defaultRuntimeMode: "approval-required" },
    });
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.delete",
          commandId: "scope-project-delete",
          projectId,
          deletedAt: createdAt,
        })
      ).error,
    ).toBeUndefined();
    await expect
      .poll(
        async () =>
          (
            (await sendRequest(ws, WS_METHODS.serverGetConfig)).result as {
              settings: ServerSettings;
            }
          ).settings.projectSettingsOverrides[projectId as ProjectId],
      )
      .toBeUndefined();
    expect(
      (await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId })).error,
    ).toBeDefined();
  });

  it("responds to server.getConfig", async () => {
    const stateDir = makeTempDir("t3code-state-get-config-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      customKeybindings: [],
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expect(
      (response.result as { keybindings: ResolvedKeybindingsConfig }).keybindings.some(
        (entry) => entry.command === "thread.switchRecentNext" && entry.shortcut.key === "tab",
      ),
    ).toBe(true);
    expect(
      (response.result as { keybindings: ResolvedKeybindingsConfig }).keybindings.some(
        (entry) =>
          entry.command === "thread.switchRecentPrevious" &&
          entry.shortcut.key === "tab" &&
          entry.shortcut.shiftKey,
      ),
    ).toBe(true);
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
  });

  it("redacts server settings secrets in server.getConfig", async () => {
    const stateDir = makeTempDir("t3code-state-get-config-redacted-");
    const instanceId = ProviderInstanceId.make("codex_personal");
    fs.writeFileSync(
      path.join(stateDir, "settings.json"),
      JSON.stringify(
        {
          observability: {
            otlpHeaders: [{ name: "Authorization", value: "collector-private-header" }],
          },
          providers: {
            opencode: {
              serverPassword: "server-password",
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: "opencode",
              config: {
                serverPassword: "instance-password",
              },
              environment: [
                {
                  name: "OPENAI_API_KEY",
                  value: "sk-secret",
                  sensitive: true,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response.result)).not.toContain("collector-private-header");
    const settings = (response.result as { settings: ServerSettings }).settings;
    expect(settings.providers.opencode.serverPassword).toBe("");
    expect(settings.providerInstances[instanceId]?.config).toMatchObject({
      serverPassword: "",
    });
    expect(settings.providerInstances[instanceId]?.environment).toEqual([
      {
        name: "OPENAI_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ]);
  });

  it("refreshes only the requested provider when verifying one installation", async () => {
    const refresh = vi.spyOn(defaultProviderRegistryService, "refresh");
    const refreshInstance = vi.spyOn(defaultProviderRegistryService, "refreshInstance");
    try {
      server = await createTestServer();
      const addr = server.address();
      const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
      connections.push(ws);
      const response = await sendRequest(ws, WS_METHODS.serverRefreshProviders, {
        instanceId: "codex",
      });
      expect(response.error).toBeUndefined();
      expect(refreshInstance).toHaveBeenCalledWith("codex");
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
      refreshInstance.mockRestore();
    }
  });

  it("keeps health refresh independent and awaits explicit update checks", async () => {
    let finished = false;
    const refreshAdvisories = vi.fn<ProviderUpdateAdvisorShape["refreshAdvisories"]>(() =>
      Effect.promise(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      }),
    );
    server = await createTestServer({
      providerUpdateAdvisor: { ...defaultProviderUpdateAdvisorService, refreshAdvisories },
    });
    const addr = server.address();
    const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
    connections.push(ws);
    const health = await sendRequest(ws, WS_METHODS.serverRefreshProviders);
    expect(health.error).toBeUndefined();
    expect(refreshAdvisories).not.toHaveBeenCalled();
    const checked = await sendRequest(ws, WS_METHODS.serverCheckProviderUpdates, {
      instanceId: "codex",
    });
    expect(checked.error).toBeUndefined();
    expect(finished).toBe(true);
    expect(refreshAdvisories).toHaveBeenCalledWith({ mode: "explicit", instanceId: "codex" });
    expect(checked.result).toEqual({ providers: defaultProviderSnapshots });
  });

  it("returns provider update results with decorated providers and maps admission errors", async () => {
    const result = {
      instanceId: ProviderInstanceId.make("codex"),
      outcome: "updated" as const,
      previousVersion: "1.0.0",
      currentVersion: "1.1.0",
      exitCode: 0,
      timedOut: false,
      output: "installed",
      outputTruncated: false,
    };
    let reject = false;
    const runUpdate = vi.fn<ProviderUpdateAdvisorShape["runUpdate"]>(() =>
      reject
        ? Effect.fail(new ProviderUpdateRunError({ message: "Provider has active work." }))
        : Effect.succeed(result),
    );
    server = await createTestServer({
      providerUpdateAdvisor: { ...defaultProviderUpdateAdvisorService, runUpdate },
    });
    const addr = server.address();
    const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
    connections.push(ws);
    const updated = await sendRequest(ws, WS_METHODS.serverRunProviderUpdate, {
      instanceId: "codex",
    });
    expect(updated.error).toBeUndefined();
    expect(updated.result).toEqual({ ...result, providers: defaultProviderSnapshots });
    expect(runUpdate).toHaveBeenCalledWith("codex");
    reject = true;
    const refused = await sendRequest(ws, WS_METHODS.serverRunProviderUpdate, {
      instanceId: "codex",
    });
    expect(refused.error).toMatchObject({ message: "Provider has active work." });
  });

  it("routes server.validateHarnesses through the harness validation service", async () => {
    const validateHarnesses = vi.fn<HarnessValidationShape["validate"]>((input) =>
      Effect.succeed([
        {
          provider: "claudeAgent",
          status: "ready",
          installed: true,
          authStatus: "authenticated",
          checkedAt: "2026-01-01T00:00:00.000Z",
          version: "1.0.0",
          ...(input?.providerOptions?.claudeAgent ? { message: "Claude ready." } : {}),
        },
        {
          provider: "codex",
          status: "error",
          installed: true,
          authStatus: "unknown",
          failureKind: "connectivity",
          checkedAt: "2026-01-01T00:00:00.000Z",
          message: "Codex one-off prompt query timed out.",
        },
      ]),
    );

    server = await createTestServer({
      cwd: "/my/workspace",
      harnessValidation: {
        validate: validateHarnesses,
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverValidateHarnesses, {
      providerOptions: {
        codex: {
          binaryPath: "/tmp/custom-codex",
          homePath: "/tmp/.codex",
        },
        claudeAgent: {
          binaryPath: "/tmp/custom-claude",
        },
      },
    });

    expect(response.error).toBeUndefined();
    expect(validateHarnesses).toHaveBeenCalledWith({
      providerOptions: {
        codex: {
          binaryPath: "/tmp/custom-codex",
          homePath: "/tmp/.codex",
        },
        claudeAgent: {
          binaryPath: "/tmp/custom-claude",
        },
      },
    });
    expect(response.result).toEqual({
      results: [
        {
          provider: "claudeAgent",
          status: "ready",
          installed: true,
          authStatus: "authenticated",
          checkedAt: "2026-01-01T00:00:00.000Z",
          version: "1.0.0",
          message: "Claude ready.",
        },
        {
          provider: "codex",
          status: "error",
          installed: true,
          authStatus: "unknown",
          failureKind: "connectivity",
          checkedAt: "2026-01-01T00:00:00.000Z",
          message: "Codex one-off prompt query timed out.",
        },
      ],
    });
  });

  it("returns a deterministic error when harness validation is already in progress", async () => {
    server = await createTestServer({
      cwd: "/my/workspace",
      harnessValidation: {
        validate: () =>
          Effect.fail(
            new ProviderValidationBusyError({
              message: "Harness validation is already in progress.",
            }),
          ),
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverValidateHarnesses);

    expect(response.result).toBeUndefined();
    expect(response.error).toEqual({
      message: "Harness validation is already in progress.",
    });
  });

  it("bootstraps default keybindings file when missing", async () => {
    const stateDir = makeTempDir("t3code-state-bootstrap-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    expect(fs.existsSync(keybindingsPath)).toBe(false);

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      customKeybindings: [],
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);

    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(persistedConfig).toEqual([]);
  });

  it("falls back to defaults and reports malformed keybindings config issues", async () => {
    const stateDir = makeTempDir("t3code-state-malformed-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "{ not-json", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      customKeybindings: [],
      issues: [
        {
          kind: "keybindings.malformed-config",
          message: expect.stringContaining("expected JSON array"),
        },
      ],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
    expect(fs.readFileSync(keybindingsPath, "utf8")).toBe("{ not-json");
  });

  it("ignores invalid keybinding entries but keeps valid entries and reports issues", async () => {
    const stateDir = makeTempDir("t3code-state-partial-invalid-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+d+o", command: "terminal.new" },
        { key: "mod+x", command: "not-a-real-command" },
      ]),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const result = response.result as {
      cwd: string;
      keybindingsConfigPath: string;
      keybindings: ResolvedKeybindingsConfig;
      issues: Array<{ kind: string; index?: number; message: string }>;
      providers: ReadonlyArray<ServerProvider>;
      availableEditors: unknown;
    };
    expect(result.cwd).toBe("/my/workspace");
    expect(result.keybindingsConfigPath).toBe(keybindingsPath);
    expect(result.issues).toEqual([
      {
        kind: "keybindings.invalid-entry",
        index: 1,
        message: expect.any(String),
      },
      {
        kind: "keybindings.invalid-entry",
        index: 2,
        message: expect.any(String),
      },
    ]);
    expect(result.keybindings).toHaveLength(DEFAULT_RESOLVED_KEYBINDINGS.length);
    expect(result.keybindings.some((entry) => entry.command === "terminal.toggle")).toBe(true);
    expect(result.keybindings.some((entry) => entry.command === "terminal.new")).toBe(true);
    expect(result.providers).toEqual(defaultProviderSnapshots);
    expectAvailableEditors(result.availableEditors);
  });

  it("pushes server.configUpdated issues when keybindings file changes", async () => {
    const stateDir = makeTempDir("t3code-state-keybindings-watch-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const malformedPush = await rewriteKeybindingsAndWaitForPush(
      ws,
      keybindingsPath,
      "{ not-json",
      (push) =>
        Array.isArray(push.data.issues) &&
        Boolean(push.data.issues[0]) &&
        push.data.issues[0]!.kind === "keybindings.malformed-config",
    );
    expect(malformedPush.data).toEqual({
      source: "keybindings",
      issues: [{ kind: "keybindings.malformed-config", message: expect.any(String) }],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
    });

    const successPush = await rewriteKeybindingsAndWaitForPush(
      ws,
      keybindingsPath,
      "[]",
      (push) => Array.isArray(push.data.issues) && push.data.issues.length === 0,
    );
    expect(successPush.data).toEqual({
      source: "keybindings",
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
    });
  });

  it("routes shell.openInEditor through the injected open service", async () => {
    const openCalls: Array<{ cwd: string; editor: string }> = [];
    const openService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: (input) => {
        openCalls.push({ cwd: input.cwd, editor: input.editor });
        return Effect.void;
      },
      revealInFileManager: () => Effect.void,
    };

    server = await createTestServer({ cwd: "/my/workspace", open: openService });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.shellOpenInEditor, {
      cwd: "/my/workspace",
      editor: "cursor",
    });
    expect(response.error).toBeUndefined();
    expect(openCalls).toEqual([{ cwd: "/my/workspace", editor: "cursor" }]);
  });

  it("routes shell.revealInFileManager through the injected open service", async () => {
    const workspaceRoot = makeTempDir("t3code-reveal-workspace-");
    fs.mkdirSync(path.join(workspaceRoot, "src"));
    fs.writeFileSync(path.join(workspaceRoot, "src", "app.ts"), "export {};\n", "utf8");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspaceRoot, stdio: "pipe" });
    git("init", "-q", "--initial-branch=main");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "initial",
    );
    const revealCalls: string[] = [];
    const openService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: () => Effect.void,
      revealInFileManager: (targetPath) => {
        revealCalls.push(targetPath);
        return Effect.void;
      },
    };
    server = await createTestServer({ cwd: workspaceRoot, open: openService });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = "project-reveal";
    const threadId = "thread-reveal";
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "cmd-project-reveal",
          projectId,
          title: "Reveal project",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.create",
          commandId: "cmd-thread-reveal",
          threadId,
          projectId,
          title: "Reveal thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      relativePath: "src/app.ts",
      kind: "file",
    });
    expect(response.error).toBeUndefined();
    expect(revealCalls).toEqual([path.join(fs.realpathSync(workspaceRoot), "src", "app.ts")]);
    const rootResponse = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      relativePath: ".",
      kind: "directory",
    });
    expect(rootResponse.error).toBeUndefined();
    expect(revealCalls[1]).toBe(fs.realpathSync(workspaceRoot));
    const escapeResponse = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      relativePath: "..",
      kind: "directory",
    });
    expect(escapeResponse.error).toBeDefined();
    expect(revealCalls).toHaveLength(2);
    const external = makeTempDir("t3code-reveal-external-");
    fs.writeFileSync(path.join(external, "report.json"), "{}");
    const localReveal = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      cwd: external,
      relativePath: "report.json",
      kind: "file",
    });
    expect(localReveal.error).toBeUndefined();
    expect(revealCalls[2]).toBe(path.join(fs.realpathSync(external), "report.json"));
    for (const input of [
      { cwd: "relative-directory", relativePath: "report.json", kind: "file" },
      { cwd: external, relativePath: ".", kind: "directory" },
    ]) {
      const denied = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
        projectId,
        threadId,
        ...input,
      });
      expect(denied.error).toBeDefined();
    }
    for (const relativePath of ["missing.json", "../report.json"]) {
      const rejected = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
        projectId,
        threadId,
        cwd: external,
        relativePath,
        kind: "file",
      });
      expect(rejected.error).toBeDefined();
    }
    fs.symlinkSync(workspaceRoot, path.join(external, "escape"), "dir");
    const symlinkEscape = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      cwd: external,
      relativePath: "escape/src/app.ts",
      kind: "file",
    });
    expect(symlinkEscape.error).toBeDefined();
    expect(revealCalls).toHaveLength(3);
    const inventory = await sendRequest(ws, WS_METHODS.worktreesList, { projectId });
    expect(inventory.error).toBeUndefined();
    expect(inventory.result).toMatchObject({
      projects: [
        {
          projectId,
          entries: [
            {
              classification: "projectCheckout",
              branch: "main",
              missing: false,
              hasChanges: false,
              linkedThreads: [{ threadId, title: "Reveal thread", archived: false }],
            },
          ],
        },
      ],
    });
    const unknown = await sendRequest(ws, WS_METHODS.worktreesList, { projectId: "unknown" });
    expect(unknown.error).toBeDefined();
  });

  it("reads keybindings from the configured state directory", async () => {
    const stateDir = makeTempDir("t3code-state-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "mod+y", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]),
      "utf8",
    );
    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileMergedKeybindings(persistedConfig),
      customKeybindings: persistedConfig,
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
  });

  it("upserts keybinding rules and updates cached server config", async () => {
    const stateDir = makeTempDir("t3code-state-upsert-keybinding-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const upsertResponse = await sendRequest(ws, WS_METHODS.serverUpsertKeybinding, {
      key: "mod+shift+r",
      command: "script.run-tests.run",
    });
    expect(upsertResponse.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    const persistedCommands = new Set(persistedConfig.map((entry) => entry.command));
    expect(persistedConfig).toHaveLength(1);
    expect(persistedCommands.has("script.run-tests.run")).toBe(true);
    expect(upsertResponse.result).toEqual({
      keybindings: compileMergedKeybindings(persistedConfig),
      customKeybindings: persistedConfig,
      issues: [],
    });

    const configResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(configResponse.error).toBeUndefined();
    expect(configResponse.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileMergedKeybindings(persistedConfig),
      customKeybindings: persistedConfig,
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors(
      (configResponse.result as { availableEditors: unknown }).availableEditors,
    );
  });

  it("returns checkout conflicts as structured recovery data without a stack trace", async () => {
    const cwd = makeTempDir("f5-checkout-conflict-");
    fs.mkdirSync(path.join(cwd, ".git"));
    const checkoutConflict = { cwd, branch: "main", files: ["index.css"] };
    server = await createTestServer({
      gitCore: {
        listBranches: () => Effect.die("unused"),
        initRepo: () => Effect.die("unused"),
        pullCurrentBranch: () => Effect.die("unused"),
        checkoutBranch: () =>
          Effect.fail(
            new GitCommandError({
              cwd: checkoutConflict.cwd,
              operation: "GitCore.checkoutBranch.checkout",
              command: "git checkout main --",
              detail: "error: Your local changes would be overwritten by checkout.",
              checkoutConflict,
            }),
          ),
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.gitCheckout, {
      cwd: checkoutConflict.cwd,
      branch: "main",
    });
    expect(response.error).toEqual({
      code: "GitCheckoutConflict",
      message: `Local changes in ${checkoutConflict.cwd} would be overwritten by switching to 'main'.`,
      checkoutConflict,
    });
  });

  it("keeps checkout conflict details in ordinary failures from other Git routes", async () => {
    const checkoutConflict = { cwd: "/repo", branch: "main", files: ["index.css"] };
    server = await createTestServer({
      gitCore: {
        listBranches: () => Effect.die("unused"),
        initRepo: () => Effect.die("unused"),
        pullCurrentBranch: () =>
          Effect.fail(
            new GitCommandError({
              cwd: "/repo",
              operation: "checkout during pull",
              command: "git checkout main --",
              detail: "Local changes in index.css would be overwritten",
              checkoutConflict,
            }),
          ),
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.gitPull, { cwd: "/repo" });
    expect(response.error?.code).toBeUndefined();
    expect(response.error?.checkoutConflict).toBeUndefined();
    expect(response.error?.message).toContain("index.css");
  });

  it("returns error for unknown methods", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, "nonexistent.method");
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Invalid request format");
    // The caller's id is echoed so clients reject immediately instead of timing out.
    expect(response.id).not.toBe("unknown");
  });

  it("rejects GitHub CLI imports for invalid hosts or logins immediately", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    for (const params of [
      { host: "https://github.com", login: "octocat" },
      { host: "github.com", login: "-not-a-login" },
    ]) {
      const response = await sendRequest(ws, WS_METHODS.githubAccountCliImport, params);
      expect(response.result).toBeUndefined();
      expect(response.error?.message).toContain("Invalid request format");
      expect(response.id).not.toBe("unknown");
    }
  });

  it("recovers request ids from undecodable requests", () => {
    expect(readWebSocketRequestId(JSON.stringify({ id: "abc", body: { _tag: "x" } }))).toBe("abc");
    expect(readWebSocketRequestId(JSON.stringify({ id: 7 }))).toBeNull();
    expect(readWebSocketRequestId(JSON.stringify({ id: "x".repeat(200) }))).toBeNull();
    expect(readWebSocketRequestId("not json")).toBeNull();
    expect(readWebSocketRequestId("null")).toBeNull();
  });

  it("returns error when requesting turn diff for unknown thread", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-missing",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns error when requesting turn diff with an inverted range", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-any",
      fromTurnCount: 2,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "fromTurnCount must be less than or equal to toTurnCount",
    );
  });

  it("returns error when requesting full thread diff for unknown thread", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-missing",
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns retryable error when requested turn exceeds current checkpoint turn count", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("t3code-ws-diff-project-");
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-diff-project-create",
      projectId: "project-diff",
      title: "Diff Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-diff-thread-create",
      threadId: "thread-diff",
      projectId: "project-diff",
      title: "Diff Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-diff",
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("exceeds current turn count");
  });

  it("rejects oversized turn-start messages before dispatching orchestration events", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("t3code-ws-oversized-project-");
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-oversized-project-create",
      projectId: "project-oversized",
      title: "Oversized Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-oversized-thread-create",
      threadId: "thread-oversized",
      projectId: "project-oversized",
      title: "Oversized Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "cmd-oversized-turn-start",
      threadId: "thread-oversized",
      message: {
        messageId: "msg-oversized",
        role: "user",
        text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
        attachments: [],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("120,000 character provider input limit");
    expect(response.error?.message.length).toBeLessThan(240);

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    const thread = snapshot.threads.find((entry) => entry.id === "thread-oversized");
    expect(thread?.messages).toEqual([]);
  });

  it("rejects established-thread turn starts that bypass queue admission", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const createdAt = new Date().toISOString();
    const workspaceRoot = makeTempDir("t3code-ws-queue-admission-");
    const projectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-queue-admission-project",
      projectId: "project-queue-admission",
      title: "Queue Admission",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(projectResponse.error).toBeUndefined();
    const threadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-queue-admission-thread",
      threadId: "thread-queue-admission",
      projectId: "project-queue-admission",
      title: "Queue Admission",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(threadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "cmd-queue-admission-turn",
      dispatchSource: "next-turn-queue",
      threadId: "thread-queue-admission",
      message: {
        messageId: "message-queue-admission-turn",
        role: "user",
        text: "must go through the queue",
        attachments: [],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });

    expect(response.result).toBeUndefined();
    expect(response.error).toEqual(
      expect.objectContaining({
        code: "NextTurnQueueAdmissionRequired",
        message: expect.stringContaining("nextTurnQueue.submit"),
      }),
    );
  });

  it.each([
    ["text plus image", "Describe this image.", "text-image"],
    [
      "image-only fallback",
      "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
      "image-only",
    ],
  ])("accepts a bootstrap first turn with %s", async (_caseName, messageText, suffix) => {
    const stateDir = makeTempDir(`t3code-ws-bootstrap-attachment-${suffix}-`);
    const workspaceRoot = makeTempDir(`t3code-ws-bootstrap-attachment-workspace-${suffix}-`);
    const dbPath = path.join(stateDir, "state.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
    server = await createTestServer({
      cwd: workspaceRoot,
      persistenceLayer,
      providerLayer: Layer.succeed(ProviderService, makeTurnCapturingProviderService(sentTurns)),
      stateDir,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = `project-bootstrap-attachment-${suffix}`;
    const threadId = `thread-bootstrap-attachment-${suffix}`;
    const messageId = `message-bootstrap-attachment-${suffix}`;

    const projectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: `command-bootstrap-attachment-project-${suffix}`,
      projectId,
      title: "Bootstrap Attachment",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(projectResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: `command-bootstrap-attachment-turn-${suffix}`,
      threadId,
      message: {
        messageId,
        role: "user",
        text: messageText,
        attachments: [
          {
            type: "image",
            name: "first-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
      provider: "codex",
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId,
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    });
    expect(response.error).toBeUndefined();

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    const message = thread?.messages.find((entry) => entry.id === messageId);
    expect(message).toEqual(
      expect.objectContaining({
        text: messageText,
        attachments: [
          expect.objectContaining({
            type: "image",
            name: "first-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          }),
        ],
      }),
    );
    const attachmentId = message?.attachments?.[0]?.id;
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      throw new Error("Expected the bootstrap message attachment to have an id.");
    }
    expect(fs.existsSync(path.join(stateDir, "attachments", `${attachmentId}.png`))).toBe(true);

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT lifecycle FROM attachments WHERE attachment_id = ?")
          .get(attachmentId),
      ).toEqual({ lifecycle: "ready" });
      expect(
        database
          .prepare(
            "SELECT owner_kind AS ownerKind, owner_id AS ownerId FROM attachment_owners WHERE attachment_id = ?",
          )
          .get(attachmentId),
      ).toEqual({ ownerKind: "message", ownerId: messageId });
    } finally {
      database.close();
    }

    await vi.waitFor(() => expect(sentTurns).toHaveLength(1));
    expect(sentTurns[0]).toEqual(
      expect.objectContaining({
        threadId,
        attachments: [expect.objectContaining({ id: attachmentId, name: "first-image.png" })],
      }),
    );
  });

  // Each case starts one or two real servers and real Git worktrees, which can
  // exceed the 15 s default on loaded CI runners.
  describe("Agent Bridge", { timeout: 90_000 }, () => {
    const SLOW_WAIT = { timeout: 30_000 } as const;

    function makeBridgeRepo(): string {
      const repo = makeTempDir("f5-agent-bridge-repo-");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      git("init", "--initial-branch=main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
      git("add", ".");
      git("commit", "-m", "init");
      return repo;
    }

    async function bridgeRequest(stateDir: string, method: string, params?: unknown) {
      const credentials = JSON.parse(
        fs.readFileSync(path.join(stateDir, "agent-bridge", "local.json"), "utf8"),
      ) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${credentials.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return (await response.json()) as { result?: any; error?: { message: string } };
    }

    const callTool = async (stateDir: string, name: string, args: Record<string, unknown>) =>
      (await bridgeRequest(stateDir, "tools/call", { name, arguments: args })).result as {
        structuredContent: any;
        isError?: boolean;
      };

    const readProvenance = (dbPath: string) => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return db
          .prepare("SELECT command_id, source FROM provider_submission_provenance")
          .all() as Array<{ command_id: string; source: string }>;
      } finally {
        db.close();
      }
    };

    // #148 shelved the listener; this test re-enables itself when the flag flips.
    it.skipIf(!AGENT_BRIDGE_LISTENER_AVAILABLE)(
      "admits supervised automation turns idempotently and keeps the WS route human",
      async () => {
        const repo = makeBridgeRepo();
        const stateDir = makeTempDir("f5-agent-bridge-state-");
        const dbPath = path.join(stateDir, "state.sqlite");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        server = await createTestServer({
          cwd: repo,
          stateDir,
          persistenceLayer: makeSqlitePersistenceLive(dbPath).pipe(
            Layer.provide(NodeServices.layer),
          ),
          providerLayer: Layer.succeed(
            ProviderService,
            makeTurnCapturingProviderService(sentTurns),
          ),
        });
        const addr = server.address();
        const [ws] = await connectAndAwaitWelcome(
          typeof addr === "object" && addr !== null ? addr.port : 0,
        );
        connections.push(ws);
        const createdAt = new Date().toISOString();
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-bridge-project",
          projectId: "project-bridge",
          title: "Bridge",
          workspaceRoot: repo,
          defaultModel: "gpt-5-codex",
          createdAt,
        });
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-hidden-project",
          projectId: "project-hidden",
          title: "Hidden",
          workspaceRoot: makeTempDir("f5-agent-bridge-hidden-"),
          defaultModel: "gpt-5-codex",
          createdAt,
        });
        const credentialsPath = path.join(stateDir, "agent-bridge", "local.json");
        expect(fs.existsSync(credentialsPath)).toBe(false);
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          agentBridge: { enabled: true, exposedProjectIds: ["project-bridge"] },
        });
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(true), SLOW_WAIT);
        if (process.platform !== "win32")
          expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);

        const projects = await callTool(stateDir, "list_projects", {});
        expect(
          projects.structuredContent.projects.map((project: { id: string }) => project.id),
        ).toEqual(["project-bridge"]);
        const hidden = await callTool(stateDir, "create_thread", {
          projectId: "project-hidden",
          prompt: "No.",
        });
        expect(hidden.isError).toBe(true);
        expect(hidden.structuredContent.error).toBe("Project not found.");

        // Checkout bootstrap.
        const args = {
          projectId: "project-bridge",
          prompt: "Fix the README.",
          useWorktree: false,
          clientRequestId: "checkout-1",
        };
        const [first, concurrent] = await Promise.all([
          callTool(stateDir, "create_thread", args),
          callTool(stateDir, "create_thread", args),
        ]);
        expect(first.isError).toBeUndefined();
        expect(concurrent.structuredContent).toEqual(first.structuredContent);
        const { threadId, submissionId } = first.structuredContent;
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
        expect(sentTurns[0]?.submissionSource).toBe("automation");
        const retry = await callTool(stateDir, "create_thread", args);
        expect(retry.structuredContent).toEqual(first.structuredContent);
        const conflict = await callTool(stateDir, "create_thread", { ...args, prompt: "Other." });
        expect(conflict.isError).toBe(true);

        let snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const created = snapshot.threads.find((thread) => thread.id === threadId);
        expect(created?.runtimeMode).toBe("approval-required");
        await vi.waitFor(async () => {
          snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
            .result as OrchestrationReadModel;
          expect(
            snapshot.threads
              .find((thread) => thread.id === threadId)
              ?.activities.filter((activity) => activity.kind === "agent-bridge.turn-submitted"),
          ).toHaveLength(1);
        }, SLOW_WAIT);

        // Worktree bootstrap.
        const worktree = await callTool(stateDir, "create_thread", {
          projectId: "project-bridge",
          prompt: "Work in a worktree.",
        });
        expect(worktree.structuredContent.disposition).toBe("queued");
        await vi.waitFor(() => expect(sentTurns).toHaveLength(2), SLOW_WAIT);
        expect(sentTurns[1]?.submissionSource).toBe("automation");

        // Existing-thread queueing; the first turn never settles, so it waits.
        const queued = await callTool(stateDir, "send_message", {
          threadId,
          prompt: "Also update the docs.",
        });
        expect(queued.structuredContent.disposition).toBe("queued");
        const waited = await callTool(stateDir, "wait_for_submission", {
          submissionId: queued.structuredContent.submissionId,
          timeoutSeconds: 0,
        });
        expect(waited.structuredContent).toMatchObject({ status: "queued", timedOut: true });

        // A human send on the WS route.
        await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
          submissionId: "human-submission",
          intent: "queue-tail",
          command: {
            type: "thread.turn.start",
            commandId: "human-submission",
            threadId,
            message: { messageId: "human-message", role: "user", text: "Me.", attachments: [] },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });

        const provenance = new Map(
          readProvenance(dbPath).map((row) => [row.command_id, row.source] as const),
        );
        expect(provenance.get(submissionId)).toBe("automation");
        expect(provenance.get(worktree.structuredContent.submissionId)).toBe("automation");
        expect(provenance.get(queued.structuredContent.submissionId)).toBe("automation");
        expect(provenance.get("human-submission")).toBe("human");

        // Supervision: a full-access thread refuses bridge messages.
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.runtime-mode.set",
          commandId: "command-bridge-full-access",
          threadId,
          runtimeMode: "full-access",
          createdAt: new Date().toISOString(),
        });
        await vi.waitFor(async () => {
          const refused = await callTool(stateDir, "send_message", { threadId, prompt: "Again." });
          expect(refused.structuredContent.error).toContain("not supervised");
        }, SLOW_WAIT);

        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          agentBridge: { enabled: false },
        });
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(false), SLOW_WAIT);
      },
    );

    /** One tools/call through the STDIO shim, as a generic MCP client would. */
    async function shimCall(stateDir: string, name: string, args: Record<string, unknown>) {
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
      const done = runAgentBridgeStdio({
        credentialsPath: path.join(stateDir, "agent-bridge", "local.json"),
        input,
        output,
        env: {},
      });
      const messages = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      ];
      for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
      input.end();
      await done;
      const replies = chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { id?: number; result?: any });
      return replies.find((reply) => reply.id === 2)?.result as {
        structuredContent: any;
        isError?: boolean;
      };
    }

    // #148 shelved the listener; this test re-enables itself when the flag flips.
    it.skipIf(!AGENT_BRIDGE_LISTENER_AVAILABLE)(
      "runs a task lifecycle through the STDIO shim across a restart",
      async () => {
        const repo = makeBridgeRepo();
        const stateDir = makeTempDir("f5-agent-bridge-tasks-");
        const dbPath = path.join(stateDir, "state.sqlite");
        const start = async () => {
          server = await createTestServer({
            cwd: repo,
            stateDir,
            persistenceLayer: makeSqlitePersistenceLive(dbPath).pipe(
              Layer.provide(NodeServices.layer),
            ),
          });
          const addr = server.address();
          const [ws] = await connectAndAwaitWelcome(
            typeof addr === "object" && addr !== null ? addr.port : 0,
          );
          connections.push(ws);
          return ws;
        };
        let ws = await start();
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-task-project",
          projectId: "project-tasks",
          title: "Tasks",
          workspaceRoot: repo,
          defaultModel: "gpt-5-codex",
          createdAt: new Date().toISOString(),
        });
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          agentBridge: { enabled: true, exposedProjectIds: ["project-tasks"] },
        });
        const credentialsPath = path.join(stateDir, "agent-bridge", "local.json");
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(true), SLOW_WAIT);

        const created = await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.createTask, {
          operationId: "create-1",
          clientId: "local",
          projectId: "project-tasks",
          title: "Summarize",
          instructions: "Summarize the README.",
        });
        const taskId = (created.result as { id: string }).id;
        const listed = await shimCall(stateDir, "list_tasks", {});
        expect(
          listed.structuredContent.tasks.map((task: { taskId: string }) => task.taskId),
        ).toEqual([taskId]);
        const claimed = await shimCall(stateDir, "claim_task", { taskId, operationId: "claim-1" });
        const epoch = claimed.structuredContent.executionEpoch as number;
        expect(
          (
            await shimCall(stateDir, "report_task_progress", {
              taskId,
              executionEpoch: epoch,
              operationId: "progress-1",
              summary: "Reading",
            })
          ).isError,
        ).toBeUndefined();
        const asked = await shimCall(stateDir, "request_task_input", {
          taskId,
          executionEpoch: epoch,
          operationId: "question-1",
          question: "Short or long?",
        });
        const questionId = asked.structuredContent.questionId as string;

        // Restart: the task board and the revision survive.
        const revisionBefore = (
          (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTasks, {})).result as {
            revision: number;
          }
        ).revision;
        for (const socket of connections.splice(0)) socket.close();
        await closeTestServer();
        ws = await start();
        await vi.waitFor(() => expect(fs.existsSync(credentialsPath)).toBe(true), SLOW_WAIT);
        const afterRestart = (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTasks, {}))
          .result as {
          revision: number;
          tasks: Array<{ id: string; status: string; version: number }>;
        };
        expect(afterRestart.revision).toBe(revisionBefore);
        const waiting = afterRestart.tasks.find((task) => task.id === taskId);
        expect(waiting?.status).toBe("waiting-for-user");

        await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.replyToTask, {
          operationId: "reply-1",
          taskId,
          questionId,
          expectedVersion: waiting?.version,
          text: "Short.",
        });
        const read = await shimCall(stateDir, "get_task", { taskId });
        expect(read.structuredContent.status).toBe("running");
        expect(
          read.structuredContent.history.find((entry: { type: string }) => entry.type === "reply")
            ?.content,
        ).toBe("Short.");
        const completed = await shimCall(stateDir, "complete_task", {
          taskId,
          executionEpoch: epoch,
          operationId: "complete-1",
          result: "It says hello.",
        });
        expect(completed.isError).toBeUndefined();
        const final = (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTask, { taskId }))
          .result as {
          status: string;
          result: string;
        };
        expect(final).toMatchObject({ status: "completed", result: "It says hello." });
        const activities = (
          (await sendRequest(ws, AGENT_BRIDGE_WS_METHODS.getTaskActivities, { taskId })).result as {
            activities: Array<{ type: string }>;
          }
        ).activities.map((activity) => activity.type);
        expect(activities).toEqual([
          "completed",
          "reply",
          "question",
          "progress",
          "claimed",
          "created",
        ]);
      },
    );
  });

  describe("first sends through nextTurnQueue.submit", { timeout: 90_000 }, () => {
    /** How long to wait for background setup or a turn on a slow runner. */
    const SLOW_WAIT = { timeout: 30_000 } as const;
    function nodeSetupCommand(script: string): string {
      return `"${process.execPath}" -e "${script}"`;
    }

    function makeGitRepo(prefix: string): string {
      const repo = makeTempDir(prefix);
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
      git("init", "--initial-branch=main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
      git("add", ".");
      git("commit", "-m", "init");
      return repo;
    }

    class RecordingTerminalManager extends MockTerminalManager {
      readonly opened: Array<{ terminalId: string; cwd: string }> = [];
      constructor() {
        super();
        const baseOpen = this.open;
        (this as { open: TerminalManagerShape["open"] }).open = (input) => {
          this.opened.push({ terminalId: input.terminalId ?? "default", cwd: input.cwd });
          return baseOpen(input);
        };
      }
    }

    type Variant = {
      readonly name: string;
      readonly worktree: boolean;
      readonly setupScript: boolean;
    };
    const variants: ReadonlyArray<Variant> = [
      { name: "create-thread only", worktree: false, setupScript: false },
      {
        name: "create-thread with a setup script but no worktree",
        worktree: false,
        setupScript: true,
      },
      { name: "create-thread and prepare-worktree", worktree: true, setupScript: false },
      {
        name: "create-thread, prepare-worktree and run-setup-script",
        worktree: true,
        setupScript: true,
      },
    ];

    async function readSetup(ws: WebSocket, threadId: string) {
      return (
        (await sendRequest(ws, WS_METHODS.worktreeSetupSubscribe, { threadId })).result as {
          snapshot: WorktreeSetupSnapshot | null;
        }
      ).snapshot;
    }

    async function sendSetupAction(ws: WebSocket, method: string, input: { threadId: string }) {
      const snapshot = await readSetup(ws, input.threadId);
      return sendRequest(ws, method, {
        ...input,
        expectedOperationId: snapshot?.operationId ?? "missing",
      });
    }

    async function waitForSetup(
      ws: WebSocket,
      threadId: string,
      predicate: (snapshot: WorktreeSetupSnapshot | null) => boolean,
      timeoutMs = SLOW_WAIT.timeout,
    ): Promise<WorktreeSetupSnapshot | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const snapshot = await readSetup(ws, threadId);
        if (predicate(snapshot)) return snapshot;
        if (Date.now() > deadline) {
          throw new Error(`Worktree setup did not settle: ${JSON.stringify(snapshot)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    async function runFirstSend(route: "dispatch" | "submit", variant: Variant) {
      const stateDir = makeTempDir(`t3code-ws-first-send-${route}-`);
      const repo = makeGitRepo(`t3code-ws-first-send-repo-${route}-`);
      const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      const terminalManager = new RecordingTerminalManager();
      server = await createTestServer({
        cwd: repo,
        stateDir,
        providerLayer: Layer.succeed(ProviderService, makeTurnCapturingProviderService(sentTurns)),
        terminalManager,
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const createdAt = "2026-10-01T00:00:00.000Z";
      const projectId = "project-first-send";
      const threadId = "thread-first-send";
      expect(
        (
          await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
            type: "project.create",
            commandId: "command-first-send-project",
            projectId,
            title: "First send",
            workspaceRoot: repo,
            defaultModel: "gpt-5-codex",
            createdAt,
          })
        ).error,
      ).toBeUndefined();
      if (variant.setupScript) {
        expect(
          (
            await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
              type: "project.meta.update",
              commandId: "command-first-send-scripts",
              projectId,
              scripts: [
                {
                  id: "setup",
                  name: "Setup",
                  command: "echo setup",
                  icon: "play",
                  runOnWorktreeCreate: true,
                },
              ],
            })
          ).error,
        ).toBeUndefined();
      }
      const command = {
        type: "thread.turn.start",
        commandId: "command-first-send-turn",
        threadId,
        message: {
          messageId: "message-first-send",
          role: "user",
          text: "Start here.",
          attachments: [],
        },
        provider: "codex",
        assistantDeliveryMode: "streaming",
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title: "New thread",
            model: "gpt-5-codex",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: variant.worktree ? null : "main",
            worktreePath: null,
            createdAt,
          },
          ...(variant.worktree
            ? { prepareWorktree: { projectCwd: repo, baseBranch: "main", branch: "f5/first-send" } }
            : {}),
          ...(variant.setupScript ? { runSetupScript: true } : {}),
        },
        createdAt,
      };
      const response =
        route === "dispatch"
          ? await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, command)
          : await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
              submissionId: "command-first-send-turn",
              command,
              intent: "auto",
            });
      expect(response.error).toBeUndefined();
      await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
        .result as OrchestrationReadModel;
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const relative = (value: string | null | undefined) => {
        if (value == null) return null;
        // Resolve short Windows temp paths and separators before comparing routes.
        const canonicalValue = fs.realpathSync.native(value);
        const canonicalWorktreesDir = path.join(
          fs.realpathSync.native(path.dirname(stateDir)),
          "worktrees",
        );
        const relativePath = path.relative(canonicalWorktreesDir, canonicalValue);
        return relativePath !== "" &&
          relativePath !== ".." &&
          !relativePath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativePath)
          ? `<worktrees>/<repo>/${path.basename(canonicalValue)}`
          : canonicalValue === fs.realpathSync.native(repo)
            ? "<repo>"
            : value;
      };
      const outcome = {
        // The title is left out: it is renamed later by title generation, whose
        // timing depends on the environment and not on the bootstrap route.
        branch: thread?.branch,
        worktreePath: relative(thread?.worktreePath),
        worktreeExists: thread?.worktreePath ? fs.existsSync(thread.worktreePath) : null,
        messages: thread?.messages.map((message) => ({ role: message.role, text: message.text })),
        terminals: terminalManager.opened.map((entry) => ({
          terminalId: entry.terminalId,
          cwd: relative(entry.cwd),
        })),
        sentTurnThread: sentTurns[0]?.threadId,
      };
      const setup = await waitForSetup(ws, threadId, (snapshot) => snapshot?.phase !== "running");
      for (const ws of connections.splice(0)) ws.close();
      await closeTestServer();
      server = null;
      return { outcome, result: response.result, setup };
    }

    it.each([false, true])(
      "scheduled first sends persist identities across restart (worktree=%s)",
      async (worktree) => {
        const stateDir = makeTempDir("f5-scheduled-submission-");
        const repo = makeGitRepo("f5-scheduled-submission-repo-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const accepted = Promise.withResolvers<void>();
        const capture = makeTurnCapturingProviderService(sentTurns);
        const start = async () => {
          server = await createTestServer({
            cwd: repo,
            stateDir,
            persistenceLayer: makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
              Layer.provide(NodeServices.layer),
            ),
            providerLayer: Layer.succeed(ProviderService, {
              ...capture,
              sendTurn: (input) =>
                capture
                  .sendTurn(input)
                  .pipe(Effect.tap(() => Effect.sync(() => accepted.resolve()))),
            }),
          });
          const address = server.address();
          const [ws] = await connectAndAwaitWelcome(
            typeof address === "object" && address ? address.port : 0,
          );
          connections.push(ws);
          return ws;
        };
        let ws = await start();
        const requestedAt = new Date().toISOString();
        expect(
          (
            await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId: "scheduled-project",
              title: "Scheduled",
              workspaceRoot: repo,
              defaultModel: "gpt-5-codex",
              createdAt: requestedAt,
            })
          ).error,
        ).toBeUndefined();
        const definition = {
          id: crypto.randomUUID(),
          projectId: "scheduled-project",
          requestedAt,
          configuration: {
            name: "Scheduled integration",
            prompt: "One durable scheduled send.",
            modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            workspace: worktree
              ? { kind: "worktree", baseBranch: "main" }
              : { kind: "projectRoot" },
            cron: "* * * * *",
            timezone: "UTC",
            scheduleSource: "cron",
            maxRuns: 1,
            oneShotAt: null,
            notify: "none",
            enabled: true,
          },
        };
        expect(
          (await sendRequest(ws, WS_METHODS.scheduledTasksCreate, definition)).error,
        ).toBeUndefined();
        const fire = { taskId: definition.id, runId: crypto.randomUUID(), requestedAt };
        expect(
          (await sendRequest(ws, WS_METHODS.scheduledTasksRunNow, fire)).error,
        ).toBeUndefined();
        await accepted.promise;
        expect(sentTurns).toHaveLength(1);
        const threadId = sentTurns[0]!.threadId;
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const thread = snapshot.threads.find((thread) => thread.id === threadId)!;
        expect(thread.scheduledOrigin).toEqual({ taskId: definition.id, runId: fire.runId });
        expect(Boolean(thread.worktreePath)).toBe(worktree);
        if (thread.worktreePath) expect(fs.existsSync(thread.worktreePath)).toBe(true);
        for (const connection of connections.splice(0)) connection.close();
        await closeTestServer();
        server = null;
        ws = await start();
        const replay = await sendRequest(ws, WS_METHODS.scheduledTasksRunNow, fire);
        expect(replay.error).toBeUndefined();
        expect(replay.result).toEqual(expect.objectContaining({ id: fire.runId, threadId }));
        const reopened = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(
          reopened.threads.filter((thread) => thread.scheduledOrigin?.runId === fire.runId),
        ).toHaveLength(1);
        expect(sentTurns).toHaveLength(1);
        expect(
          (await sendRequest(ws, WS_METHODS.scheduledTasksCreate, definition)).error,
        ).toBeUndefined();
        const tasks = (await sendRequest(ws, WS_METHODS.scheduledTasksList, {})).result as {
          tasks: Array<{ task: { runsConsumed: number; enabled: boolean } }>;
        };
        expect(tasks.tasks[0]!.task.runsConsumed).toBe(1);
        expect(tasks.tasks[0]!.task.enabled).toBe(false);
      },
    );

    it.each(variants)("matches the direct dispatch route for $name", async (variant) => {
      const direct = await runFirstSend("dispatch", variant);
      const queued = await runFirstSend("submit", variant);
      // Worktree setup runs the script as an owned process instead of a terminal.
      expect({ ...queued.outcome, terminals: [] }).toEqual({ ...direct.outcome, terminals: [] });
      expect(direct.outcome.worktreeExists).toBe(variant.worktree ? true : null);
      expect(direct.outcome.terminals).toHaveLength(0);
      expect(queued.outcome.terminals).toHaveLength(0);
      if (variant.worktree) {
        // A worktree first send is queued behind its background setup.
        expect(queued.result).toEqual(
          expect.objectContaining({
            disposition: "queued",
            submissionId: "command-first-send-turn",
          }),
        );
        await vi.waitFor(() => expect(queued.setup).not.toBeNull(), SLOW_WAIT);
        expect(queued.setup?.stages.find((stage) => stage.id === "setup-script")?.status).toBe(
          variant.setupScript ? "done" : "skipped",
        );
      } else {
        expect(queued.result).toEqual(
          expect.objectContaining({
            disposition: "started",
            submissionId: "command-first-send-turn",
            sequence: expect.any(Number),
          }),
        );
        expect(queued.setup).toBeNull();
      }
    });

    it("replays a resubmitted first send instead of creating the thread twice", async () => {
      const stateDir = makeTempDir("t3code-ws-first-send-replay-");
      const repo = makeGitRepo("t3code-ws-first-send-replay-repo-");
      const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
      server = await createTestServer({
        cwd: repo,
        stateDir,
        providerLayer: Layer.succeed(ProviderService, makeTurnCapturingProviderService(sentTurns)),
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const createdAt = new Date().toISOString();
      await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
        type: "project.create",
        commandId: "command-replay-project",
        projectId: "project-replay",
        title: "Replay",
        workspaceRoot: repo,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
      const submit = {
        submissionId: "submission-replay",
        intent: "auto",
        command: {
          type: "thread.turn.start",
          commandId: "submission-replay",
          threadId: "thread-replay",
          message: { messageId: "message-replay", role: "user", text: "Once.", attachments: [] },
          provider: "codex",
          assistantDeliveryMode: "streaming",
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: "project-replay",
              title: "New thread",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      };
      // Two sockets: the test helper reads one response stream per socket.
      const [otherWs] = await connectAndAwaitWelcome(port);
      connections.push(otherWs);
      const [first, second] = await Promise.all([
        sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, submit),
        sendRequest(otherWs, WS_METHODS.nextTurnQueueSubmit, submit),
      ]);
      const third = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, submit);
      expect(first.error).toBeUndefined();
      expect(second.result).toEqual(first.result);
      expect(third.result).toEqual(first.result);
      await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
        .result as OrchestrationReadModel;
      expect(snapshot.threads.filter((entry) => entry.id === "thread-replay")).toHaveLength(1);
      expect(snapshot.threads.find((entry) => entry.id === "thread-replay")?.messages).toHaveLength(
        1,
      );
    });

    describe("background worktree setup", () => {
      function addOriginRemote(repo: string): void {
        const bare = makeTempDir("t3code-ws-setup-origin-");
        execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "pipe" });
        execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo, stdio: "pipe" });
        execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "pipe" });
      }

      async function startServer(options: {
        readonly repo: string;
        readonly stateDir?: string;
        readonly persistenceLayer?: Parameters<typeof createTestServer>[0] extends infer O
          ? O extends { persistenceLayer?: infer P }
            ? P
            : never
          : never;
        readonly sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]>;
        readonly generateBranchName?: ProviderInstance["textGeneration"]["generateBranchName"];
      }) {
        server = await createTestServer({
          cwd: options.repo,
          ...(options.stateDir ? { stateDir: options.stateDir } : {}),
          ...(options.persistenceLayer ? { persistenceLayer: options.persistenceLayer } : {}),
          providerLayer: Layer.succeed(
            ProviderService,
            makeTurnCapturingProviderService(options.sentTurns),
          ),
          ...(options.generateBranchName
            ? {
                providerInstanceRegistryLayer: Layer.succeed(ProviderInstanceRegistry, {
                  getInstance: () =>
                    Effect.succeed({
                      instanceId: ProviderInstanceId.make("codex"),
                      enabled: true,
                      driverKind: ProviderDriverKind.make("codex"),
                      continuationIdentity: {
                        driverKind: ProviderDriverKind.make("codex"),
                        continuationKey: "codex",
                      },
                      displayName: undefined,
                      snapshot: {
                        getSnapshot: Effect.succeed(defaultProviderSnapshots[0]!),
                        refresh: Effect.succeed(defaultProviderSnapshots[0]!),
                        streamChanges: Stream.empty,
                      },
                      adapter: {} as ProviderInstance["adapter"],
                      textGeneration: {
                        generateBranchName: options.generateBranchName!,
                        generateCommitMessage: () => Effect.die("unused commit generation"),
                        generatePrContent: () => Effect.die("unused PR generation"),
                        generateStructuredJson: () => Effect.die("unused structured generation"),
                        generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
                      },
                    } as ProviderInstance),
                  listInstances: Effect.succeed([]),
                  listUnavailable: Effect.succeed([]),
                  streamChanges: Stream.empty,
                  subscribeChanges: Effect.acquireRelease(
                    PubSub.unbounded<void>(),
                    PubSub.shutdown,
                  ).pipe(Effect.flatMap(PubSub.subscribe)),
                }),
              }
            : {}),
        });
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        const [ws] = await connectAndAwaitWelcome(port);
        connections.push(ws);
        return ws;
      }

      async function createProject(
        ws: WebSocket,
        repo: string,
        script?: { readonly command: string; readonly async?: boolean },
      ) {
        const createdAt = new Date().toISOString();
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: `command-setup-project-${crypto.randomUUID()}`,
          projectId: "project-setup",
          title: "Setup",
          workspaceRoot: repo,
          defaultModel: "gpt-5-codex",
          createdAt,
        });
        if (script) {
          await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
            type: "project.meta.update",
            commandId: `command-setup-scripts-${crypto.randomUUID()}`,
            projectId: "project-setup",
            scripts: [
              {
                id: "setup",
                name: "Setup",
                command: script.command,
                icon: "play",
                runOnWorktreeCreate: true,
                ...(script.async === undefined ? {} : { async: script.async }),
              },
            ],
          });
        }
      }

      function firstSend(input: {
        readonly repo: string;
        readonly threadId: string;
        readonly baseBranch?: string;
        readonly requireWorktree?: boolean;
      }) {
        const createdAt = new Date().toISOString();
        return {
          submissionId: `submission-${input.threadId}`,
          intent: "auto",
          command: {
            type: "thread.turn.start",
            commandId: `submission-${input.threadId}`,
            threadId: input.threadId,
            message: {
              messageId: `message-${input.threadId}`,
              role: "user",
              text: "Build it.",
              attachments: [],
            },
            provider: "codex",
            assistantDeliveryMode: "streaming",
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: "project-setup",
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: input.repo,
                baseBranch: input.baseBranch ?? "main",
                branch: `f5/${input.threadId}`,
                ...(input.requireWorktree ? { requireWorktree: true } : {}),
              },
              runSetupScript: true,
            },
            createdAt,
          },
        };
      }

      const branchExists = (repo: string, branch: string) => {
        try {
          execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
            cwd: repo,
            stdio: "pipe",
          });
          return true;
        } catch {
          return false;
        }
      };

      it("rejects a required worktree before creating the thread", async () => {
        const repo = makeTempDir("t3code-ws-setup-required-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        const response = await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-required", requireWorktree: true }),
        );
        expect(response.error).toEqual(
          expect.objectContaining({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE }),
        );
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(snapshot.threads.some((entry) => entry.id === "thread-required")).toBe(false);
      });

      it.each([false, true])(
        "names before handoff and keeps the matching checkout path (late: %s)",
        async (late) => {
          const repo = makeGitRepo("f5-ws-generated-name-");
          const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
          const generateBranchName = vi.fn(() =>
            Effect.sleep(late ? "3100 millis" : "1 millis").pipe(
              Effect.as({ branch: "generated-worktree" }),
            ),
          );
          const ws = await startServer({ repo, sentTurns, generateBranchName });
          await createProject(
            ws,
            repo,
            late
              ? { command: nodeSetupCommand("setTimeout(() => {}, 1000)"), async: false }
              : undefined,
          );
          const base = firstSend({ repo, threadId: "generated-name" });
          const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch: "t3code/11223344",
                },
              },
            },
          });
          expect(response.error).toBeUndefined();
          const done = await waitForSetup(
            ws,
            "generated-name",
            (snapshot) => snapshot?.phase === "done",
          );
          expect(done?.request.branch).toBe("f5/generated-worktree");
          expect(path.basename(done!.worktreePath!)).toMatch(
            late ? /^t3code-11223344-/ : /^f5-generated-worktree-/,
          );
          expect(
            execFileSync("git", ["branch", "--show-current"], {
              cwd: done!.worktreePath!,
              encoding: "utf8",
            }).trim(),
          ).toBe("f5/generated-worktree");
          await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
          expect(generateBranchName).toHaveBeenCalledTimes(1);
        },
      );
      it("serializes identical late generated names across separate checkout paths", async () => {
        const repo = makeGitRepo("f5-ws-late-fanout-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({
          repo,
          sentTurns,
          generateBranchName: () =>
            Effect.sleep("3100 millis").pipe(Effect.as({ branch: "shared-title" })),
        });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 1000)"),
          async: false,
        });
        const address = server!.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const [secondClient] = await connectAndAwaitWelcome(port);
        connections.push(secondClient);
        const requests = ["late-one", "late-two"].map((threadId, index) => {
          const base = firstSend({ repo, threadId });
          return {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch: `t3code/1234aa1${index}`,
                },
              },
            },
          };
        });
        for (const result of await Promise.all([
          sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, requests[0]),
          sendRequest(secondClient, WS_METHODS.nextTurnQueueSubmit, requests[1]),
        ]))
          expect(result.error).toBeUndefined();
        const snapshots = [];
        for (const threadId of ["late-one", "late-two"])
          snapshots.push(
            await waitForSetup(ws, threadId, (snapshot) => snapshot?.phase === "done"),
          );
        expect(new Set(snapshots.map((snapshot) => snapshot?.request.branch)).size).toBe(2);
        expect(
          snapshots.every((snapshot) => snapshot?.request.branch.startsWith("f5/shared-title")),
        ).toBe(true);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(2), SLOW_WAIT);
      });
      it("interrupts unfinished naming before the agent starts", async () => {
        const repo = makeGitRepo("f5-ws-naming-timeout-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        let interrupted = false;
        const generateBranchName = vi.fn(() =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        );
        const ws = await startServer({ repo, sentTurns, generateBranchName });
        await createProject(ws, repo);
        const base = firstSend({ repo, threadId: "naming-timeout" });
        await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
          ...base,
          command: {
            ...base.command,
            bootstrap: {
              ...base.command.bootstrap,
              prepareWorktree: {
                ...base.command.bootstrap.prepareWorktree,
                branch: "t3code/99887766",
              },
            },
          },
        });
        const done = await waitForSetup(
          ws,
          "naming-timeout",
          (snapshot) => snapshot?.phase === "done",
        );
        expect(done?.request.branch).toBe("t3code/99887766");
        expect(interrupted).toBe(true);
        expect(generateBranchName).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      });
      it.each(["invalid name", "t3code/ABCDEF12", "main"])(
        "rejects explicit branch %s before creating a conversation",
        async (branch) => {
          const repo = makeGitRepo("f5-ws-explicit-name-");
          const ws = await startServer({ repo, sentTurns: [] });
          await createProject(ws, repo);
          const base = firstSend({ repo, threadId: "invalid-branch" });
          const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch,
                  namingIntent: "explicit",
                },
              },
            },
          });
          expect(response.error).toMatchObject({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE });
          expect(response.error?.message).toMatch(/Invalid branch name|already exists/);
          const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
            .result as OrchestrationReadModel;
          expect(snapshot.threads.some((thread) => thread.id === "invalid-branch")).toBe(false);
        },
      );

      it("reserves an explicit branch before admitting competing conversations", async () => {
        const repo = makeGitRepo("f5-ws-name-reservation-");
        const ws = await startServer({ repo, sentTurns: [] });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 30000)"),
          async: false,
        });
        const requests = ["reservation-one", "reservation-two"].map((threadId) => {
          const base = firstSend({ repo, threadId });
          return {
            ...base,
            command: {
              ...base.command,
              bootstrap: {
                ...base.command.bootstrap,
                prepareWorktree: {
                  ...base.command.bootstrap.prepareWorktree,
                  branch: "f5/reserved-name",
                  namingIntent: "explicit",
                },
              },
            },
          };
        });
        const address = server!.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const [secondClient] = await connectAndAwaitWelcome(port);
        connections.push(secondClient);
        const results = await Promise.all([
          sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, requests[0]),
          sendRequest(secondClient, WS_METHODS.nextTurnQueueSubmit, requests[1]),
        ]);
        expect(results.filter((result) => result.error === undefined)).toHaveLength(1);
        expect(results.find((result) => result.error)?.error?.code).toBe(
          BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
        );
        const model = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(model.threads.filter((thread) => thread.id.startsWith("reservation-"))).toHaveLength(
          1,
        );
      });
      it("honors an explicit setup skip even when the project opts in", async () => {
        const repo = makeGitRepo("f5-ws-skip-setup-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, { command: "echo ran > setup-was-run", async: false });
        const base = firstSend({ repo, threadId: "skip-setup" });
        const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
          ...base,
          command: {
            ...base.command,
            bootstrap: {
              ...base.command.bootstrap,
              prepareWorktree: { ...base.command.bootstrap.prepareWorktree, runSetupScript: false },
            },
          },
        });
        expect(response.error).toBeUndefined();
        const done = await waitForSetup(ws, "skip-setup", (snapshot) => snapshot?.phase === "done");
        expect(done?.stages.find((stage) => stage.id === "setup-script")?.status).toBe("skipped");
        expect(fs.existsSync(path.join(done!.worktreePath!, "setup-was-run"))).toBe(false);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      });

      it.each([undefined, true, false])(
        "honors Agent waits for the first send (async: %s)",
        async (async) => {
          const repo = makeGitRepo("f5-ws-async-setup-");
          const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
          const ws = await startServer({ repo, sentTurns });
          await createProject(ws, repo, {
            command: nodeSetupCommand("console.log('setup-started'); setTimeout(() => {}, 30000)"),
            ...(async === undefined ? {} : { async }),
          });
          const threadId = "async-setup";
          expect(
            (await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, firstSend({ repo, threadId })))
              .error,
          ).toBeUndefined();
          await waitForSetup(
            ws,
            threadId,
            (snapshot) =>
              snapshot?.stages
                .find((stage) => stage.id === "setup-script")
                ?.tail.includes("setup-started") === true,
          );
          if (async === false) {
            expect(sentTurns).toHaveLength(0);
            await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, { threadId });
          } else {
            await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
            const snapshot = await readSetup(ws, threadId);
            expect(snapshot?.setupScript?.async).toBe(true);
            expect(snapshot?.stages.find((stage) => stage.id === "setup-script")?.status).toBe(
              "running",
            );
          }
        },
      );

      it("reports a failed script and still starts the queued turn once", async () => {
        const repo = makeGitRepo("f5-ws-script-failed-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, { command: "exit 2", async: false });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "script-failed" }),
        );
        const done = await waitForSetup(
          ws,
          "script-failed",
          (snapshot) => snapshot?.phase === "done",
        );
        expect(done?.stages.find((stage) => stage.id === "setup-script")?.status).toBe("failed");
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
      });
      it("pauses the queue when setup fails, then runs the turn in the project checkout", async () => {
        const repo = makeGitRepo("t3code-ws-setup-fail-");
        addOriginRemote(repo);
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        const response = await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-fail", baseBranch: "missing-base" }),
        );
        expect(response.result).toEqual(expect.objectContaining({ disposition: "queued" }));
        const failed = await waitForSetup(ws, "thread-fail", (entry) => entry?.phase === "failed");
        expect(failed?.error).toContain("missing-base");
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-fail" })
        ).result as { readonly paused: boolean; readonly reasonCode: string | null };
        expect(queue).toEqual(
          expect.objectContaining({ paused: true, reasonCode: "worktree_setup_failed" }),
        );
        expect(sentTurns).toHaveLength(0);

        const local = await sendSetupAction(ws, WS_METHODS.worktreeSetupWorkLocally, {
          threadId: "thread-fail",
        });
        expect(local.error).toBeUndefined();
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        expect(
          snapshot.threads.find((entry) => entry.id === "thread-fail")?.worktreePath,
        ).toBeNull();
      });

      it("retries a failed setup and starts the turn once the worktree is ready", async () => {
        const repo = makeGitRepo("t3code-ws-setup-retry-");
        addOriginRemote(repo);
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-retry", baseBranch: "later" }),
        );
        const previous = await waitForSetup(
          ws,
          "thread-retry",
          (entry) => entry?.phase === "failed",
        );
        execFileSync("git", ["branch", "later"], { cwd: repo, stdio: "pipe" });

        const retried = await sendSetupAction(ws, WS_METHODS.worktreeSetupRetry, {
          threadId: "thread-retry",
        });
        expect(retried.error).toBeUndefined();
        const done = await waitForSetup(ws, "thread-retry", (entry) => entry?.phase === "done");
        expect(done?.agentStarted).toBe(true);
        expect(done!.generation).toBeGreaterThan(previous!.generation);
        const obsolete = await sendRequest(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-retry",
          expectedOperationId: previous!.operationId,
        });
        expect(obsolete.error?.message).toContain("obsolete");
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);
        expect(sentTurns[0]?.threadId).toBe("thread-retry");
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const thread = snapshot.threads.find((entry) => entry.id === "thread-retry");
        expect(thread?.worktreePath).toBe(done?.worktreePath);
        expect(thread?.branch).toBe("f5/thread-retry");
      });

      it("refuses to discard or work locally once the agent started in the worktree", async () => {
        const repo = makeGitRepo("t3code-ws-setup-started-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-started" }),
        );
        const done = await waitForSetup(ws, "thread-started", (entry) => entry?.phase === "done");
        expect(done?.agentStarted).toBe(true);
        await vi.waitFor(() => expect(sentTurns).toHaveLength(1), SLOW_WAIT);

        // The tree is clean, so only the agent-started guard keeps it.
        const discarded = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-started",
        });
        expect(discarded.error?.message).toContain("agent already started");
        const local = await sendSetupAction(ws, WS_METHODS.worktreeSetupWorkLocally, {
          threadId: "thread-started",
        });
        expect(local.error?.message).toContain("agent already started");
        expect(fs.existsSync(done!.worktreePath!)).toBe(true);
        expect(branchExists(repo, "f5/thread-started")).toBe(true);
      });

      it("fans one prompt out to three models in three separate worktrees", async () => {
        const repo = makeGitRepo("t3code-ws-setup-fanout-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo);
        const threadIds = ["thread-fan-a", "thread-fan-b", "thread-fan-c"];
        const responses = await Promise.all(
          threadIds.map(async (threadId) => {
            const [socket] = await connectAndAwaitWelcome(
              (server!.address() as { port: number }).port,
            );
            connections.push(socket);
            return sendRequest(
              socket,
              WS_METHODS.nextTurnQueueSubmit,
              firstSend({ repo, threadId, requireWorktree: true }),
            );
          }),
        );
        for (const response of responses) {
          expect(response.result).toEqual(expect.objectContaining({ disposition: "queued" }));
        }
        await vi.waitFor(() => expect(sentTurns).toHaveLength(3), SLOW_WAIT);
        const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
          .result as OrchestrationReadModel;
        const worktrees = threadIds.map(
          (threadId) => snapshot.threads.find((entry) => entry.id === threadId)?.worktreePath,
        );
        expect(new Set(worktrees).size).toBe(3);
        for (const worktree of worktrees) expect(worktree && fs.existsSync(worktree)).toBe(true);
      });

      it("rejects manual removal from an unknown project cwd", async () => {
        const repo = makeGitRepo("t3code-ws-removal-project-");
        const ws = await startServer({ repo, sentTurns: [] });
        await createProject(ws, repo);
        const result = await sendRequest(ws, WS_METHODS.gitRemoveWorktree, {
          cwd: path.join(repo, "unknown"),
          path: path.join(repo, "untouched"),
        });
        expect(result.error?.message).toBe("Unknown project");
      });

      it("cancel mid-setup removes the clean worktree and the branch it created", async () => {
        const repo = makeGitRepo("t3code-ws-setup-cancel-clean-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 30000)"),
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-cancel-clean" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-cancel-clean",
          (entry) =>
            entry?.stages.find((stage) => stage.id === "setup-script")?.status === "running",
        );
        const worktreePath = running?.worktreePath;
        expect(worktreePath && fs.existsSync(worktreePath)).toBe(true);

        const cancelled = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-cancel-clean",
        });
        expect(cancelled.error).toBeUndefined();
        expect((cancelled.result as { snapshot: WorktreeSetupSnapshot }).snapshot.phase).toBe(
          "cancelled",
        );
        expect(fs.existsSync(worktreePath!)).toBe(false);
        expect(branchExists(repo, "f5/thread-cancel-clean")).toBe(false);
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-cancel-clean" })
        ).result as { readonly paused: boolean; readonly reasonCode: string | null };
        expect(queue).toEqual(
          expect.objectContaining({ paused: true, reasonCode: "worktree_setup_cancelled" }),
        );
        expect(sentTurns).toHaveLength(0);
      });

      it("rejects an existing explicit branch and preserves its commits", async () => {
        const repo = makeGitRepo("t3code-ws-setup-existing-cancel-");
        const branch = "f5/thread-existing-cancel";
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
        git("branch", branch);
        const existingHead = git("rev-parse", branch);
        const ws = await startServer({ repo, sentTurns: [] });
        await createProject(ws, repo);
        const submitted = await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-existing-cancel" }),
        );
        expect(submitted.error).toMatchObject({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE });
        expect(submitted.error?.message).toContain("already exists");
        expect(git("rev-parse", branch)).toBe(existingHead);
        expect(await readSetup(ws, "thread-existing-cancel")).toBeNull();
      });

      it("cancel after the setup script wrote files keeps the worktree and branch", async () => {
        const repo = makeGitRepo("t3code-ws-setup-cancel-kept-");
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, {
          command: nodeSetupCommand(
            "require('node:fs').writeFileSync('generated.txt', 'generated'); setTimeout(() => {}, 30000)",
          ),
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-cancel-kept" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-cancel-kept",
          (entry) =>
            entry?.worktreePath != null &&
            fs.existsSync(path.join(entry.worktreePath, "generated.txt")),
        );
        const cancelled = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-cancel-kept",
        });
        const settled = (cancelled.result as { snapshot: WorktreeSetupSnapshot }).snapshot;
        expect(settled.phase).toBe("cancelled_kept");
        expect(settled.error).toContain("uncommitted");
        expect(fs.existsSync(path.join(running!.worktreePath!, "generated.txt"))).toBe(true);
        expect(branchExists(repo, "f5/thread-cancel-kept")).toBe(true);
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-cancel-kept" })
        ).result as { readonly reasonCode: string | null };
        expect(queue.reasonCode).toBe("worktree_setup_cancelled_kept");
        expect(sentTurns).toHaveLength(0);
      });

      it("cancel keeps a worktree whose only new file is gitignored", async () => {
        const repo = makeGitRepo("t3code-ws-setup-cancel-ignored-");
        fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
        execFileSync("git", ["add", ".gitignore"], { cwd: repo, stdio: "pipe" });
        execFileSync(
          "git",
          ["-c", "user.name=F5", "-c", "user.email=f5@example.com", "commit", "-qm", "ignore"],
          { cwd: repo, stdio: "pipe" },
        );
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        const ws = await startServer({ repo, sentTurns });
        await createProject(ws, repo, {
          command: `"${process.execPath}" -e "require('node:fs').writeFileSync('.env', 'SECRET=1\\n'); setTimeout(() => {}, 30000)"`,
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-cancel-ignored" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-cancel-ignored",
          (entry) =>
            entry?.worktreePath != null && fs.existsSync(path.join(entry.worktreePath, ".env")),
        );
        // `git status` reports the tree clean; only the ignored-file check keeps it.
        const cancelled = await sendSetupAction(ws, WS_METHODS.worktreeSetupCancel, {
          threadId: "thread-cancel-ignored",
        });
        const settled = (cancelled.result as { snapshot: WorktreeSetupSnapshot }).snapshot;
        expect(settled.phase).toBe("cancelled_kept");
        expect(settled.error).toContain(".env");
        expect(fs.readFileSync(path.join(running!.worktreePath!, ".env"), "utf8")).toBe(
          "SECRET=1\n",
        );
      });

      it("marks a setup that was running at shutdown as failed and removes nothing", async () => {
        const repo = makeGitRepo("t3code-ws-setup-restart-");
        const stateDir = makeTempDir("t3code-ws-setup-restart-state-");
        const dbPath = path.join(stateDir, "state.sqlite");
        const persistence = () =>
          makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
        const sentTurns: Array<Parameters<ProviderServiceShape["sendTurn"]>[0]> = [];
        let ws = await startServer({ repo, stateDir, persistenceLayer: persistence(), sentTurns });
        await createProject(ws, repo, {
          command: nodeSetupCommand("setTimeout(() => {}, 30000)"),
          async: false,
        });
        await sendRequest(
          ws,
          WS_METHODS.nextTurnQueueSubmit,
          firstSend({ repo, threadId: "thread-restart" }),
        );
        const running = await waitForSetup(
          ws,
          "thread-restart",
          (entry) =>
            entry?.stages.find((stage) => stage.id === "setup-script")?.status === "running",
        );
        // Let the throttled activity write land before the restart.
        await new Promise((resolve) => setTimeout(resolve, 700));
        for (const socket of connections.splice(0)) socket.close();
        await closeTestServer();
        server = null;

        ws = await startServer({ repo, stateDir, persistenceLayer: persistence(), sentTurns });
        const failed = await waitForSetup(
          ws,
          "thread-restart",
          (entry) => entry?.phase === "failed",
        );
        expect(failed?.error).toContain("restart");
        expect(failed!.generation).toBeGreaterThan(running!.generation);
        expect(failed!.sequence).toBeGreaterThan(running!.sequence);
        expect(fs.existsSync(running!.worktreePath!)).toBe(true);
        const queue = (
          await sendRequest(ws, WS_METHODS.nextTurnQueueList, { threadId: "thread-restart" })
        ).result as { readonly paused: boolean; readonly reasonCode: string | null };
        expect(queue).toEqual(
          expect.objectContaining({ paused: true, reasonCode: "worktree_setup_failed" }),
        );
        expect(sentTurns).toHaveLength(0);
      });
    });

    it("reports a first send whose thread was not created so the client can retry", async () => {
      const stateDir = makeTempDir("t3code-ws-first-send-rollback-");
      const repo = makeGitRepo("t3code-ws-first-send-rollback-repo-");
      server = await createTestServer({ cwd: repo, stateDir });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const createdAt = new Date().toISOString();
      await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
        type: "project.create",
        commandId: "command-rollback-project",
        projectId: "project-rollback",
        title: "Rollback",
        workspaceRoot: repo,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
      const response = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
        submissionId: "submission-rollback",
        intent: "auto",
        command: {
          type: "thread.turn.start",
          commandId: "submission-rollback",
          threadId: "thread-rollback",
          message: { messageId: "message-rollback", role: "user", text: "Go.", attachments: [] },
          provider: "codex",
          assistantDeliveryMode: "streaming",
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              // An unknown project makes thread creation fail before it commits.
              projectId: "project-missing",
              title: "New thread",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      expect(response.error).toEqual(
        expect.objectContaining({ code: BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE }),
      );
      const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
        .result as OrchestrationReadModel;
      expect(snapshot.threads.some((entry) => entry.id === "thread-rollback")).toBe(false);
    });
  });

  it("rejects an invalid bootstrap attachment before creating the thread", async () => {
    const stateDir = makeTempDir("t3code-ws-bootstrap-invalid-attachment-");
    const workspaceRoot = makeTempDir("t3code-ws-bootstrap-invalid-attachment-workspace-");
    const dbPath = path.join(stateDir, "state.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    server = await createTestServer({ cwd: workspaceRoot, persistenceLayer, stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = "project-bootstrap-invalid-attachment";
    const threadId = "thread-bootstrap-invalid-attachment";

    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-bootstrap-invalid-attachment-project",
          projectId,
          title: "Bootstrap Invalid Attachment",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "command-bootstrap-invalid-attachment-turn",
      threadId,
      message: {
        messageId: "message-bootstrap-invalid-attachment",
        role: "user",
        text: "Invalid image",
        attachments: [
          {
            type: "image",
            name: "invalid.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: "data:text/plain;base64,aGVsbG8=",
          },
        ],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId,
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    });
    expect(response.error?.message).toContain("Invalid image attachment payload");

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    expect(snapshot.threads.some((entry) => entry.id === threadId)).toBe(false);
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
    const attachmentsDir = path.join(stateDir, "attachments");
    expect(
      fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir, { recursive: true }) : [],
    ).toEqual([]);
  });

  it("cleans bootstrap attachments after a definitely rejected final dispatch", async () => {
    const stateDir = makeTempDir("t3code-ws-bootstrap-rejected-attachment-");
    const workspaceRoot = makeTempDir("t3code-ws-bootstrap-rejected-attachment-workspace-");
    const dbPath = path.join(stateDir, "state.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    server = await createTestServer({ cwd: workspaceRoot, persistenceLayer, stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = "project-bootstrap-rejected-attachment";
    const threadId = "thread-bootstrap-rejected-attachment";

    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "command-bootstrap-rejected-attachment-project",
          projectId,
          title: "Bootstrap Rejected Attachment",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "command-bootstrap-rejected-attachment-turn",
      threadId,
      message: {
        messageId: "message-bootstrap-rejected-attachment",
        role: "user",
        text: "Reject after attachment persistence",
        attachments: [
          {
            type: "image",
            name: "rejected.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
      sourceProposedPlan: { threadId, planId: "missing-plan" },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId,
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    });
    expect(response.error?.message).toContain("does not exist");

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    const snapshot = snapshotResponse.result as OrchestrationReadModel;
    expect(
      snapshot.threads.some((entry) => entry.id === threadId && entry.deletedAt === null),
    ).toBe(false);
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
    const attachmentFiles = fs
      .readdirSync(path.join(stateDir, "attachments"), { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith(".png"));
    expect(attachmentFiles).toEqual([]);
  });

  it("deduplicates concurrent attachment submissions without leaving losing ingress files", async () => {
    const stateDir = makeTempDir("t3code-ws-queue-attachment-replay-");
    const workspaceRoot = makeTempDir("t3code-ws-queue-attachment-workspace-");
    server = await createTestServer({ cwd: workspaceRoot, stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const [secondWs] = await connectAndAwaitWelcome(port);
    connections.push(secondWs);
    const createdAt = new Date().toISOString();

    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "cmd-attachment-replay-project",
          projectId: "project-attachment-replay",
          title: "Attachment Replay",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.create",
          commandId: "cmd-attachment-replay-thread",
          threadId: "thread-attachment-replay",
          projectId: "project-attachment-replay",
          title: "Attachment Replay",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const input = {
      submissionId: "submission-attachment-replay",
      intent: "queue-tail",
      command: {
        type: "thread.turn.start",
        commandId: "cmd-attachment-replay-turn",
        threadId: "thread-attachment-replay",
        message: {
          messageId: "message-attachment-replay-turn",
          role: "user",
          text: "image",
          attachments: [
            {
              type: "image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
              dataUrl: "data:image/png;base64,aGVsbG8=",
            },
          ],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      },
    };
    const [first, second] = await Promise.all([
      sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, input),
      sendRequest(secondWs, WS_METHODS.nextTurnQueueSubmit, input),
    ]);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.result).toEqual(expect.objectContaining({ disposition: "queued" }));
    expect(second.result).toEqual(expect.objectContaining({ disposition: "queued" }));

    const snapshotResponse = await sendRequest(ws, WS_METHODS.nextTurnQueueList, {
      threadId: "thread-attachment-replay",
    });
    const snapshot = snapshotResponse.result as {
      items: Array<{ command: { message: { attachments: Array<{ id: string }> } } }>;
    };
    expect(snapshot.items).toHaveLength(1);
    const attachmentId = snapshot.items[0]?.command.message.attachments[0]?.id;
    expect(attachmentId).toBeTruthy();
    const attachmentFiles = fs
      .readdirSync(path.join(stateDir, "attachments"), { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith(".png"));
    expect(attachmentFiles).toHaveLength(1);
    expect(attachmentFiles[0]).toContain(attachmentId);
  });

  it("keeps orchestration domain push behavior for provider runtime events", async () => {
    let targetedRefreshCalls = 0;
    const usageInstanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
    const usageRegistryLayer = Layer.effect(
      ProviderInstanceRegistry,
      Effect.gen(function* () {
        const capability = yield* makeAccountUsageCapability(
          {
            key: usageInstanceId,
            provider: "codex",
            providerInstanceId: usageInstanceId,
            displayName: "Codex",
            enabled: true,
            refreshState: "idle",
            sections: [emptyAccountSection("codex-limits")],
          },
          Effect.succeed([]),
          { identity: "test:codex" },
        );
        const instance = {
          instanceId: usageInstanceId,
          enabled: true,
          driverKind: ProviderDriverKind.make("codex"),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("codex"),
            continuationKey: usageInstanceId,
          },
          displayName: undefined,
          snapshot: {
            getSnapshot: Effect.succeed(defaultProviderSnapshots[0]!),
            refresh: Effect.succeed(defaultProviderSnapshots[0]!),
            streamChanges: Stream.empty,
          },
          adapter: {} as ProviderInstance["adapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
          accountUsage: {
            ...capability,
            refreshAccount: (permits) => {
              targetedRefreshCalls++;
              return capability.refreshAccount!(permits);
            },
          },
        } as ProviderInstance;
        return {
          getInstance: (id) => Effect.succeed(id === usageInstanceId ? instance : undefined),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
            Effect.flatMap(PubSub.subscribe),
          ),
        };
      }),
    );
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    };
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const providerService: ProviderServiceShape = {
      replaceSession: () => unsupported(),
      startSession: (threadId) =>
        Effect.succeed({
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      sendTurn: ({ threadId }) =>
        Effect.succeed({
          threadId,
          turnId: asTurnId("provider-turn-1"),
        }),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      respondToElicitation: () => unsupported(),
      stopSession: () => unsupported(),
      listStartingWorkspaces: () => Effect.succeed([]),
      listSessions: () => Effect.succeed([]),
      getSessionCapabilities: () => Effect.succeed(null),
      assertSessionAction: () => Effect.die(new Error("assertSessionAction is unused here")),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      readThread: () => unsupported(),
      rollbackConversation: () => unsupported(),
      runOneOffPrompt: () => unsupported(),
      compactConversation: () => unsupported(),
      reloadMcpConfigForProject: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
    const providerLayer = Layer.succeed(ProviderService, providerService);

    const usageStateDir = makeTempDir("t3code-ws-usage-recovery-");
    const usageDbPath = path.join(usageStateDir, "state.sqlite");
    server = await createTestServer({
      cwd: "/test",
      providerLayer,
      providerInstanceRegistryLayer: usageRegistryLayer,
      stateDir: usageStateDir,
      persistenceLayer: makeSqlitePersistenceLive(usageDbPath).pipe(
        Layer.provide(NodeServices.layer),
      ),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const workspaceRoot = makeTempDir("t3code-ws-project-");
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-ws-project-create",
      projectId: "project-1",
      title: "WS Project",
      workspaceRoot,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-ws-runtime-thread-create",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread 1",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const startTurnResponse = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "submission-ws-runtime-turn-start",
      intent: "auto",
      command: {
        type: "thread.turn.start",
        commandId: "cmd-ws-runtime-turn-start",
        threadId: "thread-1",
        message: {
          messageId: "msg-ws-runtime-1",
          role: "user",
          text: "hello",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      },
    });
    expect(startTurnResponse.error).toBeUndefined();

    await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string };
      return event.type === "thread.session-set";
    });

    emitRuntimeEvent({
      type: "content.delta",
      eventId: asEventId("evt-ws-runtime-message-delta"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      itemId: asProviderItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello from runtime",
      },
    } as unknown as ProviderRuntimeEvent);

    const domainPush = await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string; payload?: { messageId?: string; text?: string } };
      return (
        event.type === "thread.message-sent" && event.payload?.messageId === "assistant:item-1"
      );
    });

    const domainEvent = domainPush.data as {
      type: string;
      payload: { messageId: string; text: string };
    };
    expect(domainEvent.type).toBe("thread.message-sent");
    expect(domainEvent.payload.messageId).toBe("assistant:item-1");
    expect(domainEvent.payload.text).toBe("hello from runtime");

    // Exercise both optional consumers through the production runtime layer,
    // rather than supplying UsageService directly to isolated test layers.
    emitRuntimeEvent({
      type: "runtime.error",
      eventId: asEventId("evt-usage-composition"),
      provider: "codex",
      providerInstanceId: usageInstanceId,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("provider-turn-1"),
      createdAt: new Date().toISOString(),
      payload: {
        message: "Usage limit reached",
        usageLimit: { windows: [], resetsAt: null, resetSource: null, evidence: "typed" },
      },
    });
    await vi.waitFor(() => expect(targetedRefreshCalls).toBeGreaterThan(0));
    const refreshCallsBeforeRoute = targetedRefreshCalls;
    const refreshed = await sendRequest(ws, WS_METHODS.nextTurnQueueRefreshUsageLimitResume, {
      threadId: "thread-1",
      expectedLimitKey: `instance:${usageInstanceId}:turn:provider-turn-1`,
    });
    expect(refreshed.error).toBeUndefined();
    expect(targetedRefreshCalls).toBeGreaterThan(refreshCallsBeforeRoute);

    emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-usage-terminal"),
      provider: "codex",
      providerInstanceId: usageInstanceId,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("provider-turn-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "failed",
        errorMessage: "Usage limit reached",
        usageLimit: {
          windows: [],
          resetsAt: null,
          resetSource: null,
          evidence: "typed",
        },
      },
    });
    await vi.waitFor(async () => {
      const model = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
      const thread = (model.result as OrchestrationReadModel).threads.find(
        (entry) => entry.id === "thread-1",
      );
      expect(thread?.session?.activeTurnId).toBeNull();
      expect(thread?.session?.usageLimit?.turnId).toBe("provider-turn-1");
    });
    const stale = await sendRequest(ws, WS_METHODS.nextTurnQueueScheduleUsageLimitResume, {
      threadId: "thread-1",
      expectedLimitKey: "instance:other:turn:old",
      notBefore: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(stale.error?.message).toMatch(/changed|stale/i);
    const scheduled = await sendRequest(ws, WS_METHODS.nextTurnQueueScheduleUsageLimitResume, {
      threadId: "thread-1",
      expectedLimitKey: `instance:${usageInstanceId}:turn:provider-turn-1`,
      notBefore: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scheduled.error).toBeUndefined();
    const scheduledSnapshot = scheduled.result as {
      revision: number;
      items: Array<{ itemId: string; scheduleReason?: string }>;
    };
    const recoveryItem = scheduledSnapshot.items.find(
      (item) => item.scheduleReason === "usage_limit_reset",
    )!;
    // Hold the durable row in the acceptance state to exercise the route's
    // typed race result without sending a real provider turn.
    const usageDb = new DatabaseSync(usageDbPath);
    try {
      usageDb
        .prepare("UPDATE next_turn_queue SET status = 'dispatching' WHERE item_id = ?")
        .run(recoveryItem.itemId);
      const cancelSending = await sendRequest(ws, WS_METHODS.nextTurnQueueCancelUsageLimitResume, {
        threadId: "thread-1",
        itemId: recoveryItem.itemId,
        expectedRevision: scheduledSnapshot.revision,
      });
      expect(cancelSending.error).toBeUndefined();
      expect(cancelSending.result).toEqual(expect.objectContaining({ kind: "already_sending" }));
    } finally {
      usageDb
        .prepare("UPDATE next_turn_queue SET status = 'queued' WHERE item_id = ?")
        .run(recoveryItem.itemId);
      usageDb.close();
    }
    const command = (id: string) => ({
      type: "thread.turn.start",
      commandId: `cmd-${id}`,
      threadId: "thread-1",
      message: { messageId: `msg-${id}`, role: "user", text: "follow up", attachments: [] },
      assistantDeliveryMode: "streaming",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
    const tail = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "usage-tail",
      intent: "queue-tail",
      command: command("usage-tail"),
    });
    expect(tail.error).toBeUndefined();
    const queueAfterTail = await sendRequest(ws, WS_METHODS.nextTurnQueueList, {
      threadId: "thread-1",
    });
    expect(
      (queueAfterTail.result as { items: Array<{ scheduleReason?: string }> }).items.some(
        (item) => item.scheduleReason === "usage_limit_reset",
      ),
    ).toBe(true);
    const immediate = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "usage-immediate",
      intent: "auto",
      command: command("usage-immediate"),
    });
    expect(immediate.error).toBeUndefined();
    const queueAfterImmediate = await sendRequest(ws, WS_METHODS.nextTurnQueueList, {
      threadId: "thread-1",
    });
    expect(
      (queueAfterImmediate.result as { items: Array<{ scheduleReason?: string }> }).items.some(
        (item) => item.scheduleReason === "usage_limit_reset",
      ),
    ).toBe(false);
  });

  it("routes terminal RPC methods and broadcasts terminal events", async () => {
    const cwd = makeTempDir("t3code-ws-terminal-cwd-");
    const terminalManager = new MockTerminalManager();
    server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = Effect.runPromise(
      withProviderThreadAccess(
        "thread-1",
        Effect.promise(async () => {
          entered();
          await unlock;
        }),
      ),
    );
    await held;
    try {
      for (const method of [WS_METHODS.terminalOpen, WS_METHODS.terminalRestart]) {
        const liveTerminal = await sendRequest(ws, method, {
          threadId: "thread-1",
          cwd,
          cols: 100,
          rows: 24,
        });
        expect(liveTerminal.error).toBeUndefined();
        expect((liveTerminal.result as TerminalSessionSnapshot).threadId).toBe("thread-1");
      }
    } finally {
      release();
      await launch;
    }

    const open = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });
    expect(open.error).toBeUndefined();
    expect((open.result as TerminalSessionSnapshot).threadId).toBe("thread-1");
    expect((open.result as TerminalSessionSnapshot).terminalId).toBe(DEFAULT_TERMINAL_ID);

    const write = await sendRequest(ws, WS_METHODS.terminalWrite, {
      threadId: "thread-1",
      data: "echo hello\n",
    });
    expect(write.error).toBeUndefined();

    const resize = await sendRequest(ws, WS_METHODS.terminalResize, {
      threadId: "thread-1",
      cols: 120,
      rows: 30,
    });
    expect(resize.error).toBeUndefined();

    const clear = await sendRequest(ws, WS_METHODS.terminalClear, {
      threadId: "thread-1",
    });
    expect(clear.error).toBeUndefined();

    const restart = await sendRequest(ws, WS_METHODS.terminalRestart, {
      threadId: "thread-1",
      cwd,
      cols: 120,
      rows: 30,
    });
    expect(restart.error).toBeUndefined();

    const close = await sendRequest(ws, WS_METHODS.terminalClose, {
      threadId: "thread-1",
      deleteHistory: true,
    });
    expect(close.error).toBeUndefined();

    const manualEvent: TerminalEvent = {
      epoch: "test",
      generation: 1,
      revision: 1,
      type: "output",
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      createdAt: new Date().toISOString(),
      data: "manual test output\n",
    };
    terminalManager.emitEvent(manualEvent);

    const push = await waitForPush(
      ws,
      WS_CHANNELS.terminalEvent,
      (candidate) => (candidate.data as TerminalEvent).type === "output",
    );
    expect(push.type).toBe("push");
    expect(push.channel).toBe(WS_CHANNELS.terminalEvent);
  });

  it("detaches terminal event listener on stop for injected manager", async () => {
    const terminalManager = new MockTerminalManager();
    server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });

    expect(terminalManager.subscriptionCount()).toBe(1);

    await closeTestServer();
    server = null;

    expect(terminalManager.subscriptionCount()).toBe(0);
  });

  it("returns validation errors for invalid terminal open params", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "",
      cwd: "",
      cols: 1,
      rows: 1,
    });
    expect(response.error).toBeDefined();
  });

  it("handles invalid JSON gracefully", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    // Send garbage
    ws.send("not json at all");

    // Error response goes to the response channel
    const channels = channelsBySocket.get(ws)!;
    let response: WebSocketResponse | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const message = await dequeue(channels.response, 5_000);
      if (message.id === "unknown") {
        response = message;
        break;
      }
      if (message.error) {
        response = message;
        break;
      }
    }
    expect(response).toBeDefined();
    expect(response!.error).toBeDefined();
    expect(response!.error!.message).toContain("Invalid request format");
  });

  for (const constructionThrow of [false, true]) {
    it(`isolates route defects from concurrent and later requests, construction throw=${constructionThrow}`, async () => {
      const started = Effect.runSync(Deferred.make<void>());
      const released = Effect.runSync(Deferred.make<void>());
      const open: OpenShape = {
        ...defaultOpenService,
        openInEditor: ({ cwd }) => {
          if (cwd === "/fixture/pending") {
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
            );
          }
          if (cwd === "/fixture/failing") {
            if (constructionThrow) throw new Error("fixture route construction defect");
            return Effect.die(new Error("fixture route defect"));
          }
          return Effect.void;
        },
      };
      server = await createTestServer({ cwd: "/test", open });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);
      const responses = channelsBySocket.get(ws)!.response;
      const send = (id: string, cwd: string) =>
        ws.send(
          JSON.stringify({
            id,
            body: { _tag: WS_METHODS.shellOpenInEditor, cwd, editor: "cursor" },
          }),
        );
      try {
        send("pending", "/fixture/pending");
        await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("5 seconds")));
        send("failing", "/fixture/failing");
        const failed = await dequeue(responses, 5_000);
        expect(failed.id).toBe("failing");
        expect(failed.error).toBeDefined();
        send("later", "/fixture/success");
        const later = await dequeue(responses, 5_000);
        expect(later.id).toBe("later");
        expect(later.error).toBeUndefined();
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        Effect.runSync(Deferred.succeed(released, undefined));
      }
      const pending = await dequeue(responses, 5_000);
      expect(pending.id).toBe("pending");
      expect(pending.error).toBeUndefined();
    });
  }

  it("catches websocket message handler rejections and keeps the socket usable", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const brokenOpenService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: () =>
        Effect.sync(() => BigInt(1)).pipe(Effect.map((result) => result as unknown as void)),
      revealInFileManager: () => Effect.void,
    };

    try {
      server = await createTestServer({ cwd: "/test", open: brokenOpenService });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const [ws] = await connectAndAwaitWelcome(port);
      connections.push(ws);

      ws.send(
        JSON.stringify({
          id: "req-broken-open",
          body: {
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/tmp",
            editor: "cursor",
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandledRejections).toHaveLength(0);

      const workspace = makeTempDir("t3code-ws-handler-still-usable-");
      fs.writeFileSync(path.join(workspace, "file.txt"), "ok\n", "utf8");
      const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
        cwd: workspace,
        query: "file",
        limit: 5,
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              path: "file.txt",
              kind: "file",
            }),
          ]),
        }),
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("returns errors for removed projects CRUD methods", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.projectsList);
    expect(listResponse.result).toBeUndefined();
    expect(listResponse.error?.message).toContain("Invalid request format");

    const addResponse = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: "/tmp/project-a",
    });
    expect(addResponse.result).toBeUndefined();
    expect(addResponse.error?.message).toContain("Invalid request format");

    const removeResponse = await sendRequest(ws, WS_METHODS.projectsRemove, {
      id: "project-a",
    });
    expect(removeResponse.result).toBeUndefined();
    expect(removeResponse.error?.message).toContain("Invalid request format");
  });

  it("supports projects.searchEntries", async () => {
    const workspace = makeTempDir("t3code-ws-workspace-entries-");
    fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "components", "Composer.tsx"),
      "export {};",
      "utf8",
    );
    fs.writeFileSync(path.join(workspace, "README.md"), "# test", "utf8");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: workspace,
      query: "comp",
      limit: 10,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "src/components", kind: "directory" }),
        expect.objectContaining({ path: "src/components/Composer.tsx", kind: "file" }),
      ]),
      truncated: false,
    });
  });

  it("creates a committed project from a name in the configured projects folder", async () => {
    const projectsRoot = makeTempDir("f5-ws-new-projects-");
    fs.mkdirSync(path.join(projectsRoot, "my-app"));
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    expect(
      (
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          projectsRoot,
          gitAuthorName: "F5 Test",
          gitAuthorEmail: "f5@example.com",
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.projectsCreateNew, { name: "My App" });
    expect(response.error).toBeUndefined();
    const result = response.result as { projectId: string; workspaceRoot: string; warning: null };
    // The taken name gets a suffix rather than reusing a folder that already exists.
    expect(result.workspaceRoot).toBe(path.join(projectsRoot, "my-app-2"));
    expect(result.warning).toBeNull();
    expect(
      execFileSync("git", ["log", "--format=%s"], { cwd: result.workspaceRoot }).toString().trim(),
    ).toBe("Initial commit");
    const snapshot = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(
      (snapshot.result as OrchestrationReadModel).projects.find(
        (project) => project.id === result.projectId,
      ),
    ).toMatchObject({ title: "My App", workspaceRoot: result.workspaceRoot, kind: "standard" });
  });

  it("finds the projects whose GitHub remote names a repository", async () => {
    const repo = (remote: string) => {
      const folder = makeTempDir("f5-ws-find-repo-");
      execFileSync("git", ["init", "-q"], { cwd: folder });
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: folder });
      return folder;
    };
    const matching = repo("git@github.com:Lopes-Felipe/F5.git");
    const other = repo("https://github.com/lopes-felipe/f5-docs.git");
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    for (const [projectId, workspaceRoot] of [
      ["project-find-match", matching],
      ["project-find-other", other],
    ] as const) {
      const created = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
        type: "project.create",
        commandId: `cmd-${projectId}`,
        projectId,
        title: projectId,
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: new Date().toISOString(),
      });
      expect(created.error).toBeUndefined();
    }

    const response = await sendRequest(ws, WS_METHODS.projectsFindByRepository, {
      owner: "lopes-felipe",
      name: "f5",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual([
      { projectId: "project-find-match", title: "project-find-match", workspaceRoot: matching },
    ]);
  });

  it("keeps file and Git requests below the scratch root inside one thread folder", async () => {
    const stateDir = makeTempDir("f5-ws-scratch-state-");
    const folder = path.join(stateDir, "scratch", "2026-10-22-notes-abc12345");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "notes.md"), "# notes", "utf8");
    server = await createTestServer({ cwd: "/test", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const own = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: folder,
      query: "notes",
      limit: 10,
    });
    expect(own.error).toBeUndefined();
    const shared = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: path.join(stateDir, "scratch"),
      query: "notes",
      limit: 10,
    });
    expect(shared.error?.message).toContain("not a workspace");
    const status = await sendRequest(ws, WS_METHODS.gitStatus, { cwd: folder });
    expect(status.error?.message).toContain("no Git repository");
  });

  it("loads checked-in project defaults through a registered project identity", async () => {
    const workspace = makeTempDir("f5-ws-project-config-");
    fs.writeFileSync(
      path.join(workspace, "f5.json"),
      JSON.stringify({ defaultThreadEnvMode: "worktree", scripts: [{ command: "ignored" }] }),
      "utf8",
    );
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const projectId = "project-checked-in-config";
    const createdAt = new Date().toISOString();
    const created = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-project-checked-in-config",
      projectId,
      title: "Checked-in config",
      workspaceRoot: workspace,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(created.error).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.projectsGetCheckedInConfig, { projectId });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      projectId,
      sourceFile: "f5.json",
      defaultThreadEnvMode: "worktree",
      iconPath: null,
      diagnostics: [expect.objectContaining({ field: "scripts" })],
    });
  });

  it("searches project contents through registered identities", async () => {
    const workspace = makeTempDir("f5-ws-content-search-");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "unicode.ts"),
      "export const value = '😀 café needle';\n",
      "utf8",
    );

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const createdAt = new Date().toISOString();
    const created = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-content-project-create",
      projectId: "project-content",
      title: "Content Project",
      workspaceRoot: workspace,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(created.error).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.projectsSearchContents, {
      requestId: "content-search-1",
      projectId: "project-content",
      query: "café",
      limit: 500,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(
      expect.objectContaining({
        requestId: "content-search-1",
        truncated: false,
        matches: [
          expect.objectContaining({
            path: "src/unicode.ts",
            lineNumber: 1,
            matchRanges: [{ start: 24, end: 28 }],
          }),
        ],
      }),
    );

    const unavailable = await sendRequest(ws, WS_METHODS.projectsSearchContents, {
      requestId: "content-search-outside",
      projectId: workspace,
      query: "needle",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(unavailable.result).toBeUndefined();
    expect(unavailable.error?.message).toBe("Project content search target is unavailable.");

    const cancelled = await sendRequest(ws, WS_METHODS.projectsCancelContentSearch, {
      requestId: "missing-content-search",
    });
    expect(cancelled.result).toEqual({ cancelled: false });
  });

  it("supports projects.listEntries", async () => {
    const workspace = makeTempDir("t3code-ws-workspace-list-entries-");
    fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "components", "Composer.tsx"), "export {};");
    fs.writeFileSync(path.join(workspace, "README.md"), "# test", "utf8");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsListEntries, {
      cwd: workspace,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "src", kind: "directory" }),
        expect.objectContaining({ path: "src/components", kind: "directory" }),
        expect.objectContaining({ path: "src/components/Composer.tsx", kind: "file" }),
        expect.objectContaining({ path: "README.md", kind: "file" }),
      ]),
      truncated: false,
      totalEntries: 4,
    });
  });

  it("supports projects.writeFile within the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
      condition: { type: "create" },
      contents: "# Plan\n\n- step 1\n",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      relativePath: "plans/effect-rpc.md",
      byteLength: Buffer.byteLength("# Plan\n\n- step 1\n"),
      contentSha256: sha256Hex("# Plan\n\n- step 1\n"),
    });
    expect(fs.readFileSync(path.join(workspace, "plans", "effect-rpc.md"), "utf8")).toBe(
      "# Plan\n\n- step 1\n",
    );
  });

  it("rejects stale projects.writeFile precondition hashes", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-conflict-");
    fs.mkdirSync(path.join(workspace, "plans"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "plans", "effect-rpc.md"), "original\n", "utf8");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
      contents: "next\n",
      condition: { type: "match", contentSha256: sha256Hex("stale\n") },
    });

    expect(response.result).toMatchObject({ conflict: true });
    expect(response.error).toBeUndefined();
    expect(fs.readFileSync(path.join(workspace, "plans", "effect-rpc.md"), "utf8")).toBe(
      "original\n",
    );
  });

  it("rejects projects.writeFile precondition hashes for oversized files without reading them", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-large-precondition-");
    fs.writeFileSync(
      path.join(workspace, "large.txt"),
      Buffer.alloc(PROJECT_READ_FILE_MAX_SIZE + 1, "a"),
    );

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "large.txt",
      contents: "next\n",
      condition: { type: "match", contentSha256: sha256Hex("stale\n") },
    });

    expect(response.result).toMatchObject({ conflict: true });
    expect(response.error).toBeUndefined();
    expect(fs.statSync(path.join(workspace, "large.txt")).size).toBe(
      PROJECT_READ_FILE_MAX_SIZE + 1,
    );
  });

  it("rejects projects.writeFile paths outside the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-reject-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "../escape.md",
      condition: { type: "create" },
      contents: "# no\n",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
    expect(fs.existsSync(path.join(workspace, "..", "escape.md"))).toBe(false);
  });

  it("rejects symlink escapes for projects.writeFile", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-symlink-");
    const outside = makeTempDir("t3code-ws-write-file-outside-");
    fs.symlinkSync(outside, path.join(workspace, "outside-link"));

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "outside-link/escape.md",
      condition: { type: "create" },
      contents: "# no\n",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
    expect(fs.existsSync(path.join(outside, "escape.md"))).toBe(false);
  });

  it("supports projects.readFile within the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-");
    fs.mkdirSync(path.join(workspace, "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "plans", "effect-rpc.md"),
      "# Plan\n\n- step 1\n",
      "utf8",
    );

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      workspaceIdentity: fs.realpathSync(workspace),
      fileIdentity: fs.realpathSync(path.join(workspace, "plans", "effect-rpc.md")),
      relativePath: "plans/effect-rpc.md",
      contents: "# Plan\n\n- step 1\n",
      byteLength: Buffer.byteLength("# Plan\n\n- step 1\n"),
      truncated: false,
      contentSha256: sha256Hex("# Plan\n\n- step 1\n"),
    });
  });

  it("reads an external preview through a canonicalized parent without changing the project root", async () => {
    const workspace = makeTempDir("t3code-preview-project-");
    const external = makeTempDir("t3code-preview-external-");
    const aliasRoot = makeTempDir("t3code-preview-alias-");
    const alias = path.join(aliasRoot, "external");
    fs.writeFileSync(path.join(external, "report.json"), '{"images":8}', "utf8");
    fs.symlinkSync(external, alias, "dir");
    server = await createTestServer({ cwd: workspace });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: alias,
      relativePath: "report.json",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      workspaceIdentity: fs.realpathSync(external),
      fileIdentity: fs.realpathSync(path.join(external, "report.json")),
      contents: '{"images":8}',
      truncated: false,
    });
  });

  it("authorizes binary workspace files without reading their contents", async () => {
    const workspace = makeTempDir("t3code-ws-authorize-entry-");
    fs.writeFileSync(path.join(workspace, "image.bin"), Buffer.from([0, 1, 2, 3]));
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsAuthorizeEntry, {
      cwd: workspace,
      relativePath: "image.bin",
      kind: "file",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ relativePath: "image.bin", kind: "file" });
  });

  it("rejects changed kinds and symlink escapes when authorizing workspace entries", async () => {
    const workspace = makeTempDir("t3code-ws-authorize-entry-symlink-");
    const outside = makeTempDir("t3code-ws-authorize-entry-outside-");
    fs.mkdirSync(path.join(workspace, "docs"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "secret-link.txt"));
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const changedKind = await sendRequest(ws, WS_METHODS.projectsAuthorizeEntry, {
      cwd: workspace,
      relativePath: "docs",
      kind: "file",
    });
    expect(changedKind.error?.message).toContain("Workspace entry type changed: docs");

    const symlinkEscape = await sendRequest(ws, WS_METHODS.projectsAuthorizeEntry, {
      cwd: workspace,
      relativePath: "secret-link.txt",
      kind: "file",
    });
    expect(symlinkEscape.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
  });

  it("resolves projects.readFile targets to the validated real path before reading", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-realpath-");
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "guide.md"), "# Guide\n", "utf8");
    fs.symlinkSync(path.join(workspace, "docs", "guide.md"), path.join(workspace, "guide-link.md"));

    const resolved = await Effect.runPromise(
      resolveWorkspaceReadPath({
        workspaceRoot: workspace,
        relativePath: "guide-link.md",
        path: path as never,
        fileSystem: {
          realPath: (targetPath: string) =>
            Effect.tryPromise({
              try: () => fs.promises.realpath(targetPath),
              catch: (cause) => new TestRealPathError({ cause }),
            }),
        } as never,
      }),
    );

    expect(resolved.relativePath).toBe("guide-link.md");
    expect(resolved.absolutePath).toBe(
      await fs.promises.realpath(path.join(workspace, "guide-link.md")),
    );
  });

  it("rejects projects.readFile paths outside the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-reject-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "../escape.md",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
  });

  it("rejects symlink escapes for projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-symlink-");
    const outside = makeTempDir("t3code-ws-read-file-outside-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "secret-link.txt"));

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "secret-link.txt",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
  });

  it("returns a truncated preview for oversized text files in projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-large-");
    fs.writeFileSync(
      path.join(workspace, "large.txt"),
      Buffer.alloc(PROJECT_READ_FILE_MAX_SIZE + 1, "a"),
    );

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "large.txt",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      workspaceIdentity: fs.realpathSync(workspace),
      fileIdentity: fs.realpathSync(path.join(workspace, "large.txt")),
      relativePath: "large.txt",
      contents: "a".repeat(PROJECT_READ_FILE_MAX_SIZE),
      byteLength: PROJECT_READ_FILE_MAX_SIZE + 1,
      truncated: true,
    });
  });

  it("returns not found errors for missing projects.readFile targets", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-missing-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "missing.txt",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("File not found: missing.txt");
  });

  it("rejects binary files for projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-binary-");
    fs.writeFileSync(path.join(workspace, "image.bin"), Buffer.from([0, 1, 2, 3]));

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "image.bin",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Binary file cannot be displayed: image.bin");
  });

  it("rejects directories for projects.readFile", async () => {
    const workspace = makeTempDir("t3code-ws-read-file-directory-");
    fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsReadFile, {
      cwd: workspace,
      relativePath: "notes",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Path is a directory: notes");
  });

  it("routes git core methods over websocket", async () => {
    const listBranches = vi.fn(() =>
      Effect.succeed({
        branches: [],
        isRepo: false,
        hasOriginRemote: false,
      }),
    );
    const initRepo = vi.fn(() => Effect.void);
    const pullCurrentBranch = vi.fn(() =>
      Effect.fail(
        new GitCommandError({
          operation: "GitCore.test.pullCurrentBranch",
          detail: "No upstream configured",
          command: "git pull",
          cwd: "/repo/path",
        }),
      ),
    );

    server = await createTestServer({
      cwd: "/test",
      gitCore: {
        listBranches,
        initRepo,
        pullCurrentBranch,
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.gitListBranches, { cwd: "/repo/path" });
    expect(listResponse.error).toBeUndefined();
    expect(listResponse.result).toEqual({ branches: [], isRepo: false, hasOriginRemote: false });
    expect(listBranches).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const initResponse = await sendRequest(ws, WS_METHODS.gitInit, { cwd: "/repo/path" });
    expect(initResponse.error).toBeUndefined();
    expect(initRepo).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const pullResponse = await sendRequest(ws, WS_METHODS.gitPull, { cwd: "/repo/path" });
    expect(pullResponse.result).toBeUndefined();
    expect(pullResponse.error?.message).toContain("No upstream configured");
    expect(pullCurrentBranch).toHaveBeenCalledWith("/repo/path");
  });

  it("supports git.status over websocket", async () => {
    const statusResult = {
      branch: "feature/test",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/index.ts", insertions: 7, deletions: 2 }],
        insertions: 7,
        deletions: 2,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const status = vi.fn(() => Effect.succeed(statusResult));
    const runStackedAction = vi.fn(() => Effect.void as any);
    const resolvePullRequest = vi.fn(() => Effect.void as any);
    const preparePullRequestThread = vi.fn(() => Effect.void as any);
    const gitManager: GitManagerShape = {
      branchPullRequest: () => Effect.succeed(null),
      status,
      resolvePullRequest,
      preparePullRequestThread,
      runStackedAction,
    };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.gitStatus, {
      cwd: "/test",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(statusResult);
    expect(status).toHaveBeenCalledWith({ cwd: "/test" });
  });

  it("supports git pull request routing over websocket", async () => {
    const resolvePullRequestResult = {
      pullRequest: {
        number: 42,
        title: "PR thread flow",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open" as const,
      },
    };
    const preparePullRequestThreadResult = {
      ...resolvePullRequestResult,
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    };

    const gitManager: GitManagerShape = {
      branchPullRequest: () => Effect.succeed(null),
      status: vi.fn(() => Effect.void as any),
      resolvePullRequest: vi.fn(() => Effect.succeed(resolvePullRequestResult)),
      preparePullRequestThread: vi.fn(() => Effect.succeed(preparePullRequestThreadResult)),
      runStackedAction: vi.fn(() => Effect.void as any),
    };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const resolveResponse = await sendRequest(ws, WS_METHODS.gitResolvePullRequest, {
      cwd: "/test",
      reference: "#42",
    });
    expect(resolveResponse.error).toBeUndefined();
    expect(resolveResponse.result).toEqual(resolvePullRequestResult);

    const prepareResponse = await sendRequest(ws, WS_METHODS.gitPreparePullRequestThread, {
      cwd: "/test",
      reference: "42",
      mode: "worktree",
    });
    expect(prepareResponse.error).toBeUndefined();
    expect(prepareResponse.result).toEqual(preparePullRequestThreadResult);
    expect(gitManager.resolvePullRequest).toHaveBeenCalledWith({
      cwd: "/test",
      reference: "#42",
    });
    expect(gitManager.preparePullRequestThread).toHaveBeenCalledWith({
      cwd: "/test",
      reference: "42",
      mode: "worktree",
    });
  });

  it("returns errors from git.runStackedAction", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.fail(
        new GitManagerError({
          operation: "GitManager.test.runStackedAction",
          detail: "Cannot push from detached HEAD.",
        }),
      ),
    );
    const gitManager: GitManagerShape = {
      branchPullRequest: () => Effect.succeed(null),
      status: vi.fn(() => Effect.void as any),
      resolvePullRequest: vi.fn(() => Effect.void as any),
      preparePullRequestThread: vi.fn(() => Effect.void as any),
      runStackedAction,
    };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.gitRunStackedAction, {
      cwd: "/test",
      action: "commit_push",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("detached HEAD");
    expect(runStackedAction).toHaveBeenCalledWith(
      {
        cwd: "/test",
        action: "commit_push",
      },
      expect.objectContaining({
        actionId: expect.any(String),
        progressReporter: expect.objectContaining({
          publish: expect.any(Function),
        }),
      }),
    );
  });

  it.each([null, "0", "25", "26", "999", "1&protocol=1"])(
    "rejects incompatible protocol %s without sending any domain data",
    async (protocol) => {
      server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const result = await new Promise<{ code: number; reason: string; messages: string[] }>(
        (resolve, reject) => {
          const socket = new WebSocket(
            `ws://127.0.0.1:${port}/?token=secret-token${protocol === null ? "" : `&protocol=${protocol}`}`,
          );
          const messages: string[] = [];
          socket.on("error", reject);
          socket.on("message", (raw) => messages.push(String(raw)));
          socket.on("open", () =>
            socket.send(
              JSON.stringify({ id: "stale", body: { _tag: ORCHESTRATION_WS_METHODS.getSnapshot } }),
            ),
          );
          socket.on("close", (code, reason) => resolve({ code, reason: String(reason), messages }));
        },
      );
      expect(result).toEqual({
        code: F5_UPGRADE_REQUIRED_CLOSE_CODE,
        reason: JSON.stringify({ error: "upgrade-required", protocolVersion: F5_PROTOCOL_VERSION }),
        messages: [],
      });
      const [current, welcome] = await connectAndAwaitWelcome(port, "secret-token");
      connections.push(current);
      expect(welcome.data.bootstrap).toEqual(SERVER_BOOTSTRAP);
    },
  );

  it("authenticates bootstrap metadata and rejects stale upload protocols before consuming bytes", async () => {
    server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(401);
    const metadata = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.json()).toEqual(SERVER_BOOTSTRAP);
    for (const version of [undefined, "0", "999"]) {
      const response = await fetch(`${base}/api/storage/restore`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          ...(version ? { [F5_PROTOCOL_HEADER]: version } : {}),
        },
        body: "not a backup",
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({
        error: "upgrade-required",
        protocolVersion: F5_PROTOCOL_VERSION,
      });
    }
    const current = await fetch(`${base}/api/storage/restore`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        [F5_PROTOCOL_HEADER]: String(F5_PROTOCOL_VERSION),
      },
      body: "not a backup",
    });
    expect(current.status).toBe(400);
  });

  it("serves capability assets with the real request origin in CSP and renderer CORS", async () => {
    const stateDir = makeTempDir("f5-asset-origin-");
    const attachments = path.join(stateDir, "attachments");
    fs.mkdirSync(attachments, { recursive: true });
    fs.writeFileSync(
      path.join(attachments, "page.html"),
      '<link rel="stylesheet" href="page.css">',
    );
    fs.writeFileSync(path.join(attachments, "page.css"), "body { color: red }");
    fs.writeFileSync(path.join(attachments, "notes.md"), "# Notes");
    server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      stateDir,
      authToken: "secret-token",
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const [ws] = await connectAndAwaitWelcome(port, "secret-token", { Origin: "t3://app" });
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.projectsIssueAssetUrl, {
      identity: { kind: "attachments" },
      files: [
        { relativePath: "page.html", grant: "html-document" },
        { relativePath: "missing.png", grant: "file" },
        { relativePath: "notes.md", grant: "file" },
      ],
    });
    expect(response.error).toBeUndefined();
    // An unreadable entry is reported alone instead of failing the whole batch.
    const [html, missing, notes] = response.result as Array<{ url: string } | null>;
    expect(missing).toBeNull();

    const document = await fetch(`${base}${html!.url}`);
    await document.text();
    const handlePrefix = `${base}${html!.url.slice(0, html!.url.lastIndexOf("/") + 1)}`;
    const csp = document.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src ${handlePrefix};`);
    expect(csp).not.toContain("localhost");
    // The sibling the CSP allows is actually served under that prefix.
    const stylesheet = await fetch(`${handlePrefix}page.css`);
    expect(stylesheet.status).toBe(200);
    expect(await stylesheet.text()).toBe("body { color: red }");

    // The renderer reads text previews with fetch(), which needs CORS but no credentials.
    const text = await fetch(`${base}${notes!.url}`, { headers: { Origin: "t3://app" } });
    expect(text.status).toBe(200);
    expect(text.headers.get("access-control-allow-origin")).toBe("t3://app");
    expect(text.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await text.text()).toBe("# Notes");
    const foreign = await fetch(`${base}${notes!.url}`, {
      headers: { Origin: "https://attacker.example" },
    });
    await foreign.text();
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("opens an extensionless persisted attachment through a restricted capability URL", async () => {
    const stateDir = makeTempDir("f5-attachment-viewer-");
    fs.mkdirSync(path.join(stateDir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "attachments", "saved-document.pdf"), "%PDF-test");
    server = await createTestServer({ cwd: "/test", stateDir, authToken: "secret-token" });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const [ws] = await connectAndAwaitWelcome(port, "secret-token");
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.projectsIssueAssetUrl, {
      identity: { kind: "attachments" },
      files: [{ relativePath: "saved-document", grant: "file" }],
    });
    expect(response.error).toBeUndefined();
    const grants = response.result as Array<{ url: string }>;
    expect(grants).toHaveLength(1);
    const url = `http://127.0.0.1:${port}${grants[0]!.url}`;
    const document = await fetch(url);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toBe("application/pdf");
    expect(await document.text()).toBe("%PDF-test");
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect((await fetch(url.replace("saved-document.pdf", "other.pdf"))).status).toBe(400);
  });

  it("streams generic uploads with protocol, origin, filename, and range checks", async () => {
    server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const url = `${base}/api/attachments/uploads?threadId=draft-files`;
    const auth = { Authorization: "Bearer secret-token" };
    expect((await fetch(url, { method: "POST", headers: auth, body: "file" })).status).toBe(426);
    const headers = {
      ...auth,
      [F5_PROTOCOL_HEADER]: String(F5_PROTOCOL_VERSION),
      "X-F5-File-Name": encodeURIComponent("世界.pdf"),
      "Content-Type": "application/pdf",
    };
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, Origin: "https://untrusted.example" },
          body: "file",
        })
      ).status,
    ).toBe(403);
    const response = await fetch(url, { method: "POST", headers, body: "%PDF-test" });
    expect(response.status).toBe(201);
    const upload = (await response.json()) as { uploadId: string; name: string; kind: string };
    expect(upload).toMatchObject({ name: "世界.pdf", kind: "file" });
    const fileUrl = `${base}/api/attachments/uploads/${upload.uploadId}`;
    expect((await fetch(fileUrl)).status).toBe(401);
    const range = await fetch(fileUrl, { headers: { ...auth, Range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 0-3/9");
    expect(range.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await range.text()).toBe("%PDF");
    expect((await fetch(fileUrl, { headers: { ...auth, Range: "bytes=99-" } })).status).toBe(416);
  });

  it("releases a draft's upload staging once the queued turn owns its copy", async () => {
    const stateDir = makeTempDir("f5-upload-release-");
    server = await createTestServer({ cwd: "/test", stateDir, authToken: "secret-token" });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const [ws] = await connectAndAwaitWelcome(port, "secret-token");
    connections.push(ws);
    const createdAt = new Date().toISOString();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "cmd-upload-release-project",
          projectId: "project-upload-release",
          title: "Uploads",
          workspaceRoot: makeTempDir("f5-upload-release-project-"),
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.create",
          commandId: "cmd-upload-release-thread",
          threadId: "thread-upload-release",
          projectId: "project-upload-release",
          title: "Uploads",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const uploaded = await fetch(`${base}/api/attachments/uploads?threadId=thread-upload-release`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        [F5_PROTOCOL_HEADER]: String(F5_PROTOCOL_VERSION),
        "X-F5-File-Name": "notes.txt",
        "Content-Type": "text/plain",
      },
      body: "sent once",
    });
    expect(uploaded.status).toBe(201);
    const { uploadId } = (await uploaded.json()) as { uploadId: string };
    const uploadsDir = path.join(stateDir, "attachments", ".uploads");
    const stagedBefore = fs.readdirSync(uploadsDir);
    expect(stagedBefore.length).toBeGreaterThan(0);

    const submitted = await sendRequest(ws, WS_METHODS.nextTurnQueueSubmit, {
      submissionId: "submission-upload-release",
      intent: "queue-tail",
      command: {
        type: "thread.turn.start",
        commandId: "cmd-upload-release-turn",
        threadId: "thread-upload-release",
        message: {
          messageId: "msg-upload-release",
          role: "user",
          text: "see attached",
          attachments: [{ type: "upload", uploadId }],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      },
    });
    expect(submitted.error).toBeUndefined();

    // The upload row and its staged bytes are gone; the queued copy is unaffected.
    const renewed = await sendRequest(ws, WS_METHODS.attachmentsGetUploads, {
      threadId: "thread-upload-release",
      uploadIds: [uploadId],
    });
    expect(renewed.result).toEqual([null]);
    expect(fs.readdirSync(uploadsDir)).toEqual([]);
  });

  it("rejects websocket connections without a valid auth token", async () => {
    server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await expect(connectWs(port)).rejects.toThrow("WebSocket connection failed");

    const [authorizedWs] = await connectAndAwaitWelcome(port, "secret-token");
    connections.push(authorizedWs);
  });

  it("accepts the authenticated packaged desktop websocket origin", async () => {
    server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      authToken: "secret-token",
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [authorizedWs] = await connectAndAwaitWelcome(port, "secret-token", {
      Origin: "t3://app",
    });
    connections.push(authorizedWs);
  });

  it("allows narrowly scoped desktop renderer CORS requests to private HTTP routes", async () => {
    const stateDir = makeTempDir("t3code-state-desktop-cors-");
    server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      authToken: "secret-token",
      stateDir,
      persistenceLayer: makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const origin = `http://127.0.0.1:${port}`;

    const preflightResponse = await fetch(`${origin}/api/storage/restore`, {
      method: "OPTIONS",
      headers: {
        Origin: "t3://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, x-f5-backup-password",
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe("t3://app");
    expect(preflightResponse.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflightResponse.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(preflightResponse.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, X-F5-Backup-Password, X-F5-Protocol, X-F5-File-Name, X-F5-Upload-Client",
    );

    // The exact headers `uploadAttachment` sends must survive the preflight.
    const uploadPreflight = await fetch(`${origin}/api/attachments/uploads?threadId=draft-cors`, {
      method: "OPTIONS",
      headers: {
        Origin: "t3://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization, content-type, x-f5-file-name, x-f5-protocol, x-f5-upload-client",
      },
    });
    expect(uploadPreflight.status).toBe(204);
    expect(uploadPreflight.headers.get("access-control-allow-origin")).toBe("t3://app");

    const unauthenticatedResponse = await fetch(`${origin}/api/storage/backup`, {
      headers: { Origin: "t3://app" },
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect(unauthenticatedResponse.headers.get("access-control-allow-origin")).toBe("t3://app");

    const backupResponse = await fetch(`${origin}/api/storage/backup`, {
      headers: {
        Authorization: "Bearer secret-token",
        Origin: "t3://app",
      },
    });
    await backupResponse.arrayBuffer();
    expect(backupResponse.status).toBe(200);
    expect(backupResponse.headers.get("access-control-allow-origin")).toBe("t3://app");
    expect(backupResponse.headers.get("access-control-expose-headers")).toBe(
      "Content-Disposition, Content-Length",
    );
  });

  it("rejects desktop private-route preflights outside the exact CORS allowlist", async () => {
    server = await createTestServer({
      mode: "desktop",
      cwd: "/test",
      authToken: "secret-token",
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/api/storage/restore`;

    const disallowedOriginResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(disallowedOriginResponse.status).toBe(403);
    expect(disallowedOriginResponse.headers.get("access-control-allow-origin")).toBeNull();

    const disallowedHeaderResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "t3://app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, x-not-allowed",
      },
    });
    expect(disallowedHeaderResponse.status).toBe(403);
  });

  it("accepts the authenticated configured development origin", async () => {
    server = await createTestServer({
      cwd: "/test",
      authToken: "secret-token",
      devUrl: "http://localhost:5173",
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [authorizedWs] = await connectAndAwaitWelcome(port, "secret-token", {
      Origin: "http://localhost:5173",
    });
    connections.push(authorizedWs);
  });

  it("allows configured development origins to fetch private attachments", async () => {
    const stateDir = makeTempDir("t3code-state-development-cors-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-image.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("image-bytes"));
    server = await createTestServer({
      cwd: "/test",
      authToken: "secret-token",
      devUrl: "http://localhost:5173",
      stateDir,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/attachments/thread-image.png`;

    const imageElementResponse = await fetch(url, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(imageElementResponse.status).toBe(200);
    expect(imageElementResponse.headers.get("access-control-allow-origin")).toBeNull();
    expect(imageElementResponse.headers.get("vary")).toBe("Origin");

    const preflightResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );

    const attachmentResponse = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(Buffer.from(await attachmentResponse.arrayBuffer())).toEqual(Buffer.from("image-bytes"));
  });

  it("rejects foreign private-route CORS access in web mode", async () => {
    const stateDir = makeTempDir("t3code-state-web-cors-rejection-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-image.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("image-bytes"));
    server = await createTestServer({
      mode: "web",
      cwd: "/test",
      authToken: "secret-token",
      stateDir,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/attachments/thread-image.png`;

    const preflightResponse = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(preflightResponse.status).toBe(403);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBeNull();

    const attachmentResponse = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        Origin: "https://attacker.example",
      },
    });
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("prepares a complete backup before committing the download response", async () => {
    const stateDir = makeTempDir("t3code-state-backup-export-");
    server = await createTestServer({
      cwd: "/test",
      stateDir,
      persistenceLayer: makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/storage/backup`);
    const archive = await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-f5-backup");
    expect(Number(response.headers.get("content-length"))).toBe(archive.byteLength);
    expect(archive.byteLength).toBeGreaterThan(0);
  });

  it("returns an HTTP error when backup preparation fails before streaming", async () => {
    const stateDir = makeTempDir("t3code-state-backup-failure-");
    fs.writeFileSync(path.join(stateDir, "backup-staging"), "blocks staging directory creation");
    server = await createTestServer({ cwd: "/test", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/storage/backup`);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
  });

  it("exchanges remote auth tokens and protects private routes with long thread IDs", async () => {
    const stateDir = makeTempDir("t3code-state-auth-");
    const longThreadId = `thread-${"a".repeat(160)}`;
    const attachmentPath = path.join(stateDir, "attachments", longThreadId, "message-a", "0.txt");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "private attachment");

    server = await createTestServer({
      cwd: "/test",
      authToken: "secret-token",
      stateDir,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const attachmentUrl = `${origin}/attachments/${longThreadId}/message-a/0.txt`;

    const unauthenticatedResponse = await fetch(attachmentUrl);
    expect(unauthenticatedResponse.status).toBe(401);

    const invalidSessionResponse = await fetch(`${origin}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(invalidSessionResponse.status).toBe(401);

    const sessionResponse = await fetch(`${origin}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "secret-token" }),
    });
    expect(sessionResponse.status).toBe(204);
    const setCookie = sessionResponse.headers.get("set-cookie");
    expect(setCookie).toMatch(/f5_session(?:_[0-9a-f]{32})?=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const authenticatedResponse = await fetch(attachmentUrl, {
      headers: { Cookie: cookie ?? "" },
    });
    expect(authenticatedResponse.status).toBe(200);
    expect(await authenticatedResponse.text()).toBe("private attachment");

    const [authorizedWs] = await connectAndAwaitWelcome(port, undefined, {
      Cookie: cookie ?? "",
      Origin: origin,
    });
    connections.push(authorizedWs);

    await expect(
      connectWs(port, "secret-token", 1, { Origin: "https://attacker.example" }),
    ).rejects.toThrow("WebSocket connection failed");

    const logoutResponse = await fetch(`${origin}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie ?? "" },
    });
    expect(logoutResponse.status).toBe(204);
    expect((await fetch(attachmentUrl, { headers: { Cookie: cookie ?? "" } })).status).toBe(401);
  });
});
