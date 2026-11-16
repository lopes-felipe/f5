import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProviderEvent } from "@t3tools/contracts";
import { isNetworkPath } from "@t3tools/shared/path";
import { Cause, Effect, FileSystem, Option, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config";
import { sniffUploadImage } from "../attachmentUploads";
import { ingestActivityAttachment } from "../activityAttachments";
import { resolveAttachmentPath } from "../attachmentStore";

const MAX_BYTES = 8 * 1024 * 1024;

/** Import only the bounded image named by a native image-generation completion. */
export const makeCodexGeneratedImageStore = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  return (event: ProviderEvent): Effect.Effect<ProviderEvent> =>
    Effect.gen(function* () {
      const item = (event.payload as { item?: Record<string, unknown> } | undefined)?.item;
      if (
        event.method !== "item/completed" ||
        item?.type !== "imageGeneration" ||
        item.status !== "completed" ||
        item.failure != null
      )
        return event;
      const source = item.savedPath ?? item.saved_path;
      let imported: string | null = null;
      if (
        typeof source === "string" &&
        isAbsolute(source) &&
        !isNetworkPath(source) &&
        Option.isSome(config) &&
        Option.isSome(sql) &&
        Option.isSome(fs) &&
        Option.isSome(path)
      ) {
        imported = yield* Effect.gen(function* () {
          const bytes = yield* Effect.tryPromise(async () => {
            const file = await open(
              source,
              constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
            );
            try {
              const stat = await file.stat();
              if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return null;
              const buffer = Buffer.alloc(stat.size + 1);
              let length = 0;
              while (length < buffer.length) {
                const read = await file.read(buffer, length, buffer.length - length, null);
                if (!read.bytesRead) break;
                length += read.bytesRead;
              }
              return length === stat.size ? buffer.subarray(0, length) : null;
            } finally {
              await file.close();
            }
          });
          if (!bytes) return null;
          const mimeType = sniffUploadImage(bytes);
          if (!mimeType) return null;
          const name = "generated-image";
          const ref = yield* ingestActivityAttachment({
            attachmentsDir: config.value.attachmentsDir,
            threadId: event.threadId,
            itemKey: event.itemId ?? event.id,
            activityId: event.id,
            file: { type: "image", name, mimeType, bytes },
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql.value),
            Effect.provideService(FileSystem.FileSystem, fs.value),
            Effect.provideService(Path.Path, path.value),
          );
          return ref
            ? resolveAttachmentPath({
                attachmentsDir: config.value.attachmentsDir,
                attachment: {
                  type: "image",
                  id: ref.attachmentId,
                  name,
                  mimeType,
                  sizeBytes: ref.sizeBytes,
                },
              })
            : null;
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(null),
          ),
        );
      }
      // Never publish an unservable arbitrary host path as an image embed.
      return {
        ...event,
        payload: {
          ...(event.payload as object),
          item: { ...item, f5ImagePath: imported },
        },
      };
    });
});
