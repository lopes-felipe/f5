import {
  HtmlRenderInput,
  HtmlPreviewInput,
  HtmlPreviewResult,
  type ThreadId,
} from "@t3tools/contracts";
import { Data, Effect, Exit, Layer, Option, Schema, ServiceMap } from "effect";
import { z } from "zod";
import { previewToolResult, type McpToolResult } from "./previewMcpTools.ts";

export class ThreadToolError extends Data.TaggedError("ThreadToolError")<{
  readonly message: string;
}> {}

const GuideTarget = Schema.Struct({
  pr: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
});
export type ThreadToolRequest =
  | { readonly name: "thread_status" }
  | { readonly name: "thread_settle" }
  | { readonly name: "html_render"; readonly input: HtmlRenderInput }
  | { readonly name: "html_preview"; readonly input: HtmlPreviewInput }
  | {
      readonly name:
        | "pull_request_review_guide_read"
        | "pull_request_review_guide_write"
        | "watch_pull_request"
        | "unwatch_pull_request";
      readonly pr?: string | undefined;
    };
export type ThreadToolHandler = (
  threadId: ThreadId,
  request: ThreadToolRequest,
) => Effect.Effect<unknown, ThreadToolError>;

/** Runtime ownership is scoped separately from provider construction to avoid a provider/orchestrator cycle. */
export class ThreadMcpBroker extends ServiceMap.Service<
  ThreadMcpBroker,
  {
    readonly register: (
      handler: ThreadToolHandler,
    ) => Effect.Effect<void, ThreadToolError, import("effect").Scope.Scope>;
    readonly call: ThreadToolHandler;
  }
>()("t3/mcp/threadMcpTools/ThreadMcpBroker") {}

export const makeThreadMcpBroker = Effect.sync(() => {
  let current: ThreadToolHandler | undefined;
  return {
    register: (handler: ThreadToolHandler) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (current)
            return Effect.fail(
              new ThreadToolError({ message: "Thread tools already have a runtime owner." }),
            );
          current = handler;
          return Effect.void;
        }),
        () =>
          Effect.sync(() => {
            if (current === handler) current = undefined;
          }),
      ),
    call: (threadId: ThreadId, request: ThreadToolRequest) =>
      Effect.suspend(() =>
        current
          ? current(threadId, request).pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                () =>
                  new ThreadToolError({
                    message: "Thread tool failed or timed out. Retry after refreshing the thread.",
                  }),
              ),
            )
          : Effect.fail(
              new ThreadToolError({
                message: "Thread tools are unavailable while the server starts or stops.",
              }),
            ),
      ),
  };
});
export const ThreadMcpBrokerLive = Layer.effect(ThreadMcpBroker, makeThreadMcpBroker);

const guideShape = {
  pr: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      "Pull request URL or F5 PR key. Omit only when this thread has exactly one linked pull request.",
    ),
};
const annotations = (readOnlyHint: boolean) => ({
  readOnlyHint,
  destructiveHint: false,
  idempotentHint: readOnlyHint,
  openWorldHint: !readOnlyHint,
});
export const THREAD_TOOL_DEFINITIONS = [
  {
    name: "thread_settle",
    title: "Settle thread",
    description:
      "Mark this thread done but keep its history. If this turn is still running, settlement waits for it to finish. New user activity or Stop cancels a pending settlement.",
    shape: {},
    annotations: annotations(false),
    alwaysLoad: false,
  },
  {
    name: "thread_status",
    title: "Get thread status",
    description: "Read this thread's status, current turn and snooze state.",
    shape: {},
    annotations: annotations(true),
    alwaysLoad: true,
  },
  {
    name: "pull_request_review_guide_read",
    title: "Read PR review guide",
    description:
      "Read a saved review tour and its running/failed state. Includes the current head so stale guides can be detected.",
    shape: guideShape,
    annotations: annotations(true),
    alwaysLoad: false,
  },
  {
    name: "pull_request_review_guide_write",
    title: "Write PR review guide",
    description:
      "Start generating a review tour with F5's configured text model. Returns immediately; read the guide to follow its progress. Joins an existing run for this PR.",
    shape: guideShape,
    annotations: annotations(false),
    alwaysLoad: false,
  },
  {
    name: "watch_pull_request",
    title: "Watch PR",
    description:
      "Watch a PR and queue follow-ups when checks or review comments change. Starts only on request and stops with the thread or PR.",
    shape: guideShape,
    annotations: annotations(false),
    alwaysLoad: false,
  },
  {
    name: "unwatch_pull_request",
    title: "Stop watching PR",
    description: "Stop a PR watch in this thread. Omit the PR to stop all watches in this thread.",
    shape: guideShape,
    annotations: annotations(false),
    alwaysLoad: false,
  },
  {
    name: "html_render",
    title: "Render HTML in thread",
    description:
      "Save an HTML page in this thread. Local absolute image paths must stay inside the project, worktree or attachments. JavaScript runs in a sandboxed frame. The page sits on the thread's background, so leave html, body and the outermost element without a background color; a box that needs its own background gets at least 16px of padding and rounded corners.",
    shape: {
      html: z.string().max(512 * 1024),
      title: z.string().min(1).max(80),
      height: z.number().int().min(120).max(2000),
    },
    annotations: annotations(false),
    alwaysLoad: false,
  },
  {
    name: "html_preview",
    title: "Preview HTML screenshot",
    description:
      "Render HTML in the connected desktop and return a PNG, content height and console output. No browser download is needed. html_render also works without a desktop.",
    shape: {
      html: z.string().max(512 * 1024),
      width: z.number().int().min(200).max(2000).optional(),
      appearance: z.enum(["light", "dark"]).optional(),
    },
    annotations: annotations(false),
    alwaysLoad: false,
  },
] as const;
export const THREAD_TOOL_TIMEOUT_MS = 35_000;
export function threadToolInputJsonSchema(tool: {
  readonly shape: z.ZodRawShape;
}): Record<string, unknown> {
  return z.toJSONSchema(z.object(tool.shape)) as Record<string, unknown>;
}
export async function callThreadTool(
  context: {
    readonly broker: Pick<ThreadMcpBroker["Service"], "call">;
    readonly threadId: ThreadId;
  },
  name: string,
  arguments_: unknown,
): Promise<McpToolResult> {
  const decoded = Effect.try({
    try: (): ThreadToolRequest => {
      if (name === "html_render")
        return { name, input: Schema.decodeUnknownSync(HtmlRenderInput)(arguments_ ?? {}) };
      if (name === "html_preview")
        return { name, input: Schema.decodeUnknownSync(HtmlPreviewInput)(arguments_ ?? {}) };
      if (name === "thread_status" || name === "thread_settle") {
        Schema.decodeUnknownSync(Schema.Struct({}))(arguments_ ?? {});
        return { name };
      }
      if (
        name === "pull_request_review_guide_read" ||
        name === "pull_request_review_guide_write" ||
        name === "watch_pull_request" ||
        name === "unwatch_pull_request"
      )
        return { name, ...Schema.decodeUnknownSync(GuideTarget)(arguments_ ?? {}) };
      throw new Error("Unknown tool");
    },
    catch: () => new ThreadToolError({ message: "Unknown thread tool or invalid input." }),
  });
  const result = await Effect.runPromiseExit(
    decoded.pipe(Effect.flatMap((request) => context.broker.call(context.threadId, request))),
  );
  if (Exit.isSuccess(result) && name === "html_preview") {
    const decoded = Schema.decodeUnknownOption(HtmlPreviewResult)(result.value);
    if (Option.isNone(decoded))
      return {
        content: [{ type: "text", text: "The desktop returned an invalid preview." }],
        isError: true,
      };
    const preview = decoded.value;
    if (preview._tag === "Ready") {
      const { png, ...description } = preview;
      return {
        ...previewToolResult(description),
        content: [
          { type: "image", data: png, mimeType: "image/png" },
          ...previewToolResult(description).content,
        ],
      };
    }
  }
  return Exit.isSuccess(result)
    ? previewToolResult(result.value)
    : {
        content: [
          {
            type: "text",
            text: "Thread tool could not complete. Check the input and current thread, then retry.",
          },
        ],
        isError: true,
      };
}
