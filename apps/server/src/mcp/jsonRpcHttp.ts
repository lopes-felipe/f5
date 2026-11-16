/**
 * Hand-rolled JSON-RPC over HTTP helpers shared by F5's loopback MCP servers
 * (the preview/computer server and the Agent Bridge listeners).
 *
 * @module mcp/jsonRpcHttp
 */
import type http from "node:http";

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("MCP request body is too large.");
  }
}

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

export function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

export function writeEmpty(response: http.ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
  });
  response.end();
}

export function readRequestBody(
  request: http.IncomingMessage,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    request.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        reject(new RequestBodyTooLargeError());
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

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A notification carries no id and expects no response. */
export function isJsonRpcNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined && typeof request.method === "string";
}
