import {
  ThreadMcpBroker,
  callThreadTool,
  THREAD_TOOL_DEFINITIONS,
  THREAD_TOOL_TIMEOUT_MS,
  threadToolInputJsonSchema,
} from "./threadMcpTools.ts";
import type { ComputerAgentProvider } from "@t3tools/shared/agentAutomationSupport";
import {
  createComputerSessionScope,
  type ComputerSessionScope,
} from "../computer/ComputerSessionScope";
import {
  ComputerAutomationBroker,
  type ComputerAutomationBrokerRuntime,
} from "../computer/ComputerAutomationBroker";
import {
  callComputerTool,
  COMPUTER_TOOL_DEFINITIONS,
  COMPUTER_GUIDANCE,
  COMPUTER_TOOL_TIMEOUT_MS,
  ComputerToolGeometry,
  computerToolInputJsonSchema,
} from "../computer/computerMcpTools";
import { Option } from "effect";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";

import {
  type McpServerDefinition,
  PreviewAutomationExecutionError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { Data, Effect, Layer, ServiceMap } from "effect";

import {
  PreviewAutomationBroker,
  type PreviewAutomationBrokerShape,
} from "./PreviewAutomationBroker.ts";
import {
  INTEGRATION_TOOL_TIMEOUT_SEC,
  type IntegrationProxySession,
} from "./IntegrationProxyCatalog.ts";
import {
  asObject,
  isAllowedHostHeader,
  isLoopbackAddress,
  jsonRpcError,
  jsonRpcSuccess,
  readBearerToken,
  readRequestBody,
  writeEmpty,
  writeJson,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonRpcHttp.ts";
import {
  callPreviewTool,
  chooseServerName,
  PREVIEW_TOOL_DEFINITIONS,
  PREVIEW_TOOL_TIMEOUT_MS,
  previewToolErrorResult,
  previewToolInputJsonSchema,
  type McpToolResult,
} from "./previewMcpTools.ts";

const MCP_ENDPOINT_PATH = "/mcp/preview";
const PREVIEW_MCP_SERVER_NAME = "__f5_preview";
const PREVIEW_MCP_ENV_PREFIX = "F5_PREVIEW_MCP_TOKEN_";
const MCP_PROTOCOL_VERSION = "2024-11-05";

type McpCatalog = "preview" | "computer" | "thread" | "integration";
const CATALOG_PATHS: Record<McpCatalog, string> = {
  preview: MCP_ENDPOINT_PATH,
  computer: "/mcp/computer",
  thread: "/mcp/thread",
  integration: "/mcp/integration",
};

interface PreviewMcpSessionScope {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly automationSessionId: string;
  readonly issuedAt: string;
  readonly catalog: McpCatalog;
  geometry: ComputerToolGeometry;
  computerScope?: ComputerSessionScope;
  /** Provider-native integration proxied through F5's per-call admission. */
  integration?: IntegrationProxySession;
  rpcIncarnation?: string;
}

export interface PreviewMcpSessionConfig {
  readonly serverName: string;
  readonly serverDefinition: McpServerDefinition;
  readonly env: Record<string, string>;
  readonly dispose: () => void;
  readonly endTurn?: (turnId: string) => void;
}

export interface PreviewMcpHttpServerShape {
  readonly supportsThreadCatalog?: boolean;
  readonly getUrl: (catalog?: McpCatalog) => string;
  readonly createSessionConfig: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly existingServerNames?: ReadonlySet<string>;
    readonly catalog?: McpCatalog;
    readonly provider?: ComputerAgentProvider | "acp";
    readonly serverName?: string;
    /** Required for the `integration` catalog; disposed with the session config. */
    readonly integration?: IntegrationProxySession;
  }) => PreviewMcpSessionConfig;
}

export class PreviewMcpHttpServer extends ServiceMap.Service<
  PreviewMcpHttpServer,
  PreviewMcpHttpServerShape
>()("t3/mcp/PreviewMcpHttpServer") {}

export class PreviewMcpHttpServerError extends Data.TaggedError("PreviewMcpHttpServerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PREVIEW_MCP_TOOL_LIST = PREVIEW_TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: previewToolInputJsonSchema(tool),
  annotations: { ...tool.annotations, title: tool.title },
}));

function makeToolCallHandler(
  broker: PreviewAutomationBrokerShape,
  resolveScope: (token: string) => PreviewMcpSessionScope | undefined,
  computer?: ComputerAutomationBrokerRuntime,
  thread?: ThreadMcpBroker["Service"],
) {
  return async (
    token: string,
    name: string,
    rawArguments: unknown,
    invocationId?: string,
  ): Promise<McpToolResult> => {
    const scope = resolveScope(token);
    if (!scope) {
      return previewToolErrorResult(
        new PreviewAutomationExecutionError({ message: "MCP credential is no longer valid." }),
      );
    }
    if (scope.catalog === "integration") {
      if (!scope.integration) return previewToolErrorResult(new Error("Integration unavailable."));
      return scope.integration.callTool(name, rawArguments, invocationId);
    }
    if (scope.catalog === "thread") {
      return thread
        ? callThreadTool({ broker: thread, threadId: scope.threadId }, name, rawArguments)
        : previewToolErrorResult(new Error("Thread tools unavailable."));
    }
    if (scope.catalog === "computer") {
      if (!computer) return previewToolErrorResult(new Error("Computer host unavailable."));
      return callComputerTool(
        {
          broker: computer,
          threadId: scope.threadId,
          sessionGeneration: scope.automationSessionId,
          geometry: scope.computerScope?.geometry ?? scope.geometry,
          ...(invocationId !== undefined ? { invocationId } : {}),
        },
        name,
        rawArguments,
      );
    }
    const policy = await Effect.runPromise(broker.resolvePolicy(scope.threadId));
    return callPreviewTool(
      {
        broker,
        policy,
        threadId: scope.threadId,
        automationSessionId: scope.automationSessionId,
      },
      name,
      rawArguments,
    );
  };
}

function nextToken(): string {
  return randomBytes(32).toString("base64url");
}

function nextEnvVarName(): string {
  return `${PREVIEW_MCP_ENV_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`;
}

function handleRpcRequest(input: {
  readonly request: JsonRpcRequest;
  readonly token: string;
  readonly catalog: McpCatalog;
  readonly integration?: IntegrationProxySession;
  /** Scopes a client JSON-RPC id to this MCP connection. */
  readonly invocationKey: (id: string) => string;
  readonly callTool: (
    token: string,
    name: string,
    rawArguments: unknown,
    invocationId?: string,
  ) => Promise<McpToolResult>;
}): Promise<JsonRpcResponse | null> {
  const { request } = input;
  if (request.id === undefined && request.method?.startsWith("notifications/")) {
    // Calls are keyed by the client's JSON-RPC id, so a client cancellation reaches the
    // proxied child (and starts the bounded drain) instead of being dropped.
    if (input.catalog === "integration" && request.method === "notifications/cancelled") {
      const requestId = asObject(request.params).requestId;
      if (requestId !== undefined)
        input.integration?.cancelCall(input.invocationKey(JSON.stringify(requestId)));
    }
    return Promise.resolve(null);
  }
  if (typeof request.method !== "string") {
    return Promise.resolve(jsonRpcError(request.id, -32600, "Invalid JSON-RPC request."));
  }

  switch (request.method) {
    case "initialize":
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          ...(input.catalog === "computer" ? { instructions: COMPUTER_GUIDANCE } : {}),
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name:
              input.catalog === "thread"
                ? "F5 Thread"
                : input.catalog === "computer"
                  ? "F5 Computer"
                  : input.catalog === "integration"
                    ? "F5 Integration"
                    : "F5 Preview",
            version: "0.0.0",
          },
        }),
      );
    case "ping":
      return Promise.resolve(jsonRpcSuccess(request.id, {}));
    case "tools/list":
      if (input.catalog === "integration")
        return (input.integration?.listTools() ?? Promise.resolve([])).then((tools) =>
          jsonRpcSuccess(request.id, {
            tools: tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema,
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
            })),
          }),
        );
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          tools:
            input.catalog === "thread"
              ? THREAD_TOOL_DEFINITIONS.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: threadToolInputJsonSchema(tool),
                  annotations: { ...tool.annotations, title: tool.title },
                }))
              : input.catalog === "computer"
                ? COMPUTER_TOOL_DEFINITIONS.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: computerToolInputJsonSchema(tool),
                    annotations: tool.annotations,
                  }))
                : PREVIEW_MCP_TOOL_LIST,
        }),
      );
    case "tools/call": {
      const params = asObject(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      return input
        .callTool(
          input.token,
          name,
          params.arguments,
          request.id === undefined ? undefined : input.invocationKey(JSON.stringify(request.id)),
        )
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

export const makePreviewMcpHttpServer = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker;
  const computerOption = yield* Effect.serviceOption(ComputerAutomationBroker);
  const computer = Option.getOrUndefined(computerOption);
  const sessionsByToken = new Map<string, PreviewMcpSessionScope>();
  const tokenByEnvVar = new Map<string, string>();
  const thread = Option.getOrUndefined(yield* Effect.serviceOption(ThreadMcpBroker));
  const callTool = makeToolCallHandler(
    broker,
    (token) => sessionsByToken.get(token),
    computer,
    thread,
  );
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
      const catalog = (Object.keys(CATALOG_PATHS) as McpCatalog[]).find(
        (entry) => CATALOG_PATHS[entry] === request.url,
      );
      if (!catalog) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const token = readBearerToken(request);
      if (!token || sessionsByToken.get(token)?.catalog !== catalog) {
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

      const scope = sessionsByToken.get(token);
      if (!scope) {
        writeJson(response, 401, { error: "invalid_mcp_credential" });
        return;
      }
      const requests = Array.isArray(body) ? body : [body];
      if (catalog === "computer") {
        const initializes = requests.some((entry) => asObject(entry).method === "initialize");
        if (initializes) {
          scope.rpcIncarnation = randomUUID();
          scope.geometry.clear();
          scope.geometry = new ComputerToolGeometry();
          scope.computerScope?.resetConnection();
          response.setHeader("Mcp-Session-Id", scope.rpcIncarnation);
        } else if (
          scope.rpcIncarnation &&
          request.headers["mcp-session-id"] !== scope.rpcIncarnation
        ) {
          writeJson(response, 404, { error: "expired_mcp_session" });
          return;
        }
      } else if (catalog === "integration") {
        // Each connection gets its own id space, so a late `notifications/cancelled` from a
        // previous connection can never name a live call after Codex reconnects.
        if (requests.some((entry) => asObject(entry).method === "initialize")) {
          scope.rpcIncarnation = randomUUID();
          response.setHeader("Mcp-Session-Id", scope.rpcIncarnation);
        }
      }
      const requestIncarnation = request.headers["mcp-session-id"];
      const incarnation =
        catalog === "integration" && typeof requestIncarnation === "string"
          ? requestIncarnation
          : (scope.rpcIncarnation ?? scope.automationSessionId);
      const results = (
        await Promise.all(
          requests.map((entry) =>
            handleRpcRequest({
              request: asObject(entry) as JsonRpcRequest,
              token,
              catalog,
              ...(scope.integration ? { integration: scope.integration } : {}),
              invocationKey: (id) => `${incarnation}:${id}`,
              callTool,
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

  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
    catch: (cause) =>
      new PreviewMcpHttpServerError({
        message: cause instanceof Error ? cause.message : "Failed to start preview MCP server.",
        cause,
      }),
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port;
  if (!port) {
    return yield* Effect.die("Preview MCP server did not expose a port.");
  }
  expectedHostPort = port;

  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );

  const catalogUrl = (catalog: McpCatalog) => `http://127.0.0.1:${port}${CATALOG_PATHS[catalog]}`;
  return {
    supportsThreadCatalog: !!thread,
    getUrl: (catalog = "preview") => catalogUrl(catalog),
    createSessionConfig: (input) => {
      const catalog = input.catalog ?? "preview";
      if (catalog === "thread" && !thread) throw new Error("Thread tools unavailable.");
      if (catalog === "computer" && !computer) throw new Error("Computer host unavailable.");
      if (catalog === "integration" && (!input.integration || !input.serverName))
        throw new Error("Integration catalogs need a proxy session and a fixed server name.");
      const token = nextToken();
      const envVarName =
        catalog !== "preview"
          ? `F5_${catalog.toUpperCase()}_MCP_TOKEN_${randomUUID().replaceAll("-", "_").toUpperCase()}`
          : nextEnvVarName();
      const serverName =
        input.serverName ??
        chooseServerName(
          catalog === "thread"
            ? "f5_thread"
            : catalog === "computer"
              ? "__f5_computer"
              : PREVIEW_MCP_SERVER_NAME,
          input.existingServerNames,
        );
      const computerScope =
        catalog === "computer"
          ? createComputerSessionScope({
              broker: computer!,
              threadId: input.threadId,
              provider: (() => {
                if (input.provider === "acp")
                  throw new Error("Custom ACP computer access is not certified.");
                return input.provider ?? "codex";
              })(),
              serverName,
            })
          : undefined;
      const generation =
        computerScope?.generation ?? `${input.provider ?? "codex"}:${randomUUID()}`;
      const geometry = computerScope?.geometry ?? new ComputerToolGeometry();
      sessionsByToken.set(token, {
        threadId: input.threadId,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        automationSessionId: generation,
        catalog,
        geometry,
        ...(computerScope ? { computerScope } : {}),
        ...(catalog === "integration" ? { integration: input.integration! } : {}),
        issuedAt: new Date().toISOString(),
      });
      tokenByEnvVar.set(envVarName, token);

      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        geometry.clear();
        const storedToken = tokenByEnvVar.get(envVarName);
        tokenByEnvVar.delete(envVarName);
        if (storedToken) {
          sessionsByToken.delete(storedToken);
        }
        computerScope?.dispose();
        // Credential revocation tears the proxied child down (SIGTERM, then SIGKILL).
        if (catalog === "integration") void input.integration!.dispose();
      };

      return {
        serverName,
        serverDefinition: {
          type: "http",
          url: catalogUrl(catalog),
          enabled: true,
          bearerTokenEnvVar: envVarName,
          supportsParallelToolCalls: false,
          // Listing answers from the record; the child starts on the first admitted call.
          startupTimeoutSec: 10,
          // Explicit, above the longest broker deadline (60 s executor + 2 s grace).
          toolTimeoutSec:
            catalog === "integration"
              ? INTEGRATION_TOOL_TIMEOUT_SEC
              : (catalog === "thread"
                  ? THREAD_TOOL_TIMEOUT_MS
                  : catalog === "computer"
                    ? COMPUTER_TOOL_TIMEOUT_MS
                    : PREVIEW_TOOL_TIMEOUT_MS) / 1000,
        },
        env: {
          [envVarName]: token,
        },
        dispose,
        ...(catalog === "computer"
          ? { endTurn: (turnId: string) => computerScope?.endTurn(turnId) }
          : {}),
      };
    },
  } satisfies PreviewMcpHttpServerShape;
});

export const PreviewMcpHttpServerLive = Layer.effect(
  PreviewMcpHttpServer,
  makePreviewMcpHttpServer,
);
