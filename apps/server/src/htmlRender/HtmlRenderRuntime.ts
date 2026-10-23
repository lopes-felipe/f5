import { randomUUID } from "node:crypto";
import {
  CommandId,
  EventId,
  type HtmlRenderInput,
  type HtmlPreviewInput,
  type ThreadId,
} from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd, type WorkspaceThread } from "@t3tools/shared/threadWorkspace";
import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ingestActivityAttachment } from "../activityAttachments.ts";
import { ThreadToolError } from "../mcp/threadMcpTools.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { prepareHtmlRender } from "./prepareHtmlRender.ts";
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
          catch: () =>
            new ThreadToolError({
              message:
                "Could not prepare HTML. Keep images inside the project, worktree or attachments, with at most 512 KiB of HTML and 25 MiB after image inlining.",
            }),
        });
      });
    const publish = (threadId: ThreadId, value: HtmlRenderInput) =>
      Effect.gen(function* () {
        const html = yield* prepare(threadId, value.html);
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
          height: value.height,
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
        return reference;
      }).pipe(
        Effect.mapError(
          () =>
            new ThreadToolError({
              message:
                "The HTML render could not be saved. Check image paths and the generated attachment budget.",
            }),
        ),
      );
    const preview = (threadId: ThreadId, value: HtmlPreviewInput) =>
      prepare(threadId, value.html).pipe(
        Effect.flatMap((html) =>
          input.preview.render(threadId, {
            html,
            width: value.width ?? 728,
            appearance: value.appearance ?? "dark",
          }),
        ),
      );
    return { publish, preview };
  });
