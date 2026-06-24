import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";

import {
  type McpServerDefinition,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationExecutionError,
  PreviewAutomationNavigateInput,
  PreviewAutomationNoFocusedOwnerError,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  type PreviewAutomationStatus,
  PreviewAutomationTabNotFoundError,
  type PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { Cause, Data, Effect, Exit, Layer, Option, Schema, ServiceMap } from "effect";

import {
  PreviewAutomationBroker,
  type PreviewAutomationBrokerShape,
} from "./PreviewAutomationBroker.ts";

const MCP_ENDPOINT_PATH = "/mcp/preview";
const PREVIEW_MCP_SERVER_NAME = "__f5_preview";
const PREVIEW_MCP_ENV_PREFIX = "F5_PREVIEW_MCP_TOKEN_";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const previewAutomationUnavailableStatus = {
  available: false,
  visible: false,
  tabId: null,
  url: null,
  title: null,
  loading: false,
} satisfies PreviewAutomationStatus;

interface PreviewMcpSessionScope {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly issuedAt: string;
}

export interface PreviewMcpSessionConfig {
  readonly serverName: string;
  readonly serverDefinition: McpServerDefinition;
  readonly env: Record<string, string>;
  readonly dispose: () => void;
}

export interface PreviewMcpHttpServerShape {
  readonly getUrl: () => string;
  readonly createSessionConfig: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly existingServerNames?: ReadonlySet<string>;
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

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

const emptyInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} satisfies Record<string, unknown>;

const maybeTimeoutProperty = {
  type: "integer",
  minimum: 1,
  maximum: 60_000,
  description: "Maximum wait in milliseconds. Defaults to 15000.",
} satisfies Record<string, unknown>;

const PREVIEW_MCP_TOOLS: ReadonlyArray<McpToolDefinition> = [
  {
    name: "preview_status",
    title: "Get preview status",
    description:
      "Report whether this thread has an automation-capable desktop preview, including active tab, URL, title, visibility, and loading state.",
    inputSchema: emptyInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Get preview status",
    },
  },
  {
    name: "preview_open",
    title: "Open browser preview",
    description:
      "Initialize the browser preview for this thread, optionally reusing the current tab and navigating to a loopback URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", maxLength: 2048 },
        show: { type: "boolean", default: true },
        reuseExistingTab: { type: "boolean", default: true },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: "Open browser preview",
    },
  },
  {
    name: "preview_navigate",
    title: "Navigate browser preview",
    description:
      "Navigate the active browser preview tab. Provide a loopback url for direct navigation, or target.kind='environment-port' for a localhost dev server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", maxLength: 2048 },
        target: {
          oneOf: [
            {
              type: "object",
              required: ["kind", "url"],
              additionalProperties: false,
              properties: {
                kind: { const: "url" },
                url: { type: "string", maxLength: 2048 },
              },
            },
            {
              type: "object",
              required: ["kind", "port"],
              additionalProperties: false,
              properties: {
                kind: { const: "environment-port" },
                port: { type: "integer", minimum: 1, maximum: 65_535 },
                protocol: { enum: ["http", "https"] },
                path: { type: "string" },
              },
            },
          ],
        },
        readiness: { enum: ["load", "domContentLoaded", "none"] },
        timeoutMs: maybeTimeoutProperty,
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: "Navigate browser preview",
    },
  },
  {
    name: "preview_snapshot",
    title: "Inspect browser page",
    description:
      "Inspect the current page before interacting. Returns URL/title/loading state, visible text, interactive elements, diagnostics, and a PNG screenshot.",
    inputSchema: emptyInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Inspect browser page",
    },
  },
  {
    name: "preview_click",
    title: "Click preview page",
    description:
      "Click exactly one page target. Use selector, locator, or viewport x/y coordinates.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: { type: "string" },
        locator: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        timeoutMs: maybeTimeoutProperty,
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: "Click preview page",
    },
  },
  {
    name: "preview_type",
    title: "Type into preview page",
    description:
      "Insert literal text into an input target, or into the currently focused element when no target is supplied.",
    inputSchema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        locator: { type: "string" },
        clear: { type: "boolean" },
        timeoutMs: maybeTimeoutProperty,
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: "Type into preview page",
    },
  },
  {
    name: "preview_press",
    title: "Press key in preview page",
    description: "Press one keyboard key in the active page, targeting the page's current focus.",
    inputSchema: {
      type: "object",
      required: ["key"],
      additionalProperties: false,
      properties: {
        key: { type: "string", minLength: 1 },
        modifiers: {
          type: "array",
          items: { enum: ["Alt", "Control", "Meta", "Shift"] },
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: "Press key in preview page",
    },
  },
  {
    name: "preview_scroll",
    title: "Scroll preview page",
    description: "Scroll the viewport, or a selector/locator container, by CSS pixel deltas.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        selector: { type: "string" },
        locator: { type: "string" },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: "Scroll preview page",
    },
  },
  {
    name: "preview_evaluate",
    title: "Evaluate JavaScript in preview",
    description:
      "Evaluate a JavaScript expression in the page and return a serializable result up to 64 KB.",
    inputSchema: {
      type: "object",
      required: ["expression"],
      additionalProperties: false,
      properties: {
        expression: { type: "string", minLength: 1, maxLength: 64_000 },
        awaitPromise: { type: "boolean" },
        timeoutMs: maybeTimeoutProperty,
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: "Evaluate JavaScript in preview",
    },
  },
  {
    name: "preview_wait_for",
    title: "Wait for preview page condition",
    description:
      "Wait until all supplied conditions match: selector, locator, visible text substring, and/or URL substring.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: { type: "string" },
        locator: { type: "string" },
        text: { type: "string" },
        urlIncludes: { type: "string" },
        timeoutMs: maybeTimeoutProperty,
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Wait for preview page condition",
    },
  },
];

const toolByName = new Map(PREVIEW_MCP_TOOLS.map((tool) => [tool.name, tool]));

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readBearerToken(request: http.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function isAllowedHostHeader(host: string | undefined, port: number | null): boolean {
  if (!host || port === null) return false;
  const normalized = host.toLowerCase();
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `[::1]:${port}`
  );
}

function jsonRpcSuccess(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(
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

function writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function writeEmpty(response: http.ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
  });
  response.end();
}

function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
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

function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolResult(result: unknown): Record<string, unknown> {
  if (result === undefined || result === null) {
    return {
      content: [{ type: "text", text: "null" }],
    };
  }
  return {
    structuredContent: result,
    content: [{ type: "text", text: safeJsonText(result) }],
  };
}

function snapshotToolResult(snapshot: PreviewAutomationSnapshot): Record<string, unknown> {
  const { screenshot, ...metadata } = snapshot;
  return {
    structuredContent: {
      ...metadata,
      screenshot: {
        mimeType: screenshot.mimeType,
        width: screenshot.width,
        height: screenshot.height,
      },
    },
    content: [
      {
        type: "text",
        text: safeJsonText({
          ...metadata,
          screenshot: {
            mimeType: screenshot.mimeType,
            width: screenshot.width,
            height: screenshot.height,
          },
        }),
      },
      {
        type: "image",
        mimeType: screenshot.mimeType,
        data: screenshot.data,
      },
    ],
  };
}

function toolErrorResult(cause: unknown): Record<string, unknown> {
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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeAutomationUrl(rawUrl: string): string {
  try {
    return normalizePreviewUrl(rawUrl);
  } catch (cause) {
    throw new PreviewAutomationExecutionError({
      message: cause instanceof Error ? cause.message : "Preview navigation URL is invalid.",
    });
  }
}

function normalizeAutomationOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  return input.url === undefined ? input : { ...input, url: normalizeAutomationUrl(input.url) };
}

function normalizeAutomationNavigateInput(
  input: PreviewAutomationNavigateInput,
): PreviewAutomationNavigateInput {
  if (input.url !== undefined) {
    return { ...input, url: normalizeAutomationUrl(input.url) };
  }
  if (input.target?.kind === "url") {
    return { ...input, target: { ...input.target, url: normalizeAutomationUrl(input.target.url) } };
  }
  return input;
}

function decodeToolInput<S extends Schema.Top>(schema: S, value: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(asObject(value)) as Schema.Schema.Type<S>;
}

async function runBrokerEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const typedError = Exit.findErrorOption(exit);
  if (Option.isSome(typedError)) {
    throw typedError.value;
  }
  throw new PreviewAutomationExecutionError({
    message: String(Cause.squash(exit.cause)),
  });
}

function invokeWithOptionalTimeout(
  broker: PreviewAutomationBrokerShape,
  input: Omit<Parameters<PreviewAutomationBrokerShape["invoke"]>[0], "timeoutMs"> & {
    readonly timeoutMs?: number | undefined;
  },
) {
  const { timeoutMs, ...base } = input;
  return broker.invoke(timeoutMs === undefined ? base : { ...base, timeoutMs });
}

function makeToolCallHandler(
  broker: PreviewAutomationBrokerShape,
  resolveScope: (token: string) => PreviewMcpSessionScope | undefined,
) {
  return async (
    token: string,
    name: string,
    rawArguments: unknown,
  ): Promise<Record<string, unknown>> => {
    const scope = resolveScope(token);
    if (!scope) {
      return toolErrorResult(
        new PreviewAutomationExecutionError({ message: "MCP credential is no longer valid." }),
      );
    }
    if (!toolByName.has(name)) {
      return toolErrorResult(
        new PreviewAutomationExecutionError({ message: `Unknown preview tool: ${name}` }),
      );
    }

    try {
      switch (name) {
        case "preview_status": {
          try {
            return toolResult(
              await runBrokerEffect(
                broker.invoke({ threadId: scope.threadId, operation: "status", input: {} }),
              ),
            );
          } catch (cause) {
            if (
              Schema.is(PreviewAutomationNoFocusedOwnerError)(cause) ||
              Schema.is(PreviewAutomationTabNotFoundError)(cause)
            ) {
              return toolResult(previewAutomationUnavailableStatus);
            }
            throw cause;
          }
        }
        case "preview_open": {
          const input = normalizeAutomationOpenInput(
            decodeToolInput(PreviewAutomationOpenInput, rawArguments),
          );
          return toolResult(
            await runBrokerEffect(
              broker.invoke({
                threadId: scope.threadId,
                operation: "open",
                input: {
                  ...input,
                  show: input.show ?? true,
                  reuseExistingTab: input.reuseExistingTab ?? true,
                },
              }),
            ),
          );
        }
        case "preview_navigate": {
          const input = normalizeAutomationNavigateInput(
            decodeToolInput(PreviewAutomationNavigateInput, rawArguments),
          );
          return toolResult(
            await runBrokerEffect(
              invokeWithOptionalTimeout(broker, {
                threadId: scope.threadId,
                operation: "navigate",
                input,
                timeoutMs: input.timeoutMs,
              }),
            ),
          );
        }
        case "preview_snapshot":
          return snapshotToolResult(
            await runBrokerEffect(
              broker.invoke<PreviewAutomationSnapshot>({
                threadId: scope.threadId,
                operation: "snapshot",
                input: {},
              }),
            ),
          );
        case "preview_click": {
          const input = decodeToolInput(PreviewAutomationClickInput, rawArguments);
          await runBrokerEffect(
            invokeWithOptionalTimeout(broker, {
              threadId: scope.threadId,
              operation: "click",
              input,
              timeoutMs: input.timeoutMs,
            }),
          );
          return toolResult(null);
        }
        case "preview_type": {
          const input = decodeToolInput(PreviewAutomationTypeInput, rawArguments);
          await runBrokerEffect(
            invokeWithOptionalTimeout(broker, {
              threadId: scope.threadId,
              operation: "type",
              input,
              timeoutMs: input.timeoutMs,
            }),
          );
          return toolResult(null);
        }
        case "preview_press": {
          const input = decodeToolInput(PreviewAutomationPressInput, rawArguments);
          await runBrokerEffect(
            broker.invoke({ threadId: scope.threadId, operation: "press", input }),
          );
          return toolResult(null);
        }
        case "preview_scroll": {
          const input = decodeToolInput(PreviewAutomationScrollInput, rawArguments);
          await runBrokerEffect(
            broker.invoke({ threadId: scope.threadId, operation: "scroll", input }),
          );
          return toolResult(null);
        }
        case "preview_evaluate": {
          const input = decodeToolInput(PreviewAutomationEvaluateInput, rawArguments);
          return toolResult(
            await runBrokerEffect(
              invokeWithOptionalTimeout(broker, {
                threadId: scope.threadId,
                operation: "evaluate",
                input,
                timeoutMs: input.timeoutMs,
              }),
            ),
          );
        }
        case "preview_wait_for": {
          const input = decodeToolInput(PreviewAutomationWaitForInput, rawArguments);
          await runBrokerEffect(
            invokeWithOptionalTimeout(broker, {
              threadId: scope.threadId,
              operation: "waitFor",
              input,
              timeoutMs: input.timeoutMs,
            }),
          );
          return toolResult(null);
        }
        default:
          return toolErrorResult(
            new PreviewAutomationExecutionError({ message: `Unknown preview tool: ${name}` }),
          );
      }
    } catch (cause) {
      return toolErrorResult(cause);
    }
  };
}

function chooseServerName(existingServerNames?: ReadonlySet<string>): string {
  if (!existingServerNames?.has(PREVIEW_MCP_SERVER_NAME)) {
    return PREVIEW_MCP_SERVER_NAME;
  }
  let index = 2;
  while (existingServerNames.has(`${PREVIEW_MCP_SERVER_NAME}_${index}`)) {
    index += 1;
  }
  return `${PREVIEW_MCP_SERVER_NAME}_${index}`;
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
  readonly callTool: (
    token: string,
    name: string,
    rawArguments: unknown,
  ) => Promise<Record<string, unknown>>;
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
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "F5 Preview",
            version: "0.0.0",
          },
        }),
      );
    case "ping":
      return Promise.resolve(jsonRpcSuccess(request.id, {}));
    case "tools/list":
      return Promise.resolve(
        jsonRpcSuccess(request.id, {
          tools: PREVIEW_MCP_TOOLS.map(({ title, ...tool }) => ({
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

export const makePreviewMcpHttpServer = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker;
  const sessionsByToken = new Map<string, PreviewMcpSessionScope>();
  const tokenByEnvVar = new Map<string, string>();
  const callTool = makeToolCallHandler(broker, (token) => sessionsByToken.get(token));
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
      if (request.url !== MCP_ENDPOINT_PATH) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const token = readBearerToken(request);
      if (!token || !sessionsByToken.has(token)) {
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
            handleRpcRequest({
              request: asObject(entry) as JsonRpcRequest,
              token,
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
  const url = `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`;

  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );

  return {
    getUrl: () => url,
    createSessionConfig: (input) => {
      const token = nextToken();
      const envVarName = nextEnvVarName();
      const serverName = chooseServerName(input.existingServerNames);
      sessionsByToken.set(token, {
        threadId: input.threadId,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        issuedAt: new Date().toISOString(),
      });
      tokenByEnvVar.set(envVarName, token);

      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const storedToken = tokenByEnvVar.get(envVarName);
        tokenByEnvVar.delete(envVarName);
        if (storedToken) {
          sessionsByToken.delete(storedToken);
        }
      };

      return {
        serverName,
        serverDefinition: {
          type: "http",
          url,
          enabled: true,
          bearerTokenEnvVar: envVarName,
          supportsParallelToolCalls: false,
          startupTimeoutSec: 10,
          toolTimeoutSec: 65,
        },
        env: {
          [envVarName]: token,
        },
        dispose,
      };
    },
  } satisfies PreviewMcpHttpServerShape;
});

export const PreviewMcpHttpServerLive = Layer.effect(
  PreviewMcpHttpServer,
  makePreviewMcpHttpServer,
);
