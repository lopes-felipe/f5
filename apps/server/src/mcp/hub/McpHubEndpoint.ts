/**
 * The loopback endpoint a provider session uses to reach one hub server. Each
 * endpoint ("slot") has its own bearer credential; every MCP connection the
 * provider opens on it gets its own SDK `Server`, which forwards to the shared
 * or session upstream.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServerDefinition,
  McpToolCallApproval,
  McpToolCallOutcome,
  ProjectId,
  ProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import { mcpToolPolicy } from "@t3tools/shared/mcpTools";

import {
  mcpServerIdentity,
  summarizeToolError,
  type McpHubGovernance,
  type McpServerIdentity,
  type McpToolApprovalReason,
} from "./McpHubGovernance.ts";
import type { McpHubUpstream } from "./McpHubUpstream.ts";

/** A provider rarely holds more than one connection per endpoint; reconnects replace it. */
const MAX_CONNECTIONS_PER_SLOT = 4;
/** How long a provider's initialize waits for the upstream, to forward its instructions. */
const INSTRUCTIONS_WAIT_MS = 5_000;

interface DownstreamConnection {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
}

export interface McpHubSlotOptions {
  readonly id: string;
  readonly token: string;
  readonly serverName: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly projectId?: ProjectId | undefined;
  readonly upstream: McpHubUpstream;
  /** This session's definition: its tool policy can differ from a shared upstream's. */
  readonly definition: McpServerDefinition;
  readonly governance?: McpHubGovernance | undefined;
}

export class McpHubSlot {
  readonly id: string;
  readonly serverName: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  private readonly projectId: ProjectId | undefined;
  private current: McpHubUpstream | undefined;
  private definition: McpServerDefinition;
  private identity: McpServerIdentity;
  private readonly governance: McpHubGovernance | undefined;
  private readonly token: Buffer;
  private readonly connections = new Map<string, DownstreamConnection>();
  private readonly pending = new Set<DownstreamConnection>();
  private unsubscribe: () => void = () => undefined;
  private readonly unsubscribeThread: () => void;
  private closed = false;
  private generation = 0;

  constructor(options: McpHubSlotOptions) {
    this.id = options.id;
    this.serverName = options.serverName;
    this.threadId = options.threadId;
    this.provider = options.provider;
    this.projectId = options.projectId;
    this.governance = options.governance;
    this.token = Buffer.from(options.token);
    this.definition = options.definition;
    this.identity = mcpServerIdentity(options.serverName, options.definition);
    this.bind(options.upstream);
    // A server turned off (or on) for this conversation lists again without a restart.
    this.unsubscribeThread =
      options.governance?.onThreadServersChanged((threadId) => {
        if (threadId !== this.threadId) return;
        for (const change of ["tools", "resources", "prompts"] as const) this.notify(change);
      }) ?? (() => undefined);
  }

  /** Applies a saved definition's tool policy; connection changes go through `rebind`. */
  setDefinition(definition: McpServerDefinition): void {
    this.definition = definition;
    this.identity = mcpServerIdentity(this.serverName, definition);
  }

  /** The conversation's project, for refreshing tool policy when its settings are saved. */
  get sessionProjectId(): ProjectId | undefined {
    return this.projectId;
  }

  /**
   * Takes only the tool policy from a saved definition, so a save reaches a live
   * session without Apply. Connection settings keep waiting for Apply or a restart.
   */
  setToolPolicy(source: Pick<McpServerDefinition, "toolPolicy" | "defaultToolPolicy">): void {
    const {
      toolPolicy: _toolPolicy,
      defaultToolPolicy: _defaultToolPolicy,
      ...rest
    } = this.definition;
    this.definition = {
      ...rest,
      ...(source.toolPolicy ? { toolPolicy: source.toolPolicy } : {}),
      ...(source.defaultToolPolicy ? { defaultToolPolicy: source.defaultToolPolicy } : {}),
    } as McpServerDefinition;
  }

  private disabledHere(): boolean {
    return this.governance?.isServerDisabled(this.threadId, this.serverName) ?? false;
  }

  /** Why F5 asks before running `toolName` in this conversation; undefined when it runs at once. */
  private approvalReason(toolName: string): McpToolApprovalReason | undefined {
    if (this.governance?.pinState(this.serverName, this.identity, toolName) === "changed")
      return "changed";
    if (mcpToolPolicy(this.definition, toolName) !== "ask") return undefined;
    if (this.governance?.allowedForSession(this.threadId, this.serverName, toolName))
      return undefined;
    return "policy";
  }

  /**
   * True when F5 will ask before running this tool, so a provider's own prompt for the
   * same call can be answered without showing it.
   */
  asksBeforeCall(toolName: string): boolean {
    const upstream = this.current;
    if (!upstream || this.disabledHere() || !upstream.isToolAllowed(toolName)) return false;
    return this.approvalReason(toolName) !== undefined;
  }

  private record(
    toolName: string,
    outcome: McpToolCallOutcome,
    approval: McpToolCallApproval,
    startedAt: number,
    errorSummary?: string,
  ): void {
    this.governance?.recordCall({
      threadId: this.threadId,
      projectId: this.projectId,
      provider: this.provider,
      serverName: this.serverName,
      toolName,
      outcome,
      durationMs: Math.max(0, Math.round(Date.now() - startedAt)),
      approval,
      ...(errorSummary ? { errorSummary: summarizeToolError(errorSummary) } : {}),
    });
  }

  /** Lists through the upstream's filters and pins what the server reported. */
  private async listAllowedTools(upstream: McpHubUpstream): Promise<Tool[]> {
    const tools = await upstreamCall(upstream, () => upstream.listTools());
    this.governance?.observeTools(this.serverName, this.identity, tools);
    return upstream.filterTools(tools);
  }

  /** The upstream this endpoint forwards to; none once its server was removed. */
  get upstream(): McpHubUpstream | undefined {
    return this.current;
  }

  /**
   * Changes whenever the endpoint is re-bound, so an MCP App approval reviewed
   * against one connection never authorizes a call on its replacement.
   */
  get binding(): string {
    return `${this.id}:${this.generation}`;
  }

  /**
   * Points the endpoint at another upstream (a saved change) or at none (the server
   * was removed), keeping the provider's connection. Providers are told the lists
   * changed so they list again.
   */
  rebind(upstream: McpHubUpstream | undefined): void {
    if (this.closed || upstream === this.current) return;
    this.bind(upstream);
    for (const change of ["tools", "resources", "prompts"] as const) this.notify(change);
  }

  private bind(upstream: McpHubUpstream | undefined): void {
    this.unsubscribe();
    this.generation += 1;
    this.current = upstream;
    this.unsubscribe = upstream
      ? upstream.onListChanged((change) => this.notify(change))
      : () => undefined;
  }

  private notify(change: "tools" | "resources" | "prompts"): void {
    for (const { server } of this.connections.values()) {
      const send =
        change === "tools"
          ? server.sendToolListChanged()
          : change === "resources"
            ? server.sendResourceListChanged()
            : server.sendPromptListChanged();
      void send.catch(() => undefined);
    }
  }

  /** The current upstream, or an error explaining that the server was removed. */
  private requireUpstream(): McpHubUpstream {
    if (this.closed) throw new McpError(ErrorCode.InvalidRequest, "This MCP endpoint is closed.");
    if (this.current) return this.current;
    throw new McpError(
      ErrorCode.InvalidRequest,
      `'${this.serverName}' was removed from F5's MCP settings.`,
    );
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** MCP Apps: the tools this session's provider sees, read from the hub directly. */
  async appListTools(): Promise<Tool[]> {
    if (!this.current || this.disabledHere()) return [];
    const upstream = this.requireUpstream();
    return this.listAllowedTools(upstream);
  }

  /**
   * MCP Apps: one tool call on this session's connection, with the server's own timeout.
   * The user drives these from the app's own view, so F5 does not ask again.
   */
  async appCallTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const upstream = this.requireUpstream();
    if (this.disabledHere()) throw new McpError(ErrorCode.InvalidRequest, this.turnedOffMessage());
    if (!upstream.isToolAllowed(name))
      throw new McpError(
        ErrorCode.InvalidRequest,
        `The tool '${name}' is turned off in F5's MCP settings.`,
      );
    const client = await upstreamClient(upstream);
    const startedAt = Date.now();
    // Tracked like a provider call, so a question the server asks meanwhile is never
    // forwarded to another conversation (an app has no way to answer it, so it is declined).
    const release = upstream.trackCall({ threadId: this.threadId, startedAt });
    try {
      const result = await upstreamCall(
        upstream,
        async () =>
          (await client.callTool({ name, arguments: args }, undefined, {
            signal,
            timeout: upstream.toolTimeoutMs(),
            resetTimeoutOnProgress: true,
          })) as CallToolResult,
      );
      this.record(name, result.isError ? "error" : "ok", "policy", startedAt);
      return result;
    } catch (error) {
      this.record(
        name,
        signal.aborted ? "cancelled" : "error",
        "policy",
        startedAt,
        messageOf(error),
      );
      throw error;
    } finally {
      release();
    }
  }

  private turnedOffMessage(): string {
    return `'${this.serverName}' is turned off for this conversation.`;
  }

  /** MCP Apps: reads a `ui://` resource on this session's connection. */
  async appReadResource(uri: string, signal: AbortSignal): Promise<ReadResourceResult> {
    const upstream = this.requireUpstream();
    const client = await upstreamClient(upstream);
    if (!client.getServerCapabilities()?.resources)
      throw new McpError(ErrorCode.MethodNotFound, "This server has no resources.");
    return upstreamCall(upstream, () => client.readResource({ uri }, { signal }));
  }

  authorizes(token: string | null | undefined): boolean {
    if (!token || this.closed) return false;
    const candidate = Buffer.from(token);
    return candidate.length === this.token.length && timingSafeEqual(candidate, this.token);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed) return writeError(response, 404, "This MCP endpoint is closed.");
    // Clients that only accept JSON (`t3 mcp-session-stdio`, some agents) get plain JSON
    // replies. The SDK insists on both media types, so the header is completed for it.
    const accept = String(request.headers.accept ?? "");
    const streams = accept.includes("text/event-stream");
    if (!streams || !accept.includes("application/json"))
      request.headers.accept = "application/json, text/event-stream";
    const header = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId) {
      const connection = this.connections.get(sessionId);
      if (!connection) return writeError(response, 404, "Unknown or expired MCP session.");
      await connection.transport.handleRequest(request, response);
      return;
    }
    if (request.method !== "POST")
      return writeError(response, 400, "Initialize an MCP session with POST first.");
    // The server's instructions arrive with the upstream's own initialize. Wait briefly
    // so the provider's first connection carries them; a slow server never stalls it long.
    // An unbound slot has no instructions to wait for.
    await Promise.race([
      (this.upstream?.ensureConnected() ?? Promise.resolve()).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, INSTRUCTIONS_WAIT_MS).unref()),
    ]);
    // Oldest connections give way to new ones, so reconnects never exhaust the slot.
    while (this.connections.size >= MAX_CONNECTIONS_PER_SLOT) {
      const [oldest, connection] = this.connections.entries().next().value!;
      this.connections.delete(oldest);
      void connection.server.close().catch(() => undefined);
    }
    const server = this.createServer();
    let connection: DownstreamConnection;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: !streams,
      onsessioninitialized: (id) => {
        this.pending.delete(connection);
        if (this.closed) {
          void server.close().catch(() => undefined);
          return;
        }
        this.connections.set(id, connection);
      },
      onsessionclosed: (id) => {
        this.connections.delete(id);
      },
    });
    connection = { transport, server };
    this.pending.add(connection);
    server.onclose = () => {
      this.pending.delete(connection);
      if (transport.sessionId && this.connections.get(transport.sessionId) === connection)
        this.connections.delete(transport.sessionId);
    };
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response);
    // Anything but a successful initialize leaves no session behind.
    if (!transport.sessionId) {
      this.pending.delete(connection);
      await server.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeThread();
    const connections = [...this.connections.values(), ...this.pending];
    this.connections.clear();
    this.pending.clear();
    await Promise.allSettled(connections.map(({ server }) => server.close()));
  }

  private createServer(): Server {
    const instructions = this.current?.instructions();
    // Capabilities are advertised up front so a provider's initialize never waits on
    // the upstream; requests connect it on demand.
    const server = new Server(
      { name: this.serverName, version: "1.0.0" },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
          completions: {},
        },
        ...(instructions ? { instructions } : {}),
      },
    );

    // Handlers read the upstream per request, so a re-bound endpoint serves the new one.
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const upstream = this.current;
      if (!upstream || this.disabledHere()) return { tools: [] };
      return { tools: await this.listAllowedTools(upstream) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const upstream = this.current;
      const name = request.params.name;
      const receivedAt = Date.now();
      if (!upstream) return toolError(`'${this.serverName}' was removed from F5's MCP settings.`);
      if (this.disabledHere()) {
        this.record(name, "turned-off", "policy", receivedAt);
        return toolError(this.turnedOffMessage());
      }
      if (!upstream.isToolAllowed(name)) {
        this.record(name, "blocked", "policy", receivedAt);
        return toolError(`The tool '${name}' is turned off in F5's MCP settings.`);
      }
      let client;
      try {
        client = await upstream.ensureConnected();
      } catch (error) {
        const message = upstream.redact(messageOf(error));
        this.record(name, "error", "policy", receivedAt, message);
        return toolError(message);
      }
      let approval: McpToolCallApproval =
        mcpToolPolicy(this.definition, name) === "ask" ? "session" : "policy";
      const reason = this.approvalReason(name);
      if (reason) {
        if (!this.governance) {
          this.record(name, "declined", "asked", receivedAt);
          return toolError(
            `F5 asks before running '${name}', but cannot ask in this conversation, so the call was not run.`,
          );
        }
        const decision = await this.governance.requestApproval({
          threadId: this.threadId,
          provider: this.provider,
          serverName: this.serverName,
          toolName: name,
          reason,
          signal: extra.signal,
        });
        if (decision !== "accept" && decision !== "acceptForSession") {
          this.record(name, decision === "cancel" ? "cancelled" : "declined", "asked", receivedAt);
          if (extra.signal.aborted) throw new McpError(ErrorCode.RequestTimeout, "Cancelled.");
          return toolError(
            decision === "cancel"
              ? `The call to '${name}' was cancelled before it ran.`
              : `The user declined the call to '${name}'.`,
          );
        }
        if (decision === "acceptForSession" && reason === "policy")
          this.governance.allowForSession(this.threadId, this.serverName, name);
        approval = "asked";
      }
      const startedAt = Date.now();
      const progressToken = request.params._meta?.progressToken;
      const elicitation = server.getClientCapabilities()?.elicitation as
        | { readonly url?: object }
        | undefined;
      const release = upstream.trackCall({
        threadId: this.threadId,
        startedAt,
        ...(elicitation
          ? {
              elicit: async (params, signal) => {
                if (params.mode === "url" && !elicitation.url) return { action: "decline" };
                // A person may take a while: the question may use the call's remaining
                // time, not the SDK's 60 s request default.
                const remaining = startedAt + upstream.toolTimeoutMs() - Date.now();
                return server.elicitInput(params, {
                  signal,
                  relatedRequestId: extra.requestId,
                  timeout: Math.max(1_000, remaining),
                });
              },
              ...(elicitation.url
                ? {
                    completeElicitation: (elicitationId: string) => {
                      void server
                        .createElicitationCompletionNotifier(elicitationId)()
                        .catch(() => undefined);
                    },
                  }
                : {}),
            }
          : {}),
      });
      try {
        const result = (await client.callTool(request.params, undefined, {
          signal: extra.signal,
          timeout: upstream.toolTimeoutMs(),
          resetTimeoutOnProgress: true,
          ...(progressToken !== undefined
            ? {
                onprogress: (progress) => {
                  void extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: { ...progress, progressToken },
                    })
                    .catch(() => undefined);
                },
              }
            : {}),
        })) as CallToolResult;
        this.record(
          name,
          result.isError ? "error" : "ok",
          approval,
          startedAt,
          result.isError ? upstream.redact(toolErrorText(result)) : undefined,
        );
        return result;
      } catch (error) {
        // A lost session or revoked credential drops the connection for recovery; the
        // call itself is not replayed, since it may have had side effects.
        upstream.noteRequestFailure(client, error);
        const message = upstream.redact(messageOf(error));
        this.record(
          name,
          extra.signal.aborted ? "cancelled" : "error",
          approval,
          startedAt,
          message,
        );
        if (extra.signal.aborted) throw error;
        return toolError(message);
      } finally {
        release();
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
      if (!this.current) return { resources: [] };
      const upstream = this.requireUpstream();
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.resources) return { resources: [] };
      return upstreamCall(upstream, () =>
        client.listResources(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
      if (!this.current) return { resourceTemplates: [] };
      const upstream = this.requireUpstream();
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.resources) return { resourceTemplates: [] };
      return upstreamCall(upstream, () =>
        client.listResourceTemplates(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const upstream = this.requireUpstream();
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.resources)
        throw new McpError(ErrorCode.MethodNotFound, "This server has no resources.");
      return upstreamCall(upstream, () =>
        client.readResource(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
      if (!this.current) return { prompts: [] };
      const upstream = this.requireUpstream();
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.prompts) return { prompts: [] };
      return upstreamCall(upstream, () =>
        client.listPrompts(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const upstream = this.requireUpstream();
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.prompts)
        throw new McpError(ErrorCode.MethodNotFound, "This server has no prompts.");
      return upstreamCall(upstream, () =>
        client.getPrompt(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
      const upstream = this.requireUpstream();
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.completions)
        return { completion: { values: [], hasMore: false } };
      return upstreamCall(upstream, () =>
        client.complete(request.params, { signal: extra.signal }),
      );
    });

    return server;
  }
}

async function upstreamClient(upstream: McpHubUpstream) {
  return upstreamCall(upstream, () => upstream.ensureConnected());
}

/**
 * Upstream failures reach the provider as redacted JSON-RPC errors. Structured `data`
 * is dropped: it can echo credentials that message redaction would not see.
 */
async function upstreamCall<T>(upstream: McpHubUpstream, run: () => Promise<T>): Promise<T> {
  const client = upstream.liveClient;
  try {
    return await run();
  } catch (error) {
    upstream.noteRequestFailure(client, error);
    if (error instanceof McpError) throw new McpError(error.code, upstream.redact(error.message));
    throw new McpError(ErrorCode.InternalError, upstream.redact(messageOf(error)));
  }
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** The first text block of an error result, for the call log's summary. */
function toolErrorText(result: CallToolResult): string {
  const block = result.content?.find((entry) => entry.type === "text");
  return block && "text" in block && typeof block.text === "string"
    ? block.text
    : "The tool reported an error.";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The MCP server request failed.";
}

function writeError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}
