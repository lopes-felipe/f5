/**
 * Shared transport for host-owned MCP servers exposed to provider sessions over
 * loopback HTTP. Each server issues per-session bearer tokens; the transport
 * only routes authenticated JSON-RPC to the owner's tool handler.
 */
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";

export const LOCAL_MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface LocalMcpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

export type LocalMcpToolCall = (
  token: string,
  name: string,
  rawArguments: unknown,
) => Promise<Record<string, unknown>>;

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function readBearerToken(request: http.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function isAllowedHostHeader(host: string | undefined, port: number | null): boolean {
  if (!host || port === null) return false;
  const normalized = host.toLowerCase();
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `[::1]:${port}`
  );
}

export function jsonRpcSuccess(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

export function writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function writeEmpty(response: http.ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
  });
  response.end();
}

export function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    request.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("MCP request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function toolResult(result: unknown): Record<string, unknown> {
  if (result === undefined || result === null) {
    return {
      structuredContent: { value: null },
      content: [{ type: "text", text: "null" }],
    };
  }
  return {
    structuredContent:
      typeof result === "object" && !Array.isArray(result) ? result : { value: result },
    content: [{ type: "text", text: safeJsonText(result) }],
  };
}

export function toolErrorResult(cause: unknown): Record<string, unknown> {
  const error =
    cause && typeof cause === "object" && "_tag" in cause
      ? (cause as { _tag: string; message?: string })
      : null;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error?.message ?? (cause instanceof Error ? cause.message : String(cause)),
      },
    ],
    structuredContent: error
      ? {
          error: {
            _tag: error._tag,
            message: error.message ?? String(cause),
          },
        }
      : undefined,
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function nextLocalMcpToken(): string {
  return randomBytes(32).toString("base64url");
}

export function nextLocalMcpEnvVarName(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "_").toUpperCase()}`;
}

/** Pick `baseName`, or the first `baseName_N` that does not collide. */
export function chooseLocalMcpServerName(
  baseName: string,
  existingServerNames?: ReadonlySet<string>,
): string {
  if (!existingServerNames?.has(baseName)) {
    return baseName;
  }
  let index = 2;
  while (existingServerNames.has(`${baseName}_${index}`)) {
    index += 1;
  }
  return `${baseName}_${index}`;
}

export function handleLocalMcpRpcRequest(input: {
  readonly request: JsonRpcRequest;
  readonly token: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly tools: ReadonlyArray<LocalMcpToolDefinition>;
  readonly callTool: LocalMcpToolCall;
}): Promise<JsonRpcResponse | null> {
  const { request } = input;
  if (request.id === undefined && request.method?.startsWith("notifications/")) {
    return Promise.resolve(null);
  }
  if (typeof request.method !== "string") {
    return Promise.resolve(jsonRpcError(request.id, -32600, "Invalid JSON-RPC request."));
  }

  switch (request.method) {
    case "initialize":
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          protocolVersion: LOCAL_MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: input.serverInfo,
        }),
      );
    case "ping":
      return Promise.resolve(jsonRpcSuccess(request.id, {}));
    case "tools/list":
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          tools: input.tools.map(({ title, ...tool }) => ({
            ...tool,
            annotations: {
              ...tool.annotations,
              title,
            },
          })),
        }),
      );
    case "tools/call": {
      const params = asObject(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      return input
        .callTool(input.token, name, params.arguments)
        .then((result) => jsonRpcSuccess(request.id, result));
    }
    case "resources/list":
      return Promise.resolve(jsonRpcSuccess(request.id, { resources: [] }));
    case "prompts/list":
      return Promise.resolve(jsonRpcSuccess(request.id, { prompts: [] }));
    default:
      return Promise.resolve(
        jsonRpcError(request.id, -32601, `Unknown MCP method: ${request.method}`),
      );
  }
}

export interface LocalMcpHttpServerHandle {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Listen on an ephemeral loopback port. Requests must come from loopback with
 * the exact loopback Host header (DNS-rebinding guard) and a live bearer token.
 */
export function startLocalMcpHttpServer(input: {
  readonly endpointPath: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly tools: ReadonlyArray<LocalMcpToolDefinition>;
  readonly isValidToken: (token: string) => boolean;
  readonly callTool: LocalMcpToolCall;
}): Promise<LocalMcpHttpServerHandle> {
  let expectedHostPort: number | null = null;
  const server = http.createServer((request, response) => {
    void (async () => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        writeJson(response, 403, { error: "forbidden" });
        return;
      }
      if (!isAllowedHostHeader(request.headers.host, expectedHostPort)) {
        writeJson(response, 403, { error: "invalid_host" });
        return;
      }
      if (request.url !== input.endpointPath) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const token = readBearerToken(request);
      if (!token || !input.isValidToken(token)) {
        response.setHeader("www-authenticate", "Bearer");
        writeJson(response, 401, { error: "invalid_mcp_credential" });
        return;
      }

      let body: unknown;
      try {
        body = await readRequestBody(request);
      } catch (cause) {
        writeJson(response, 400, {
          error: "invalid_json",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }

      const requests = Array.isArray(body) ? body : [body];
      const results = (
        await Promise.all(
          requests.map((entry) =>
            handleLocalMcpRpcRequest({
              request: asObject(entry) as JsonRpcRequest,
              token,
              serverInfo: input.serverInfo,
              tools: input.tools,
              callTool: input.callTool,
            }),
          ),
        )
      ).filter((entry): entry is JsonRpcResponse => entry !== null);

      if (Array.isArray(body)) {
        if (results.length === 0) {
          writeEmpty(response, 202);
          return;
        }
        writeJson(response, 200, results);
        return;
      }
      const result = results[0];
      if (!result) {
        writeEmpty(response, 202);
        return;
      }
      writeJson(response, 200, result);
    })().catch((cause) => {
      writeJson(response, 500, {
        error: "internal_error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });
  });

  return new Promise<LocalMcpHttpServerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo | null;
      const port = address?.port;
      if (!port) {
        server.close();
        reject(new Error("Local MCP server did not expose a port."));
        return;
      }
      expectedHostPort = port;
      resolve({
        url: `http://127.0.0.1:${port}${input.endpointPath}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
