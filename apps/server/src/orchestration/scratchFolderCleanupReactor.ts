import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { isScratchProject, isScratchThreadFolder } from "@t3tools/shared/scratchProject";
import { Effect, Stream, type Scope } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

/**
 * Removes a thread's own scratch folder once the thread is deleted. `thread.deleted` is final,
 * and without this the folders, named after the first words of each prompt, stay in the state
 * directory forever. Only a folder directly below the scratch project's root that no other
 * live thread uses is removed; any failure is logged and leaves the folder.
 */
export function startScratchFolderCleanupReactor(
  orchestrationEngine: OrchestrationEngineShape,
  remove: (folder: string) => Promise<void> = (folder) =>
    NodeFS.rm(folder, { recursive: true, force: true }),
): Effect.Effect<void, never, Scope.Scope> {
  const cleanUp = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      const folder = thread?.scratchPath;
      if (!thread || thread.deletedAt === null || !folder) return;
      const project = readModel.projects.find((entry) => entry.id === thread.projectId);
      if (
        !project ||
        !isScratchProject(project) ||
        !isScratchThreadFolder(project.workspaceRoot, folder)
      )
        return;
      const shared = readModel.threads.some(
        (entry) =>
          entry.id !== threadId && entry.deletedAt === null && entry.scratchPath === folder,
      );
      if (shared) return;
      // A folder replaced by a link would otherwise be followed to somewhere outside the root.
      // A thread that never sent a message has no folder yet.
      const real = yield* Effect.promise(() =>
        Promise.all([NodeFS.realpath(project.workspaceRoot), NodeFS.realpath(folder)]).catch(
          (error: NodeJS.ErrnoException) =>
            error.code === "ENOENT" ? null : Promise.reject(error),
        ),
      );
      if (real === null || NodePath.dirname(real[1]) !== real[0]) return;
      yield* Effect.promise(() => remove(folder));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not remove a deleted thread's scratch folder", {
          threadId,
          cause,
        }),
      ),
    );

  return Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    event.type === "thread.deleted" ? cleanUp(event.payload.threadId) : Effect.void,
  ).pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid);
}
