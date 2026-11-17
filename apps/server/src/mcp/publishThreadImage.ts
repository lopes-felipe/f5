import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
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
/** Dispatch failures that guarantee the command was not stored. */
const UNSENT_DISPATCH_ERRORS = new Set([
  "OrchestrationOverloadError",
  "OrchestrationCommandInvariantError",
  "OrchestrationCommandPreviouslyRejectedError",
  "OrchestrationCommandIdConflictError",
]);

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const realpathOrNull = (target: string) => realpath(target).catch(() => null);

/**
 * Opens `sourcePath` only when its canonical location is inside one of `roots` and outside
 * `excluded`. Roots and the source's parent directory are compared after resolving symlinks,
 * so aliases such as macOS `/tmp` -> `/private/tmp` match either spelling. The file itself
 * must not be a link; `openContainedFile` enforces that and guards against swaps.
 */
async function openPublishableImage(input: {
  readonly sourcePath: string;
  readonly roots: ReadonlyArray<string>;
  readonly excluded: ReadonlyArray<string>;
}) {
  if (!path.isAbsolute(input.sourcePath)) throw new Error("Absolute path required");
  const normalized = path.resolve(input.sourcePath);
  const parent = await realpath(path.dirname(normalized));
  const resolved = path.join(parent, path.basename(normalized));
  const excluded = await Promise.all(input.excluded.map(realpathOrNull));
  if (excluded.some((dir) => dir && (dir === resolved || isInside(dir, resolved))))
    throw new Error("Outside available directories");
  const roots = await Promise.all(input.roots.map(realpathOrNull));
  const root = roots.find((dir): dir is string => !!dir && isInside(dir, resolved));
  if (!root) throw new Error("Outside available directories");
  const relative = path.relative(root, resolved);
  // `openContainedFile` splits on both separators. On POSIX a backslash is part of the
  // filename, so `a\b.png` would open `a/b.png` instead.
  if (path.sep === "/" && relative.includes("\\")) throw new Error("Unsupported file name");
  return openContainedFile(root, relative);
}

/** Only explicitly published image bytes cross from temporary files into chat storage. */
export const makeThreadImagePublisher = (input: {
  engine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">;
  attachmentsDir: string;
  /** Temporary directories agents may publish from; defaults to the OS temp dir and /tmp. */
  temporaryDirectories?: ReadonlyArray<string>;
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
        // The shared attachment store holds every thread's uploads, so it is never a source,
        // even when it happens to live under an allowed directory.
        const roots = [workspace, ...(input.temporaryDirectories ?? [os.tmpdir(), "/tmp"])].filter(
          (root): root is string => !!root,
        );
        const bytes = yield* Effect.tryPromise({
          try: async () => {
            const file = await openPublishableImage({
              sourcePath,
              roots,
              excluded: [input.attachmentsDir],
            });
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
        // Release this activity's claim when the command was refused before it was stored, so
        // the attachment stops counting toward the thread budget and cleanup can reclaim it.
        // Any other failure may come after the event committed, so the claim stays.
        const releaseUnsentOwner = (error: { readonly _tag: string }) =>
          UNSENT_DISPATCH_ERRORS.has(error._tag)
            ? Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql`
                  DELETE FROM attachment_owners
                  WHERE attachment_id = ${ref.attachmentId}
                    AND owner_kind = 'activity' AND owner_id = ${id}
                `;
              }).pipe(Effect.provideServices(services), Effect.ignore)
            : Effect.void;
        yield* input.engine
          .dispatch({
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
          })
          .pipe(Effect.tapError(releaseUnsentOwner));
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
        // The stored path stays server-side; agents only need the renderable Markdown.
        return {
          ...ref,
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
