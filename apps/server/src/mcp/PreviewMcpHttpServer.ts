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
  PreviewAutomationViewportInput,
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
import {
  asObject,
  chooseLocalMcpServerName,
  type LocalMcpToolDefinition,
  nextLocalMcpEnvVarName,
  nextLocalMcpToken,
  safeJsonText,
  startLocalMcpHttpServer,
  toolErrorResult,
  toolResult,
} from "./localMcpHttp.ts";

const MCP_ENDPOINT_PATH = "/mcp/preview";
const PREVIEW_MCP_SERVER_NAME = "__f5_preview";
const PREVIEW_MCP_ENV_PREFIX = "F5_PREVIEW_MCP_TOKEN_";

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

const PREVIEW_MCP_TOOLS: ReadonlyArray<LocalMcpToolDefinition> = [
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
      "Inspect the current page before interacting. Returns URL/title/loading state, visible text, interactive elements, diagnostics, and a PNG screenshot. Set save=true to retain the screenshot as an opaque artifact returned in savedScreenshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { save: { type: "boolean" } },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
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
  {
    name: "preview_viewport",
    title: "Resize browser preview",
    description: "Set the active preview viewport in CSS pixels.",
    inputSchema: {
      type: "object",
      required: ["width", "height"],
      additionalProperties: false,
      properties: {
        width: { type: "integer", minimum: 320 },
        height: { type: "integer", minimum: 320 },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Resize browser preview",
    },
  },
  {
    name: "preview_screenshot",
    title: "Capture preview screenshot",
    description: "Capture the active preview as an opaque PNG artifact.",
    inputSchema: emptyInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      title: "Capture preview screenshot",
    },
  },
  {
    name: "preview_recording_start",
    title: "Start preview recording",
    description: "Start a capability-gated WebM recording of the active preview tab.",
    inputSchema: emptyInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Start preview recording",
    },
  },
  {
    name: "preview_recording_stop",
    title: "Stop preview recording",
    description: "Stop the active preview recording and return its opaque artifact metadata.",
    inputSchema: emptyInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: "Stop preview recording",
    },
  },
];

const toolByName = new Map(PREVIEW_MCP_TOOLS.map((tool) => [tool.name, tool]));

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
                broker.invoke({
                  threadId: scope.threadId,
                  automationSessionId: token,
                  operation: "status",
                  input: {},
                }),
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
                automationSessionId: token,
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
                automationSessionId: token,
                operation: "navigate",
                input,
                timeoutMs: input.timeoutMs,
              }),
            ),
          );
        }
        case "preview_snapshot": {
          const input = decodeToolInput(
            Schema.Struct({ save: Schema.optional(Schema.Boolean) }),
            rawArguments,
          );
          return snapshotToolResult(
            await runBrokerEffect(
              broker.invoke<PreviewAutomationSnapshot>({
                threadId: scope.threadId,
                automationSessionId: token,
                operation: "snapshot",
                input,
              }),
            ),
          );
        }
        case "preview_click": {
          const input = decodeToolInput(PreviewAutomationClickInput, rawArguments);
          await runBrokerEffect(
            invokeWithOptionalTimeout(broker, {
              threadId: scope.threadId,
              automationSessionId: token,
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
              automationSessionId: token,
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
            broker.invoke({
              threadId: scope.threadId,
              automationSessionId: token,
              operation: "press",
              input,
            }),
          );
          return toolResult(null);
        }
        case "preview_scroll": {
          const input = decodeToolInput(PreviewAutomationScrollInput, rawArguments);
          await runBrokerEffect(
            broker.invoke({
              threadId: scope.threadId,
              automationSessionId: token,
              operation: "scroll",
              input,
            }),
          );
          return toolResult(null);
        }
        case "preview_evaluate": {
          const input = decodeToolInput(PreviewAutomationEvaluateInput, rawArguments);
          return toolResult(
            await runBrokerEffect(
              invokeWithOptionalTimeout(broker, {
                threadId: scope.threadId,
                automationSessionId: token,
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
              automationSessionId: token,
              operation: "waitFor",
              input,
              timeoutMs: input.timeoutMs,
            }),
          );
          return toolResult(null);
        }
        case "preview_viewport": {
          const input = decodeToolInput(PreviewAutomationViewportInput, rawArguments);
          return toolResult(
            await runBrokerEffect(
              broker.invoke({
                threadId: scope.threadId,
                automationSessionId: token,
                operation: "viewport",
                input,
              }),
            ),
          );
        }
        case "preview_screenshot":
          return toolResult(
            await runBrokerEffect(
              broker.invoke({
                threadId: scope.threadId,
                automationSessionId: token,
                operation: "screenshot",
                input: {},
              }),
            ),
          );
        case "preview_recording_start":
          return toolResult(
            await runBrokerEffect(
              broker.invoke({
                threadId: scope.threadId,
                automationSessionId: token,
                operation: "recordingStart",
                input: {},
              }),
            ),
          );
        case "preview_recording_stop":
          return toolResult(
            await runBrokerEffect(
              broker.invoke({
                threadId: scope.threadId,
                automationSessionId: token,
                operation: "recordingStop",
                input: {},
              }),
            ),
          );
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

export const makePreviewMcpHttpServer = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker;
  const sessionsByToken = new Map<string, PreviewMcpSessionScope>();
  const tokenByEnvVar = new Map<string, string>();
  const callTool = makeToolCallHandler(broker, (token) => sessionsByToken.get(token));

  const handle = yield* Effect.tryPromise({
    try: () =>
      startLocalMcpHttpServer({
        endpointPath: MCP_ENDPOINT_PATH,
        serverInfo: { name: "F5 Preview", version: "0.0.0" },
        tools: PREVIEW_MCP_TOOLS,
        isValidToken: (token) => sessionsByToken.has(token),
        callTool,
      }),
    catch: (cause) =>
      new PreviewMcpHttpServerError({
        message: cause instanceof Error ? cause.message : "Failed to start preview MCP server.",
        cause,
      }),
  });
  const url = handle.url;

  yield* Effect.addFinalizer(() => Effect.promise(() => handle.close()));

  return {
    getUrl: () => url,
    createSessionConfig: (input) => {
      const token = nextLocalMcpToken();
      const envVarName = nextLocalMcpEnvVarName(PREVIEW_MCP_ENV_PREFIX);
      const serverName = chooseLocalMcpServerName(
        PREVIEW_MCP_SERVER_NAME,
        input.existingServerNames,
      );
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
