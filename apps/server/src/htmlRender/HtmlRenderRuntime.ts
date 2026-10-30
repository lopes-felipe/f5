import { randomUUID } from "node:crypto";
import {
  CommandId,
  EventId,
  HTML_RENDER_MAX_REFERENCE_HEIGHT,
  HTML_RENDER_MIN_REFERENCE_HEIGHT,
  type HtmlRenderInput,
  type HtmlPreviewInput,
  type HtmlPreviewResult,
  type ThreadId,
} from "@t3tools/contracts";
import { HTML_RENDER_COLUMN_WIDTH, HTML_RENDER_MAX_FIT_HEIGHT } from "@t3tools/shared/htmlRender";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd, type WorkspaceThread } from "@t3tools/shared/threadWorkspace";
import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ingestActivityAttachment } from "../activityAttachments.ts";
import { ThreadToolError } from "../mcp/threadMcpTools.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { HtmlRenderPrepareError, prepareHtmlRender } from "./prepareHtmlRender.ts";
import type { makeHtmlPreviewBroker } from "./HtmlPreviewBroker.ts";

/**
 * Folders whose absolute image paths a page may inline. A scratch thread gets
 * only its own folder, never the shared scratch root its siblings live in.
 */
export const htmlRenderImageRoots = (
  thread: WorkspaceThread,
  project: { readonly kind?: string | undefined; readonly workspaceRoot: string },
  attachmentsDir: string,
): ReadonlyArray<string> => {
  if (isScratchProject(project)) {
    const workspace = threadWorkspaceCwd(thread, project);
    return [...(workspace ? [workspace] : []), attachmentsDir];
  }
  return [
    project.workspaceRoot,
    ...(thread.worktreePath ? [thread.worktreePath] : []),
    attachmentsDir,
  ];
};

const withDiagnostics = (
  result: HtmlPreviewResult,
  missing: { readonly paths: ReadonlyArray<string>; readonly omitted: number },
): HtmlPreviewResult =>
  result._tag !== "Ready"
    ? result
    : {
        ...result,
        ...(missing.paths.length ? { missingImages: [...missing.paths] } : {}),
        ...(missing.omitted ? { missingImagesOmitted: missing.omitted } : {}),
        ...(result.contentHeight > HTML_RENDER_MAX_FIT_HEIGHT
          ? {
              note: `Inline frames show at most ${HTML_RENDER_MAX_FIT_HEIGHT}px; the rest is only reachable full screen. Shorten the page.`,
            }
          : {}),
      };

export const makeHtmlRenderRuntime = (input: {
  readonly engine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">;
  readonly attachmentsDir: string;
  readonly preview: ReturnType<typeof makeHtmlPreviewBroker>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const prepare = (threadId: ThreadId, html: string) =>
      Effect.gen(function* () {
        const model = yield* input.engine.getReadModel();
        const thread = model.threads.find((thread) => thread.id === threadId && !thread.deletedAt);
        const project =
          thread &&
          model.projects.find((project) => project.id === thread.projectId && !project.deletedAt);
        if (!thread || !project)
          return yield* new ThreadToolError({ message: "This thread's project is unavailable." });
        return yield* Effect.tryPromise({
          try: () =>
            prepareHtmlRender(html, htmlRenderImageRoots(thread, project, input.attachmentsDir)),
          catch: (error) =>
            new ThreadToolError({
              message:
                error instanceof HtmlRenderPrepareError
                  ? error.message
                  : "Could not prepare HTML. Keep images inside the project, worktree or attachments, with at most 512 KiB of HTML and 25 MiB after image inlining.",
            }),
        });
      });
    const publish = (threadId: ThreadId, value: HtmlRenderInput) =>
      Effect.gen(function* () {
        const { html, missing } = yield* prepare(threadId, value.html);
        if (missing.paths.length)
          return yield* new ThreadToolError({
            message: `These local images could not be read: ${missing.paths.join(", ")}${missing.omitted ? `, and ${missing.omitted} more` : ""}. Use absolute paths to existing image files inside the project, worktree or attachments, or remove them.`,
          });
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const model = yield* input.engine.getReadModel();
        const thread = model.threads.find(
          (thread) => thread.id === threadId && !thread.deletedAt && !thread.archivedAt,
        );
        if (!thread)
          return yield* new ThreadToolError({ message: "This thread is no longer active." });
        const attachment = yield* ingestActivityAttachment({
          attachmentsDir: input.attachmentsDir,
          threadId,
          itemKey: `html:${id}`,
          activityId: id,
          file: {
            type: "file",
            name: "render.html",
            mimeType: "text/html",
            bytes: Buffer.from(html),
          },
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        if (!attachment)
          return yield* new ThreadToolError({
            message: "The generated attachment budget is full.",
          });
        const reference = {
          attachmentId: attachment.attachmentId,
          title: value.title.trim() || "HTML",
          height: Math.max(
            HTML_RENDER_MIN_REFERENCE_HEIGHT,
            Math.min(HTML_RENDER_MAX_REFERENCE_HEIGHT, value.height),
          ),
        };
        yield* input.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`html:${id}`),
          threadId,
          createdAt,
          activity: {
            id: EventId.makeUnsafe(id),
            tone: "tool",
            kind: "htmlRender",
            summary: reference.title,
            payload: { htmlRender: reference },
            turnId: thread.latestTurn?.turnId ?? null,
            createdAt,
          },
        });
        return {
          htmlRender: reference,
          message:
            "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
        };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof ThreadToolError
            ? error
            : new ThreadToolError({
                message:
                  "The HTML render could not be saved. Check image paths and the generated attachment budget.",
              }),
        ),
      );
    const preview = (threadId: ThreadId, value: HtmlPreviewInput) =>
      prepare(threadId, value.html).pipe(
        Effect.flatMap(({ html, missing }) =>
          input.preview
            .render(threadId, {
              html,
              width: value.width ?? HTML_RENDER_COLUMN_WIDTH,
              appearance: value.appearance ?? "dark",
            })
            .pipe(Effect.map((result) => withDiagnostics(result, missing))),
        ),
      );
    return { publish, preview };
  });
