/**
 * Agent Bridge HTTP listeners. Both bind 127.0.0.1 and are separate from the
 * app/WS port. The local listener accepts only the rotating local token and
 * is reached through the STDIO shim; it is never tunneled. The remote listener
 * accepts only OAuth access tokens, serves the OAuth routes, and is the only
 * port a user tunnels.
 *
 * Shared rules: unknown routes return 404, a missing or invalid credential
 * returns 401, browser origins are rejected, and F5 cookies or the server
 * master token are never accepted.
 *
 * @module agentBridge/AgentBridgeListeners
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Exit, Fiber } from "effect";

import {
  isAllowedHostHeader,
  isLoopbackAddress,
  jsonRpcError,
  readBearerToken,
  readRequestBody,
  RequestBodyTooLargeError,
  writeEmpty,
  writeJson,
  type JsonRpcRequest,
} from "../mcp/jsonRpcHttp.ts";
import {
  writeAgentBridgeLocalCredentials,
  removeAgentBridgeLocalCredentials,
} from "./localCredentials.ts";
import {
  assertMcpVersion,
  handleMcpRequest,
  UnsupportedMcpVersionError,
  type McpRequestContext,
} from "./mcpProtocol.ts";
import type { AgentBridgeCaller, AgentBridgeToolDefinition } from "./threadTools.ts";

export const AGENT_BRIDGE_MCP_PATH = "/mcp";

export interface McpListenerOptions {
  /** Resolves a bearer token to its caller, or null when it is not valid here. */
  readonly authenticate: (token: string) => Promise<AgentBridgeCaller | null>;
  readonly tools: () => ReadonlyArray<AgentBridgeToolDefinition>;
  readonly serverVersion: string;
  readonly port?: number;
  /** Headers added to 401 responses (the remote listener's resource metadata). */
  readonly unauthorizedHeaders?: Readonly<Record<string, string>>;
  readonly eventsCapability?: (caller: AgentBridgeCaller) => Record<string, unknown> | undefined;
  readonly events?: McpRequestContext["events"];
  /** Extra Host header values accepted besides loopback (the tunnel's public host). */
  readonly allowedHosts?: () => ReadonlyArray<string>;
  /** Non-MCP routes (OAuth); returns true when it handled the request. */
  readonly routes?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname: string,
  ) => Promise<boolean>;
}

export interface McpListener {
  readonly port: number;
  readonly close: () => Promise<void>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function startMcpListener(options: McpListenerOptions): Promise<McpListener> {
  let expectedPort: number | null = null;
  const server = http.createServer((request, response) => {
    void (async () => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        writeJson(response, 403, { error: "forbidden" });
        return;
      }
      const host = request.headers.host?.toLowerCase();
      if (
        !isAllowedHostHeader(host, expectedPort) &&
        !(host !== undefined && (options.allowedHosts?.() ?? []).includes(host))
      ) {
        writeJson(response, 403, { error: "invalid_host" });
        return;
      }
      // MCP clients are not browsers; no CORS is offered, and any page origin is refused.
      if (request.headers.origin !== undefined) {
        writeJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      const pathname = (request.url ?? "").split("?")[0] ?? "";
      if (pathname !== AGENT_BRIDGE_MCP_PATH && options.routes) {
        if (await options.routes(request, response, pathname)) return;
      }
      if (pathname !== AGENT_BRIDGE_MCP_PATH) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const token = readBearerToken(request);
      const caller = token === null ? null : await options.authenticate(token);
      if (!caller) {
        writeJson(
          response,
          401,
          { error: "invalid_token" },
          {
            "www-authenticate": "Bearer",
            ...options.unauthorizedHeaders,
          },
        );
        return;
      }

      let body: unknown;
      try {
        body = await readRequestBody(request);
      } catch (cause) {
        if (cause instanceof RequestBodyTooLargeError) {
          writeJson(response, 413, { error: "request_too_large" });
          return;
        }
        writeJson(response, 400, jsonRpcError(null, -32700, "Parse error."));
        return;
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        writeJson(
          response,
          400,
          jsonRpcError(null, -32600, "Send one JSON-RPC message per request."),
        );
        return;
      }
      const rpc = body as JsonRpcRequest;
      const protocolVersionHeader = headerValue(request.headers["mcp-protocol-version"]);
      try {
        assertMcpVersion(rpc, protocolVersionHeader);
      } catch (cause) {
        if (cause instanceof UnsupportedMcpVersionError) {
          writeJson(response, 400, jsonRpcError(rpc.id ?? null, -32600, cause.message));
          return;
        }
        throw cause;
      }

      const eventsCapability = options.eventsCapability?.(caller);
      const context: McpRequestContext = {
        caller,
        protocolVersionHeader,
        serverVersion: options.serverVersion,
        ...(eventsCapability ? { eventsCapability } : {}),
        ...(eventsCapability && options.events ? { events: options.events } : {}),
      };
      const fiber = Effect.runFork(handleMcpRequest(rpc, options.tools(), context));
      // A disconnect interrupts the call (for example a long wait_for_submission).
      const onClose = () => {
        if (!response.writableEnded) Effect.runFork(Fiber.interrupt(fiber));
      };
      response.once("close", onClose);
      const exit = await Effect.runPromise(Fiber.await(fiber));
      response.off("close", onClose);
      if (response.destroyed || response.writableEnded) return;
      if (Exit.isFailure(exit)) {
        writeJson(response, 500, jsonRpcError(rpc.id ?? null, -32603, "Internal error."));
        return;
      }
      if (exit.value === null) {
        writeEmpty(response, 202);
        return;
      }
      writeJson(response, 200, exit.value);
    })().catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: "internal_error" });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address?.port) {
    server.close();
    throw new Error("The Agent Bridge listener did not expose a port.");
  }
  expectedPort = address.port;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export function tokensEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface LocalListener extends McpListener {
  readonly token: string;
  readonly startedAt: string;
}

/**
 * Starts the local listener with a fresh 32-byte token and publishes
 * `local.json`. Closing removes the file (when it still names this token).
 */
export async function startLocalListener(input: {
  readonly credentialsPath: string;
  readonly resolveLocalCaller: () => Promise<AgentBridgeCaller | null>;
  readonly tools: () => ReadonlyArray<AgentBridgeToolDefinition>;
  readonly serverVersion: string;
}): Promise<LocalListener> {
  const token = randomBytes(32).toString("base64url");
  const startedAt = new Date().toISOString();
  const listener = await startMcpListener({
    authenticate: async (provided) =>
      tokensEqual(token, provided) ? input.resolveLocalCaller() : null,
    tools: input.tools,
    serverVersion: input.serverVersion,
  });
  try {
    await writeAgentBridgeLocalCredentials(input.credentialsPath, {
      port: listener.port,
      token,
      startedAt,
      serverPid: process.pid,
    });
  } catch (cause) {
    await listener.close();
    throw cause;
  }
  return {
    ...listener,
    token,
    startedAt,
    close: async () => {
      await removeAgentBridgeLocalCredentials(input.credentialsPath, token).catch(() => undefined);
      await listener.close();
    },
  };
}
