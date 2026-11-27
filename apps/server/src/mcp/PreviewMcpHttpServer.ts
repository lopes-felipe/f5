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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  asObject,
  isAllowedHostHeader,
  isLoopbackAddress,
  readBearerToken,
  readRequestBody,
  writeEmpty,
  writeJson,
} from "./jsonRpcHttp.ts";
import { McpHttpConnections } from "./McpHttpConnections.ts";
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
/** A client rarely holds more than one connection per credential; reconnects replace it. */
const MAX_CONNECTIONS_PER_CREDENTIAL = 4;
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
const CATALOG_SERVER_NAMES: Record<McpCatalog, string> = {
  preview: "F5 Preview",
  computer: "F5 Computer",
  thread: "F5 Thread",
  integration: "F5 Integration",
  interaction: "F5 Interaction",
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
  /** The MCP connections clients opened with this credential. */
  readonly connections: McpHttpConnections;
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

/** The tools a session's catalog lists. */
async function catalogTools(scope: PreviewMcpSessionScope): Promise<ReadonlyArray<unknown>> {
  switch (scope.catalog) {
    case "integration":
      return ((await scope.integration?.listTools()) ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }));
    case "interaction":
      return [ASK_USER_QUESTION_TOOL, WAIT_FOR_USER_ANSWER_TOOL];
    case "thread":
      return threadToolDefinitions(scope.threadAccess).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: threadToolInputJsonSchema(tool),
        annotations: { ...tool.annotations, title: tool.title },
      }));
    case "computer":
      return COMPUTER_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: computerToolInputJsonSchema(tool),
        annotations: tool.annotations,
      }));
    case "preview":
      return PREVIEW_MCP_TOOL_LIST;
  }
}

/**
 * A call's key: its connection and the client's JSON-RPC id, so a late cancel from an
 * earlier connection never names a live call on a newer one.
 */
function catalogCallKey(sessionId: string | undefined, requestId: unknown): string {
  return `${sessionId}:${JSON.stringify(requestId)}`;
}

/** Cancels an integration call (the proxy drains its child) or ends an interaction wait. */
function cancelCatalogCall(scope: PreviewMcpSessionScope, key: string): void {
  if (scope.catalog === "integration") scope.integration?.cancelCall(key);
  if (scope.catalog === "interaction") scope.interactionCalls.get(key)?.abort();
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

  /** One connection's SDK server; it negotiates the protocol version with the client. */
  const createCatalogServer = (scope: PreviewMcpSessionScope, token: string): Server => {
    const instructions =
      scope.catalog === "computer"
        ? COMPUTER_GUIDANCE
        : scope.catalog === "interaction"
          ? INTERACTION_GUIDANCE
          : undefined;
    const server = new Server(
      { name: CATALOG_SERVER_NAMES[scope.catalog], version: "0.0.0" },
      { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await catalogTools(scope)) as Tool[],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const key = catalogCallKey(extra.sessionId, extra.requestId);
      let signal = extra.signal;
      let release = () => {};
      if (scope.catalog === "interaction") {
        // Ends on the client's cancel, its hang-up, or the credential's revocation.
        const controller = new AbortController();
        const abort = () => controller.abort();
        extra.signal.addEventListener("abort", abort, { once: true });
        scope.interactionCalls.set(key, controller);
        signal = controller.signal;
        release = () => {
          extra.signal.removeEventListener("abort", abort);
          if (scope.interactionCalls.get(key) === controller) scope.interactionCalls.delete(key);
        };
      }
      try {
        const result = await callTool(
          token,
          request.params.name,
          request.params.arguments,
          key,
          request.params._meta,
          signal,
        );
        return { ...result, content: [...result.content] } satisfies CallToolResult;
      } finally {
        release();
      }
    });
    return server;
  };

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
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
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
      if (request.method === "POST") {
        try {
          body = await readRequestBody(request);
        } catch (cause) {
          writeJson(response, 400, {
            error: "invalid_json",
            message: cause instanceof Error ? cause.message : String(cause),
          });
          return;
        }
      }

      const scope = sessionsByToken.get(token);
      if (!scope) {
        await runLog(Effect.logWarning("rejected MCP request with a revoked credential"));
        writeJson(response, 401, { error: "invalid_mcp_credential" });
        return;
      }
      if (body === undefined) {
        await scope.connections.handle(request, response);
        return;
      }
      const header = request.headers["mcp-session-id"];
      const sessionId = typeof header === "string" ? header : undefined;
      const messages = Array.isArray(body) ? body : [body];
      // F5 handles cancellations itself and still answers the call (an interaction wait
      // with its pending result, an integration call once its child stops). The SDK would
      // drop that reply and leave the client's HTTP request open.
      const forwarded = messages.filter((message) => {
        const entry = asObject(message);
        if (entry.method !== "notifications/cancelled" || entry.id !== undefined) return true;
        const requestId = asObject(entry.params).requestId;
        if (sessionId && requestId !== undefined)
          cancelCatalogCall(scope, catalogCallKey(sessionId, requestId));
        return false;
      });
      if (forwarded.length === 0) {
        writeEmpty(response, 202);
        return;
      }
      if (catalog === "interaction" && sessionId) {
        // A question can wait a long time; a client that hangs up stops waiting for it.
        const keys = forwarded.flatMap((message) => {
          const entry = asObject(message);
          return entry.method === "tools/call" && entry.id !== undefined
            ? [catalogCallKey(sessionId, entry.id)]
            : [];
        });
        if (keys.length > 0)
          response.once("close", () => {
            if (response.writableFinished) return;
            for (const key of keys) scope.interactionCalls.get(key)?.abort();
          });
      }
      await scope.connections.handle(
        request,
        response,
        Array.isArray(body) ? forwarded : forwarded[0],
      );
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
      const scope: PreviewMcpSessionScope = {
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
        connections: new McpHttpConnections({
          createServer: () => createCatalogServer(scope, token),
          maxConnections: MAX_CONNECTIONS_PER_CREDENTIAL,
          ...(catalog === "computer"
            ? {
                // One computer connection at a time: a new one expires the old and starts
                // over, so element references from the old connection never resolve.
                onInitialized: (sessionId: string) => {
                  scope.connections.closeOthers(sessionId);
                  scope.geometry.clear();
                  scope.geometry = new ComputerToolGeometry();
                  scope.computerScope?.resetConnection();
                },
              }
            : {}),
        }),
      };
      sessionsByToken.set(token, scope);
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
        void scope.connections.close();
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
