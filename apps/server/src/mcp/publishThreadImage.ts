import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CommandId, EventId, type ThreadId } from "@t3tools/contracts";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ingestActivityAttachment } from "../activityAttachments.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { openContainedFile } from "../assetHttp.ts";
import { sniffUploadImage } from "../attachmentUploads.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { ThreadToolError, keepThreadToolError } from "./threadMcpTools.ts";

const MAX_BYTES = 8 * 1024 * 1024;

/** Only explicitly published image bytes cross from temporary files into chat storage. */
export const makeThreadImagePublisher = (input: {
  engine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">;
  attachmentsDir: string;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<
      SqlClient.SqlClient | FileSystem.FileSystem | Path.Path
    >();
    return (threadId: ThreadId, sourcePath: string) =>
      Effect.gen(function* () {
        const model = yield* input.engine.getReadModel();
        const thread = model.threads.find(
          (entry) => entry.id === threadId && !entry.deletedAt && !entry.archivedAt,
        );
        const project = model.projects.find(
          (entry) => entry.id === thread?.projectId && !entry.deletedAt,
        );
        if (!thread || !project)
          return yield* new ThreadToolError({ message: "This thread is no longer active." });
        const workspace = threadWorkspaceCwd(thread, project);
        const roots = [workspace, input.attachmentsDir, os.tmpdir(), "/tmp"].filter(
          (root): root is string => !!root,
        );
        const bytes = yield* Effect.tryPromise({
          try: async () => {
            if (!path.isAbsolute(sourcePath)) throw new Error("Absolute path required");
            const root = roots.find((root) => {
              const relative = path.relative(root, sourcePath);
              return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
            });
            if (!root) throw new Error("Outside available directories");
            const file = await openContainedFile(root, path.relative(root, sourcePath));
            try {
              if ((await file.stat()).size > MAX_BYTES) throw new Error("Image too large");
              // Bound the read even if a writer grows the file after stat.
              const buffer = Buffer.alloc(MAX_BYTES + 1);
              let size = 0;
              while (size < buffer.length) {
                const read = await file.read(buffer, size, buffer.length - size, size);
                if (!read.bytesRead) break;
                size += read.bytesRead;
              }
              if (!size || size > MAX_BYTES) throw new Error("Invalid image size");
              return buffer.subarray(0, size);
            } finally {
              await file.close();
            }
          },
          catch: () =>
            new ThreadToolError({
              message:
                "Image could not be read. Use an existing image inside this thread's workspace or temporary directory, at most 8 MiB.",
            }),
        });
        const mimeType = sniffUploadImage(bytes);
        if (!mimeType)
          return yield* new ThreadToolError({
            message: "Unsupported image. Use PNG, JPEG, GIF or WebP.",
          });
        const id = randomUUID();
        const ref = yield* ingestActivityAttachment({
          attachmentsDir: input.attachmentsDir,
          threadId,
          itemKey: "published-image",
          activityId: id,
          file: { type: "image", name: path.basename(sourcePath), mimeType, bytes },
        }).pipe(Effect.provideServices(services));
        if (!ref)
          return yield* new ThreadToolError({
            message: "The conversation attachment budget is full.",
          });
        const createdAt = new Date().toISOString();
        yield* input.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(id),
          threadId,
          createdAt,
          activity: {
            id: EventId.makeUnsafe(id),
            kind: "tool.completed",
            tone: "tool",
            summary: "Published image",
            payload: {
              itemType: "mcp_tool_call",
              providerItemId: id,
              mcpToolName: "image_publish",
              status: "completed",
              mcpImages: [ref],
            },
            turnId: thread.latestTurn?.turnId ?? null,
            createdAt,
          },
        });
        const imagePath = resolveAttachmentPath({
          attachmentsDir: input.attachmentsDir,
          attachment: {
            type: "image",
            id: ref.attachmentId,
            name: path.basename(sourcePath),
            mimeType,
            sizeBytes: ref.sizeBytes,
          },
        })!;
        return {
          ...ref,
          path: imagePath,
          markdown: "![Screenshot](<" + pathToFileURL(imagePath).href + ">)",
          message:
            "Published to this conversation. Use the returned Markdown to show the image in your reply; do not use the original temporary path.",
        };
      }).pipe(
        Effect.mapError(
          keepThreadToolError(
            "Could not publish the image. Retry after refreshing the conversation.",
          ),
        ),
      );
  });
