import {
  ThreadMcpBroker,
  callThreadTool,
  threadToolDefinitions,
  type ThreadToolAccess,
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
import {
  ASK_USER_QUESTION_TOOL,
  callInteractionTool,
  INTERACTION_WAIT_MS,
  type InteractionSession,
  WAIT_FOR_USER_ANSWER_TOOL,
} from "./interactionMcpTools.ts";

const MCP_ENDPOINT_PATH = "/mcp/preview";
const PREVIEW_MCP_SERVER_NAME = "__f5_preview";
const PREVIEW_MCP_ENV_PREFIX = "F5_PREVIEW_MCP_TOKEN_";
const MCP_PROTOCOL_VERSION = "2024-11-05";
/** One call waits `INTERACTION_WAIT_MS` at most, then returns pending; the card stays open. */
const INTERACTION_TOOL_TIMEOUT_SEC = INTERACTION_WAIT_MS / 1000 + 60;
const INTERACTION_GUIDANCE =
  "When the user must choose between options, call ask_user_question instead of asking in prose, and wait for the answer. While a result is pending, call wait_for_user_answer with its questionId.";

export type McpCatalog = "preview" | "computer" | "thread" | "integration" | "interaction";
const CATALOG_PATHS: Record<McpCatalog, string> = {
  preview: MCP_ENDPOINT_PATH,
  computer: "/mcp/computer",
  thread: "/mcp/thread",
  integration: "/mcp/integration",
  interaction: "/mcp/interaction",
};

interface PreviewMcpSessionScope {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly automationSessionId: string;
  readonly issuedAt: string;
  readonly catalog: McpCatalog;
  /** Which thread tools this session lists and may call. */
  readonly threadAccess: ThreadToolAccess;
  geometry: ComputerToolGeometry;
  computerScope?: ComputerSessionScope;
  /** Provider-native integration proxied through F5's per-call admission. */
  integration?: IntegrationProxySession;
  /** The adapter that shows this session's questions. */
  interaction?: InteractionSession;
  /** In-flight `ask_user_question` calls, by invocation key. */
  readonly interactionCalls: Map<string, AbortController>;
  rpcIncarnation?: string;
}

export interface PreviewMcpSessionConfig {
  readonly serverName: string;
  readonly serverDefinition: McpServerDefinition;
  readonly env: Record<string, string>;
  readonly dispose: () => void;
  readonly endTurn?: (turnId: string) => void;
}

/**
 * Handles requests under a mounted path prefix. The listener has already
 * checked the loopback peer, Host and Origin; the handler owns authentication.
 */
export type McpPrefixHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => Promise<void>;

export interface PreviewMcpHttpServerShape {
  readonly supportsThreadCatalog?: boolean;
  readonly getUrl: (catalog?: McpCatalog) => string;
  /** `http://127.0.0.1:<port>`; absent in test fakes that serve no mounted routes. */
  readonly baseUrl?: string;
  /** Routes every method under `prefix` (which must end with `/`) to `handler`. */
  readonly mount?: (prefix: string, handler: McpPrefixHandler) => () => void;
  readonly createSessionConfig: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly existingServerNames?: ReadonlySet<string>;
    readonly catalog?: McpCatalog;
    readonly provider?: ComputerAgentProvider | "acp";
    readonly serverName?: string;
    /** Thread catalog only: read-only sessions get just the tools that read. Defaults to full. */
    readonly threadAccess?: ThreadToolAccess;
    /** Required for the `integration` catalog; disposed with the session config. */
    readonly integration?: IntegrationProxySession;
    /** Required for the `interaction` catalog. */
    readonly interaction?: InteractionSession;
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
    meta?: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolResult> => {
    const scope = resolveScope(token);
    if (!scope) {
      return previewToolErrorResult(
        new PreviewAutomationExecutionError({ message: "MCP credential is no longer valid." }),
      );
    }
    if (scope.catalog === "interaction")
      return callInteractionTool(
        scope.interaction,
        name,
        rawArguments,
        signal ?? new AbortController().signal,
      );
    if (scope.catalog === "integration") {
      if (!scope.integration) return previewToolErrorResult(new Error("Integration unavailable."));
      // Codex's turn metadata rides in `_meta`; ChatGPT's browser runtime requires it.
      return scope.integration.callTool(name, rawArguments, invocationId, meta);
    }
    if (scope.catalog === "thread") {
      return thread
        ? callThreadTool(
            { broker: thread, threadId: scope.threadId, access: scope.threadAccess },
            name,
            rawArguments,
          )
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
  readonly threadAccess?: ThreadToolAccess;
  readonly integration?: IntegrationProxySession;
  /** Scopes a client JSON-RPC id to this MCP connection. */
  readonly invocationKey: (id: string) => string;
  /** In-flight interaction calls by invocation key, aborted by `notifications/cancelled`. */
  readonly interactionCalls: Map<string, AbortController>;
  /** Aborts when the HTTP client goes away before the reply. */
  readonly connectionSignal: AbortSignal;
  readonly callTool: (
    token: string,
    name: string,
    rawArguments: unknown,
    invocationId?: string,
    meta?: unknown,
    signal?: AbortSignal,
  ) => Promise<McpToolResult>;
}): Promise<JsonRpcResponse | null> {
  const { request } = input;
  if (request.id === undefined && request.method?.startsWith("notifications/")) {
    // Calls are keyed by the client's JSON-RPC id, so a client cancellation reaches the
    // proxied child (and starts the bounded drain) instead of being dropped.
    if (request.method === "notifications/cancelled") {
      const requestId = asObject(request.params).requestId;
      if (requestId !== undefined) {
        const key = input.invocationKey(JSON.stringify(requestId));
        if (input.catalog === "integration") input.integration?.cancelCall(key);
        if (input.catalog === "interaction") input.interactionCalls.get(key)?.abort();
      }
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
          ...(input.catalog === "interaction" ? { instructions: INTERACTION_GUIDANCE } : {}),
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
                    : input.catalog === "interaction"
                      ? "F5 Interaction"
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
      if (input.catalog === "interaction")
        return Promise.resolve(
          jsonRpcSuccess(request.id, {
            tools: [ASK_USER_QUESTION_TOOL, WAIT_FOR_USER_ANSWER_TOOL],
          }),
        );
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          tools:
            input.catalog === "thread"
              ? threadToolDefinitions(input.threadAccess ?? "full").map((tool) => ({
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
      const invocationId =
        request.id === undefined ? undefined : input.invocationKey(JSON.stringify(request.id));
      let signal: AbortSignal | undefined;
      let release = () => {};
      if (input.catalog === "interaction") {
        const controller = new AbortController();
        const abort = () => controller.abort();
        input.connectionSignal.addEventListener("abort", abort, { once: true });
        if (input.connectionSignal.aborted) controller.abort();
        if (invocationId !== undefined) input.interactionCalls.set(invocationId, controller);
        signal = controller.signal;
        release = () => {
          input.connectionSignal.removeEventListener("abort", abort);
          if (invocationId !== undefined && input.interactionCalls.get(invocationId) === controller)
            input.interactionCalls.delete(invocationId);
        };
      }
      return input
        .callTool(input.token, name, params.arguments, invocationId, params._meta, signal)
        .then((result) => jsonRpcSuccess(request.id, result))
        .finally(release);
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
  const mounts = new Map<string, McpPrefixHandler>();
  const runLog = Effect.runPromiseWith(yield* Effect.services<never>());

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
      // MCP admits native clients only; reject browser requests before auth or method handling.
      if (request.headers.origin !== undefined) {
        writeJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      const path = (request.url ?? "").split("?")[0] ?? "";
      for (const [prefix, handler] of mounts) {
        if (path.startsWith(prefix)) {
          await handler(request, response);
          return;
        }
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
        await runLog(
          Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token ? "unknown_revoked_or_wrong_catalog" : "missing_bearer_token",
          }),
        );
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
        await runLog(Effect.logWarning("rejected MCP request with a revoked credential"));
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
      } else if (catalog === "integration" || catalog === "interaction") {
        // Each connection gets its own id space, so a late `notifications/cancelled` from a
        // previous connection can never name a live call after the client reconnects.
        if (requests.some((entry) => asObject(entry).method === "initialize")) {
          scope.rpcIncarnation = randomUUID();
          response.setHeader("Mcp-Session-Id", scope.rpcIncarnation);
        }
      }
      const requestIncarnation = request.headers["mcp-session-id"];
      const incarnation =
        (catalog === "integration" || catalog === "interaction") &&
        typeof requestIncarnation === "string"
          ? requestIncarnation
          : (scope.rpcIncarnation ?? scope.automationSessionId);
      // A question can wait a long time; a client that hangs up stops waiting for it.
      const connection = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) connection.abort();
      });
      const results = (
        await Promise.all(
          requests.map((entry) =>
            handleRpcRequest({
              request: asObject(entry) as JsonRpcRequest,
              token,
              catalog,
              threadAccess: scope.threadAccess,
              ...(scope.integration ? { integration: scope.integration } : {}),
              invocationKey: (id) => `${incarnation}:${id}`,
              // Per credential, so one session can never cancel another's call.
              interactionCalls: scope.interactionCalls,
              connectionSignal: connection.signal,
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
    baseUrl: `http://127.0.0.1:${port}`,
    mount: (prefix, handler) => {
      if (!prefix.startsWith("/mcp/") || !prefix.endsWith("/"))
        throw new Error("Mounted MCP prefixes must look like /mcp/<name>/.");
      if (mounts.has(prefix)) throw new Error(`An MCP handler is already mounted at ${prefix}.`);
      mounts.set(prefix, handler);
      return () => {
        if (mounts.get(prefix) === handler) mounts.delete(prefix);
      };
    },
    createSessionConfig: (input) => {
      const catalog = input.catalog ?? "preview";
      if (catalog === "thread" && !thread) throw new Error("Thread tools unavailable.");
      if (catalog === "computer" && !computer) throw new Error("Computer host unavailable.");
      if (catalog === "integration" && (!input.integration || !input.serverName))
        throw new Error("Integration catalogs need a proxy session and a fixed server name.");
      if (catalog === "interaction" && !input.interaction)
        throw new Error("Interaction catalogs need a session that shows questions.");
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
              : catalog === "interaction"
                ? "f5_interaction"
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
        threadAccess: input.threadAccess ?? "full",
        geometry,
        ...(computerScope ? { computerScope } : {}),
        ...(catalog === "integration" ? { integration: input.integration! } : {}),
        ...(catalog === "interaction" ? { interaction: input.interaction! } : {}),
        interactionCalls: new Map(),
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
          // A revoked credential stops waiting for its questions.
          for (const call of sessionsByToken.get(storedToken)?.interactionCalls.values() ?? [])
            call.abort();
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
              : catalog === "interaction"
                ? INTERACTION_TOOL_TIMEOUT_SEC
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
