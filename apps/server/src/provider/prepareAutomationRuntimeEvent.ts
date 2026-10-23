import { computerToolHeading } from "@t3tools/shared/computerAction";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { Effect, FileSystem, Option, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config";
import {
  extractToolResultImages,
  ingestToolResultImage,
  type ExtractedToolResultImage,
  type ToolResultImageRef,
} from "../orchestration/toolResultImages";

const computerEvents = new WeakSet<ProviderRuntimeEvent>();
export function carryPreparedComputerEvidence(
  from: ProviderRuntimeEvent,
  to: ProviderRuntimeEvent,
): void {
  if (computerEvents.has(from)) computerEvents.add(to);
}
export const isPreparedComputerEvent = (event: ProviderRuntimeEvent): boolean =>
  computerEvents.has(event);

/** Store bounded screenshots while provenance exists, then enqueue summaries and refs only. */
export function createAutomationRuntimeEventPreparer<E>(
  store: (
    event: ProviderRuntimeEvent,
    image: ExtractedToolResultImage,
  ) => Effect.Effect<ToolResultImageRef | null, E>,
) {
  return (event: ProviderRuntimeEvent): Effect.Effect<ProviderRuntimeEvent> =>
    Effect.gen(function* () {
      let safe = automationEventSanitizer.sanitize(event.threadId, event) as ProviderRuntimeEvent;
      if (
        safe.type === "item.started" ||
        safe.type === "item.updated" ||
        safe.type === "item.completed"
      ) {
        const { computerTool: _untrusted, ...payload } = safe.payload;
        safe = { ...safe, payload };
      }
      if (
        (event.type !== "item.started" &&
          event.type !== "item.updated" &&
          event.type !== "item.completed") ||
        !automationEventSanitizer.isComputerItem(event.threadId, event.itemId ?? event.eventId)
      )
        return safe;
      if (
        (safe.type === "item.started" ||
          safe.type === "item.updated" ||
          safe.type === "item.completed") &&
        computerToolHeading(readToolActivityPayload(safe.payload)?.mcpToolName, safe.payload.status)
      ) {
        safe = { ...safe, payload: { ...safe.payload, computerTool: true } };
        computerEvents.add(safe);
      }
      const extraction = extractToolResultImages(event.payload.data);
      if (!extraction.images.length && !extraction.omitted) return safe;
      const refs: ToolResultImageRef[] = [];
      let omitted = extraction.omitted;
      for (const image of extraction.images) {
        const ref = yield* store(event, image).pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (ref) refs.push(ref);
        else omitted += 1;
      }
      const prepared = {
        ...safe,
        payload: {
          ...safe.payload,
          ...(refs.length ? { mcpImages: refs } : {}),
          ...(omitted ? { mcpImagesOmitted: omitted } : {}),
        },
      } as ProviderRuntimeEvent;
      if (computerEvents.has(safe)) computerEvents.add(prepared);
      return prepared;
    });
}

export const makeToolResultImageStore = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  return (event: ProviderRuntimeEvent, image: ExtractedToolResultImage) =>
    Effect.gen(function* () {
      if (
        Option.isNone(config) ||
        Option.isNone(sql) ||
        Option.isNone(fileSystem) ||
        Option.isNone(path)
      )
        return null;
      // Unknown or plan-mode threads fail closed before any attachment is written.
      const threads = yield* sql.value<{ interactionMode: string }>`
      SELECT interaction_mode AS "interactionMode" FROM projection_threads WHERE thread_id = ${event.threadId}
    `;
      if (threads[0]?.interactionMode !== "default") return null;
      return yield* ingestToolResultImage({
        attachmentsDir: config.value.attachmentsDir,
        threadId: event.threadId,
        itemKey: event.itemId ?? event.eventId,
        activityId: event.eventId,
        image,
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql.value),
        Effect.provideService(FileSystem.FileSystem, fileSystem.value),
        Effect.provideService(Path.Path, path.value),
      );
    });
});

export const makeAutomationRuntimeEventPreparer = makeToolResultImageStore.pipe(
  Effect.map(createAutomationRuntimeEventPreparer),
);
