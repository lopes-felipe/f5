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
} from "@modelcontextprotocol/sdk/types.js";
import type { ThreadId } from "@t3tools/contracts";

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
  readonly upstream: McpHubUpstream;
}

export class McpHubSlot {
  readonly id: string;
  readonly serverName: string;
  readonly threadId: ThreadId;
  readonly upstream: McpHubUpstream;
  private readonly token: Buffer;
  private readonly connections = new Map<string, DownstreamConnection>();
  private readonly pending = new Set<DownstreamConnection>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(options: McpHubSlotOptions) {
    this.id = options.id;
    this.serverName = options.serverName;
    this.threadId = options.threadId;
    this.upstream = options.upstream;
    this.token = Buffer.from(options.token);
    this.unsubscribe = options.upstream.onListChanged((change) => {
      for (const { server } of this.connections.values()) {
        const send =
          change === "tools"
            ? server.sendToolListChanged()
            : change === "resources"
              ? server.sendResourceListChanged()
              : server.sendPromptListChanged();
        void send.catch(() => undefined);
      }
    });
  }

  get connectionCount(): number {
    return this.connections.size;
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
    await Promise.race([
      this.upstream.ensureConnected().catch(() => undefined),
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
    const connections = [...this.connections.values(), ...this.pending];
    this.connections.clear();
    this.pending.clear();
    await Promise.allSettled(connections.map(({ server }) => server.close()));
  }

  private createServer(): Server {
    const upstream = this.upstream;
    const instructions = upstream.instructions();
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

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await upstreamCall(upstream, () => upstream.listTools());
      return { tools: upstream.filterTools(tools) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      if (!upstream.isToolAllowed(name))
        return toolError(`The tool '${name}' is turned off in F5's MCP settings.`);
      let client;
      try {
        client = await upstream.ensureConnected();
      } catch (error) {
        return toolError(upstream.redact(messageOf(error)));
      }
      const progressToken = request.params._meta?.progressToken;
      try {
        return (await client.callTool(request.params, undefined, {
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
      } catch (error) {
        // A lost session or revoked credential drops the connection for recovery; the
        // call itself is not replayed, since it may have had side effects.
        upstream.noteRequestFailure(client, error);
        if (extra.signal.aborted) throw error;
        return toolError(upstream.redact(messageOf(error)));
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.resources) return { resources: [] };
      return upstreamCall(upstream, () =>
        client.listResources(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.resources) return { resourceTemplates: [] };
      return upstreamCall(upstream, () =>
        client.listResourceTemplates(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.resources)
        throw new McpError(ErrorCode.MethodNotFound, "This server has no resources.");
      return upstreamCall(upstream, () =>
        client.readResource(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.prompts) return { prompts: [] };
      return upstreamCall(upstream, () =>
        client.listPrompts(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const client = await upstreamClient(upstream);
      if (!client.getServerCapabilities()?.prompts)
        throw new McpError(ErrorCode.MethodNotFound, "This server has no prompts.");
      return upstreamCall(upstream, () =>
        client.getPrompt(request.params, { signal: extra.signal }),
      );
    });

    server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The MCP server request failed.";
}

function writeError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}
