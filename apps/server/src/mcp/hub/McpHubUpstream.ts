/**
 * One upstream MCP connection owned by the F5 hub. F5 is the MCP client: it
 * spawns or dials the configured server, and provider sessions reach it only
 * through the hub's loopback endpoints.
 */
import { homedir } from "node:os";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerDefinition } from "@t3tools/contracts";
import { createMcpDiagnosticsSanitizer, isMcpCredentialKey } from "@t3tools/shared/mcpDiagnostics";
import { mcpBearerRedactionValues, mcpRemoteHeaders } from "@t3tools/shared/mcpTranslation";

import { ProbeStdioTransport } from "../McpProbe.ts";
import type { McpOAuthProvider } from "./McpOAuth.ts";

export const HUB_STDERR_LIMIT = 64 * 1024;
const HUB_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const HUB_RECONNECT_ATTEMPTS = 5;
const HUB_RECONNECT_BASE_MS = 1_000;
const HUB_RECONNECT_MAX_MS = 30_000;
export const HUB_SHARED_IDLE_MS = 5 * 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const MAX_LISTED_TOOLS = 1_000;

export type McpHubConnectionScope = "session" | "shared";

export type McpHubUpstreamState =
  | "idle"
  | "connecting"
  | "ready"
  | "retrying"
  | "failed"
  | "needs-auth"
  | "stopped";

export interface McpHubUpstreamSnapshot {
  readonly state: McpHubUpstreamState;
  readonly error?: string;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly protocolVersion?: string;
  readonly toolCount?: number;
  readonly resourceCount?: number;
  readonly promptCount?: number;
  readonly latencyMs?: number;
  readonly lastConnectedAt?: string;
  readonly attempts: number;
  readonly attachments: number;
}

export type McpHubListChange = "tools" | "resources" | "prompts";

export interface McpHubUpstreamOptions {
  readonly name: string;
  readonly definition: McpServerDefinition;
  readonly scope: McpHubConnectionScope;
  /** The account (provider process) environment, used for stdio children and `bearerTokenEnvVar`. */
  readonly environment: NodeJS.ProcessEnv;
  /** Working directory for stdio children without their own `cwd`, and the advertised root. */
  readonly cwd: string;
  readonly onChange?: () => void;
  /** Test seams. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly makeTransport?: (definition: McpServerDefinition) => Transport;
  /** OAuth for a remote server: refreshes tokens; a server without them reports needs-auth. */
  readonly authProvider?: McpOAuthProvider;
}

/** 401s from the SDK surface as UnauthorizedError (whose `name` stays "Error"), a `code` of 401, or only in the message. */
export function isMcpAuthError(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof Error && error.name === "UnauthorizedError") ||
    !!(error && typeof error === "object" && "code" in error && error.code === 401) ||
    /\b401\b|unauthorized/i.test(error instanceof Error ? error.message : "")
  );
}

/**
 * Failures that mean the live connection is gone even though the transport did not
 * close: streamable HTTP reports an expired session (404) or a dropped socket as a
 * failed request and stays open.
 */
export function isMcpConnectionLostError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === 404) return true;
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = `${error instanceof Error ? error.message : ""} ${cause}`;
  return /session not found|\b404\b|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|\bNot connected\b/i.test(
    message,
  );
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(HUB_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), HUB_RECONNECT_MAX_MS);
}

export class McpHubUpstream {
  readonly name: string;
  readonly definition: McpServerDefinition;
  readonly scope: McpHubConnectionScope;
  private readonly options: McpHubUpstreamOptions;
  private readonly sanitize: (text: string) => string;
  private state: McpHubUpstreamState = "idle";
  private client?: Client | undefined;
  private transport?: Transport | undefined;
  private connecting?: Promise<Client> | undefined;
  private lastError?: string | undefined;
  private serverInfo?: { name: string; version: string } | undefined;
  private protocolVersion?: string | undefined;
  private tools?: Tool[] | undefined;
  private toolsLoading?: Promise<Tool[]> | undefined;
  private resourceCount?: number | undefined;
  private promptCount?: number | undefined;
  private latencyMs?: number | undefined;
  private lastConnectedAt?: string | undefined;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout> | undefined;
  private idleTimer?: ReturnType<typeof setTimeout> | undefined;
  private attachments = 0;
  private generation = 0;
  private stderrTail = "";
  /** True once a connection was ready, so a later one tells providers to list again. */
  private everConnected = false;
  private readonly listeners = new Set<(change: McpHubListChange) => void>();

  constructor(options: McpHubUpstreamOptions) {
    this.options = options;
    this.name = options.name;
    this.definition = options.definition;
    this.scope = options.scope;
    const sanitizer = createMcpDiagnosticsSanitizer({ [options.name]: options.definition }, [
      ...mcpBearerRedactionValues(options.definition, options.environment),
      ...Object.entries(options.environment).flatMap(([name, value]) =>
        value && isMcpCredentialKey(name) ? [value] : [],
      ),
    ]);
    this.sanitize = (text) => sanitizer.text(text);
  }

  // ── Attachment bookkeeping ────────────────────────────────────────────

  /** A session endpoint now routes to this upstream. */
  retain(): void {
    // A shared connection that failed while nobody used it never retried; the next
    // session gets a fresh attempt instead of inheriting that failure.
    if (this.attachments === 0 && this.state === "failed") {
      this.state = "idle";
      this.attempts = 0;
      this.lastError = undefined;
    }
    this.attachments += 1;
    if (this.idleTimer) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.options.onChange?.();
  }

  /**
   * A session endpoint went away. Session-scoped upstreams stop at once; shared
   * ones stop after five idle minutes.
   */
  release(): void {
    this.attachments = Math.max(0, this.attachments - 1);
    this.options.onChange?.();
    if (this.attachments > 0) return;
    if (this.scope === "session") {
      void this.stop();
      return;
    }
    // Stopped (not idle), so the hub forgets the entry and its resolved environment.
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = undefined;
      if (this.attachments === 0) void this.stop();
    }, HUB_SHARED_IDLE_MS);
  }

  get attachmentCount(): number {
    return this.attachments;
  }

  onListChanged(listener: (change: McpHubListChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Status ────────────────────────────────────────────────────────────

  snapshot(): McpHubUpstreamSnapshot {
    return {
      state: this.state,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.serverInfo ? { serverInfo: this.serverInfo } : {}),
      ...(this.protocolVersion ? { protocolVersion: this.protocolVersion } : {}),
      ...(this.tools ? { toolCount: this.filterTools(this.tools).length } : {}),
      ...(this.resourceCount !== undefined ? { resourceCount: this.resourceCount } : {}),
      ...(this.promptCount !== undefined ? { promptCount: this.promptCount } : {}),
      ...(this.latencyMs !== undefined ? { latencyMs: this.latencyMs } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      attempts: this.attempts,
      attachments: this.attachments,
    };
  }

  /** Removes this server's configured secrets and credential-like values from text. */
  redact(text: string): string {
    return this.sanitize(text);
  }

  /** Sanitized stderr tail of a stdio server (at most 64 KiB). */
  readStderrTail(): string {
    const live = this.transport instanceof ProbeStdioTransport ? this.transport.stderrTail : "";
    return this.sanitize(live || this.stderrTail).slice(-HUB_STDERR_LIMIT);
  }

  capabilities(): ServerCapabilities | undefined {
    return this.client?.getServerCapabilities();
  }

  instructions(): string | undefined {
    return this.client?.getInstructions();
  }

  // ── Connection ────────────────────────────────────────────────────────

  /**
   * Connects on first use. While a retry is scheduled or after the retry budget
   * is spent, callers get the last error instead of a new attempt; `reconnect()`
   * starts over.
   */
  ensureConnected(): Promise<Client> {
    if (this.state === "ready" && this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    if (this.state === "retrying" || this.state === "failed" || this.state === "needs-auth")
      return Promise.reject(new Error(this.describeUnavailable()));
    return this.connect();
  }

  /** Drops the current connection and retry budget, then connects again. */
  /** The OAuth record this connection signs in with, if it uses OAuth. */
  get oauthKey(): string | undefined {
    return this.options.authProvider?.key;
  }

  async reconnect(): Promise<void> {
    await this.stop("restart");
    const generation = this.generation;
    this.attempts = 0;
    this.lastError = undefined;
    // Teardown awaited the old connection. If the last session left (or anything else
    // stopped or restarted this upstream) meanwhile, dialing again would start a server
    // nothing tracks.
    if (generation !== this.generation || this.state !== "idle" || this.attachments === 0) return;
    await this.connect().catch(() => undefined);
  }

  /** The live client, for attributing a request failure to the connection it used. */
  get liveClient(): Client | undefined {
    return this.state === "ready" ? this.client : undefined;
  }

  /**
   * A request on `client` failed. A lost session, dropped socket or revoked credential
   * leaves an HTTP transport open, so the connection is dropped here and recovered like
   * a crash (or moved to sign-in on a 401). The failed request is never replayed.
   */
  noteRequestFailure(client: Client | undefined, error: unknown): void {
    if (!client || client !== this.client || this.state !== "ready") return;
    if (!isMcpConnectionLostError(error) && !isMcpAuthError(error)) return;
    const transport = this.transport;
    // The old connection's close handler must not act on the replacement.
    this.generation += 1;
    this.handleFailure(error);
    void Promise.allSettled([client.close(), transport?.close()]);
  }

  async stop(reason: "idle" | "restart" | "stopped" = "stopped"): Promise<void> {
    this.generation += 1;
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.idleTimer) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = undefined;
    }
    const client = this.client;
    const transport = this.transport;
    if (transport instanceof ProbeStdioTransport) this.stderrTail = transport.stderrTail;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    this.tools = undefined;
    this.toolsLoading = undefined;
    this.state = reason === "stopped" ? "stopped" : "idle";
    this.options.onChange?.();
    await Promise.allSettled([client?.close(), transport?.close()]);
  }

  private connect(): Promise<Client> {
    const generation = ++this.generation;
    this.state = "connecting";
    this.options.onChange?.();
    const started = this.now();
    const attempt = (async () => {
      await this.options.authProvider?.prime();
      const transport = this.makeTransport();
      const client = new Client(
        { name: "f5-mcp-hub", version: "1.0.0" },
        { capabilities: { roots: { listChanged: true }, elicitation: {} } },
      );
      // Roots are the working directory this connection serves.
      client.setRequestHandler(ListRootsRequestSchema, () => ({
        roots: [{ uri: pathToFileUri(this.options.cwd), name: this.options.cwd }],
      }));
      // F5 has no elicitation surface for hub servers yet; declining keeps calls moving.
      client.setRequestHandler(ElicitRequestSchema, () => ({ action: "decline" as const }));
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.tools = undefined;
        this.toolsLoading = undefined;
        this.emit("tools");
      });
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
        this.emit("resources"),
      );
      client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
        this.emit("prompts"),
      );
      const setVersion = transport.setProtocolVersion?.bind(transport);
      transport.setProtocolVersion = (version) => {
        this.protocolVersion = version;
        setVersion?.(version);
      };
      this.transport = transport;
      try {
        await client.connect(transport, { timeout: this.startupTimeoutMs() });
      } catch (error) {
        await Promise.allSettled([client.close(), transport.close()]);
        throw error;
      }
      if (generation !== this.generation) {
        await Promise.allSettled([client.close(), transport.close()]);
        throw new Error("The connection was replaced.");
      }
      // Protocol wraps the transport's onclose to fail pending requests; hook the client's.
      client.onclose = () => this.handleUnexpectedClose(generation);
      this.client = client;
      this.state = "ready";
      this.attempts = 0;
      this.lastError = undefined;
      this.latencyMs = this.now() - started;
      this.lastConnectedAt = new Date().toISOString();
      const info = client.getServerVersion();
      this.serverInfo = info
        ? {
            name: this.sanitize(info.name).slice(0, 300),
            version: this.sanitize(info.version).slice(0, 128),
          }
        : undefined;
      this.options.onChange?.();
      // A replacement connection (after a crash, a lost session or Reconnect) may serve a
      // different catalog, for example after an upgrade: providers list again.
      if (this.everConnected)
        for (const change of ["tools", "resources", "prompts"] as const) this.emit(change);
      this.everConnected = true;
      void this.refreshCounts(client, generation);
      return client;
    })();
    this.connecting = attempt;
    attempt.then(
      () => {
        if (this.connecting === attempt) this.connecting = undefined;
      },
      (error: unknown) => {
        if (this.connecting === attempt) this.connecting = undefined;
        if (generation !== this.generation) return;
        this.handleFailure(error);
      },
    );
    return attempt;
  }

  private handleFailure(error: unknown): void {
    const transport = this.transport;
    if (transport instanceof ProbeStdioTransport) this.stderrTail = transport.stderrTail;
    this.client = undefined;
    this.transport = undefined;
    // The catalog belongs to the connection that failed.
    this.tools = undefined;
    this.toolsLoading = undefined;
    this.lastError = this.sanitize(
      error instanceof Error ? error.message : "The MCP server could not be reached.",
    ).slice(0, 2_000);
    if (isMcpAuthError(error)) {
      this.state = "needs-auth";
      this.options.onChange?.();
      return;
    }
    this.attempts += 1;
    // Retries run after 1, 2, 4, 8 and 16 seconds; the next failure is final.
    if (this.attempts > HUB_RECONNECT_ATTEMPTS || this.attachments === 0) {
      this.state = "failed";
      this.options.onChange?.();
      return;
    }
    this.state = "retrying";
    this.options.onChange?.();
    const generation = this.generation;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined;
      if (generation !== this.generation || this.state !== "retrying") return;
      this.connect().catch(() => undefined);
    }, reconnectDelayMs(this.attempts));
  }

  private handleUnexpectedClose(generation: number): void {
    if (generation !== this.generation || this.state !== "ready") return;
    this.handleFailure(new Error("The MCP server closed the connection."));
  }

  private async refreshCounts(client: Client, generation: number): Promise<void> {
    const capabilities = client.getServerCapabilities();
    try {
      if (capabilities?.tools) await this.listTools();
      if (capabilities?.resources) {
        const result = await client.listResources({}, { timeout: 10_000 });
        if (generation === this.generation) this.resourceCount = result.resources.length;
      }
      if (capabilities?.prompts) {
        const result = await client.listPrompts({}, { timeout: 10_000 });
        if (generation === this.generation) this.promptCount = result.prompts.length;
      }
    } catch {
      // Counts are informational; requests surface their own errors.
    }
    if (generation === this.generation) this.options.onChange?.();
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  /** All pages of the upstream tool list, cached until `tools/list_changed`. */
  async listTools(): Promise<Tool[]> {
    if (this.tools) return this.tools;
    if (this.toolsLoading) return this.toolsLoading;
    const loading = (async () => {
      const client = await this.ensureConnected();
      if (!client.getServerCapabilities()?.tools) return [];
      const tools: Tool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor && seen.has(cursor)) break;
        if (cursor) seen.add(cursor);
      } while (cursor && tools.length < MAX_LISTED_TOOLS);
      return tools.slice(0, MAX_LISTED_TOOLS);
    })();
    this.toolsLoading = loading;
    try {
      const tools = await loading;
      if (this.toolsLoading === loading) this.tools = tools;
      return tools;
    } finally {
      if (this.toolsLoading === loading) this.toolsLoading = undefined;
    }
  }

  /** Tools the user's enabled/disabled filters allow. */
  filterTools(tools: ReadonlyArray<Tool>): Tool[] {
    return tools.filter((tool) => this.isToolAllowed(tool.name));
  }

  isToolAllowed(toolName: string): boolean {
    const { enabledTools, disabledTools } = this.definition;
    if (enabledTools && !enabledTools.includes(toolName)) return false;
    if (disabledTools?.includes(toolName)) return false;
    return true;
  }

  /** Per-call timeout: the configured tool timeout, or ten minutes reset by progress. */
  toolTimeoutMs(): number {
    const seconds = this.definition.toolTimeoutSec;
    return seconds && seconds > 0 ? seconds * 1000 : 600_000;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private emit(change: McpHubListChange): void {
    for (const listener of this.listeners) listener(change);
    this.options.onChange?.();
  }

  private describeUnavailable(): string {
    const reason = this.lastError ?? "The MCP server is unavailable.";
    if (this.state === "needs-auth") return `Sign-in required: ${reason}`;
    if (this.state === "retrying") return `Reconnecting: ${reason}`;
    return reason;
  }

  /** How long connecting may take (the server's startup timeout, capped at two minutes). */
  startupTimeoutMs(): number {
    const seconds = this.definition.startupTimeoutSec;
    return seconds && seconds > 0
      ? Math.min(seconds * 1000, MAX_STARTUP_TIMEOUT_MS)
      : DEFAULT_STARTUP_TIMEOUT_MS;
  }

  private makeTransport(): Transport {
    if (this.options.makeTransport) return this.options.makeTransport(this.definition);
    const definition = this.definition;
    if (definition.type === "stdio")
      return new ProbeStdioTransport(
        definition.command,
        [...(definition.args ?? [])],
        { ...this.options.environment, ...definition.env },
        definition.cwd ?? this.options.cwd ?? this.options.environment.HOME ?? homedir(),
        { stderrLimit: HUB_STDERR_LIMIT, maxPendingBytes: HUB_MAX_MESSAGE_BYTES },
      );
    const headers = new Headers(mcpRemoteHeaders(definition, this.options.environment));
    const authProvider = this.options.authProvider;
    const options = { requestInit: { headers }, ...(authProvider ? { authProvider } : {}) };
    return definition.type === "sse"
      ? (new SSEClientTransport(new URL(definition.url), options) as Transport)
      : (new StreamableHTTPClientTransport(new URL(definition.url), options) as Transport);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = this.options.setTimer?.(callback, ms) ?? setTimeout(callback, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return timer;
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    (this.options.clearTimer ?? clearTimeout)(timer);
  }
}

/** `file:` URI for a local path on this platform (drive letters and `#`/`?` included). */
export function pathToFileUri(path: string): string {
  return pathToFileURL(path).href;
}
