/**
 * MCP over streamable HTTP for F5's loopback endpoints: every connection a client
 * opens gets its own SDK `Server`. The hub's endpoints and F5's built-in catalogs
 * both serve through this, so they negotiate the protocol version the same way, up
 * to the SDK's latest.
 *
 * @module mcp/McpHttpConnections
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

interface Connection {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
  /** HTTP exchanges still waiting for a reply on this connection. */
  readonly exchanges: Set<ServerResponse>;
}

export interface McpHttpConnectionsOptions {
  readonly createServer: () => Server;
  /** Past this, the oldest connections give way to new ones, so reconnects never run out. */
  readonly maxConnections: number;
  /** Runs when a connection's initialize succeeds, before it serves anything else. */
  readonly onInitialized?: (sessionId: string) => void;
}

export class McpHttpConnections {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Set<Connection>();
  private closed = false;

  constructor(private readonly options: McpHttpConnectionsOptions) {}

  get size(): number {
    return this.connections.size;
  }

  /** The SDK servers of the initialized connections, for list-changed notifications. */
  servers(): Server[] {
    return [...this.connections.values()].map((connection) => connection.server);
  }

  /** Closes every connection except `sessionId`. */
  closeOthers(sessionId: string): void {
    for (const [id, connection] of this.connections) {
      if (id === sessionId) continue;
      this.connections.delete(id);
      void connection.server.close().catch(() => undefined);
    }
  }

  /**
   * Serves one HTTP request. `parsedBody` is passed when the caller already read
   * the body.
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    if (this.closed) return writeMcpHttpError(response, 404, "This MCP endpoint is closed.");
    // Clients that accept only JSON (`t3 mcp-session-stdio`, some agents) get plain JSON
    // replies. The SDK insists on both media types, so the header is completed for it.
    const accept = String(request.headers.accept ?? "");
    const streams = accept.includes("text/event-stream");
    if (!streams || !accept.includes("application/json")) acceptBoth(request);
    const header = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId) {
      const connection = this.connections.get(sessionId);
      if (!connection) return writeMcpHttpError(response, 404, "Unknown or expired MCP session.");
      await serve(connection, request, response, parsedBody);
      return;
    }
    if (request.method !== "POST")
      return writeMcpHttpError(response, 400, "Initialize an MCP session with POST first.");
    while (this.connections.size >= this.options.maxConnections) {
      const [oldest, connection] = this.connections.entries().next().value!;
      this.connections.delete(oldest);
      void connection.server.close().catch(() => undefined);
    }
    const server = this.options.createServer();
    let connection: Connection;
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
        this.options.onInitialized?.(id);
      },
      onsessionclosed: (id) => {
        this.connections.delete(id);
      },
    });
    connection = { transport, server, exchanges: new Set() };
    this.pending.add(connection);
    server.onclose = () => {
      this.pending.delete(connection);
      if (transport.sessionId && this.connections.get(transport.sessionId) === connection)
        this.connections.delete(transport.sessionId);
      endExchanges(connection);
    };
    await server.connect(transport as Transport);
    await serve(connection, request, response, parsedBody);
    // Anything but a successful initialize leaves no session behind.
    if (!transport.sessionId) {
      this.pending.delete(connection);
      await server.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connections = [...this.connections.values(), ...this.pending];
    this.connections.clear();
    this.pending.clear();
    await Promise.allSettled(connections.map(({ server }) => server.close()));
  }
}

/** The SDK reads `rawHeaders`, so both views of the request's headers are rewritten. */
function acceptBoth(request: IncomingMessage): void {
  const value = "application/json, text/event-stream";
  request.headers.accept = value;
  const raw: string[] = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!;
    if (name.toLowerCase() !== "accept") raw.push(name, request.rawHeaders[index + 1]!);
  }
  request.rawHeaders = [...raw, "Accept", value];
}

async function serve(
  connection: Connection,
  request: IncomingMessage,
  response: ServerResponse,
  parsedBody: unknown,
): Promise<void> {
  connection.exchanges.add(response);
  response.once("close", () => connection.exchanges.delete(response));
  try {
    await connection.transport.handleRequest(request, response, parsedBody);
  } finally {
    connection.exchanges.delete(response);
  }
}

/**
 * In JSON mode the SDK never answers a request its closed connection was still
 * handling, so the client would wait forever. Those exchanges end here.
 */
function endExchanges(connection: Connection): void {
  for (const response of connection.exchanges)
    writeMcpHttpError(response, 404, "The MCP session ended before the request finished.");
  connection.exchanges.clear();
}

export function writeMcpHttpError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}
