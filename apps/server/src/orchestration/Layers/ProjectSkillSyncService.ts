import { CommandId, type OrchestrationEvent, type ProjectId } from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Deferred, Effect, Exit, FileSystem, Layer, Path, Ref, Scope, Stream } from "effect";
import os from "node:os";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectSkillSyncService,
  type ProjectSkillSyncServiceShape,
} from "../Services/ProjectSkillSyncService.ts";
import { buildProjectSkillFingerprint, scanProjectSkills } from "../projectSkills.ts";

type ProjectSkillRefreshEvent = Extract<
  OrchestrationEvent,
  { type: "project.created" | "project.meta-updated" | "project.deleted" }
>;

const projectSkillCommandId = (tag: string) =>
  CommandId.makeUnsafe(`project-skills:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, never>();
  const pendingRefreshRef = yield* Ref.make(false);
  const watcherScopeRef = yield* Ref.make<Scope.Closeable | null>(null);
  const userHome = os.homedir();

  const closeWatcherScope = Effect.gen(function* () {
    const watcherScope = yield* Ref.get(watcherScopeRef);
    if (watcherScope) {
      yield* Scope.close(watcherScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
      yield* Ref.set(watcherScopeRef, null);
    }
  });

  let worker!: DrainableWorker<string>;

  const queueRefresh = (reason: string) =>
    Ref.modify(pendingRefreshRef, (pending) => (pending ? [false, true] : [true, true])).pipe(
      Effect.flatMap((shouldEnqueue) => (shouldEnqueue ? worker.enqueue(reason) : Effect.void)),
    );

  const scanSkillsForProject = (projectId: ProjectId, workspaceRoot: string) =>
    scanProjectSkills({
      projectId,
      workspaceRoot,
      userHome,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const refreshAllProjects = () =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const activeProjects = readModel.projects.filter((project) => project.deletedAt === null);
      const watchPaths = new Set<string>();

      for (const project of activeProjects) {
        const scanResult = yield* scanSkillsForProject(project.id, project.workspaceRoot);

        for (const warning of scanResult.warnings) {
          yield* Effect.logWarning("omitting invalid Claude skill during scan", warning);
        }
        for (const watchPath of scanResult.watchPaths) {
          watchPaths.add(watchPath);
        }

        const currentFingerprint = buildProjectSkillFingerprint(project.skills ?? []);
        const nextFingerprint = buildProjectSkillFingerprint(scanResult.skills);
        if (currentFingerprint === nextFingerprint) {
          continue;
        }

        yield* orchestrationEngine.dispatch({
          type: "project.skills.replace",
          commandId: projectSkillCommandId("replace"),
          projectId: project.id,
          skills: [...scanResult.skills],
          updatedAt: new Date().toISOString(),
        });
      }

      yield* closeWatcherScope;
      if (watchPaths.size === 0) {
        return;
      }

      const watcherScope = yield* Scope.make("sequential");
      yield* Ref.set(watcherScopeRef, watcherScope);
      const queueFilesystemRefresh = queueRefresh("filesystem-change");

      yield* Effect.forEach(
        [...watchPaths].toSorted((left, right) => left.localeCompare(right)),
        (watchPath) =>
          Stream.runForEach(fs.watch(watchPath), () => queueFilesystemRefresh).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(watcherScope),
            Effect.asVoid,
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  worker = yield* makeDrainableWorker((reason: string) =>
    Ref.set(pendingRefreshRef, false).pipe(
      Effect.flatMap(() => refreshAllProjects()),
      Effect.catchCause((cause) =>
        Effect.logWarning("project skill refresh failed", {
          reason,
          cause: String(cause),
        }),
      ),
    ),
  );

  const handleDomainEvent = (event: ProjectSkillRefreshEvent) =>
    queueRefresh(`domain:${event.type}`);

  const start: ProjectSkillSyncServiceShape["start"] = Ref.modify(startedRef, (alreadyStarted) => [
    alreadyStarted,
    true,
  ]).pipe(
    Effect.flatMap((alreadyStarted) => {
      if (alreadyStarted) {
        return Deferred.await(startedDeferred);
      }

      return Effect.gen(function* () {
        yield* refreshAllProjects().pipe(Effect.ignoreCause({ log: true }));
        yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (
            event.type !== "project.created" &&
            event.type !== "project.meta-updated" &&
            event.type !== "project.deleted"
          ) {
            return Effect.void;
          }
          return handleDomainEvent(event);
        }).pipe(Effect.forkScoped, Effect.asVoid);
        yield* Effect.addFinalizer(() => closeWatcherScope);
        yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
      });
    }),
  );

  return {
    start,
    drain: worker.drain,
  } satisfies ProjectSkillSyncServiceShape;
});

export const ProjectSkillSyncServiceLive = Layer.effect(ProjectSkillSyncService, make);
