import { registerShutdown } from "../../shutdown.ts";
import { CommandId, type ProjectId } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import {
  makeBackgroundWorker,
  type BackgroundWorker as DrainableWorker,
} from "../../backgroundWorker.ts";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectSkillSyncService,
  type ProjectSkillSyncServiceShape,
} from "../Services/ProjectSkillSyncService.ts";
import {
  buildProjectSkillFingerprint,
  scanProjectSkills,
  type ProjectSkillScanWarning,
} from "../projectSkills.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const startedRef = yield* Ref.make(false);
  const started = yield* Deferred.make<void>();
  const dirty = new Set<ProjectId>();
  const pathsByProject = new Map<ProjectId, ReadonlyArray<string>>();
  const warnings = new Map<ProjectId, ReadonlyArray<ProjectSkillScanWarning>>();
  const watchers = new Map<string, { scope: Scope.Closeable; projects: Set<ProjectId> }>();
  const failedWatchPaths = new Set<string>();
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker!: DrainableWorker<void>;
  let poller: Fiber.Fiber<unknown, never> | undefined;

  const queueRefresh = (ids: Iterable<ProjectId>) =>
    Effect.sync(() => {
      if (stopping) return;
      for (const id of ids) dirty.add(id);
      if (timer !== undefined || dirty.size === 0) return;
      timer = setTimeout(() => {
        timer = undefined;
        void Effect.runPromise(worker.enqueue(undefined));
      }, 150);
      timer.unref?.();
    });

  const reconcileWatchers = Effect.gen(function* () {
    if (stopping) return;
    const desired = new Map<string, Set<ProjectId>>();
    for (const [id, paths] of pathsByProject) {
      for (const path of paths) {
        const projects = desired.get(path) ?? new Set<ProjectId>();
        projects.add(id);
        desired.set(path, projects);
      }
    }
    for (const path of failedWatchPaths) if (!desired.has(path)) failedWatchPaths.delete(path);
    for (const [path, watcher] of watchers) {
      if (!desired.has(path) || failedWatchPaths.has(path)) {
        watchers.delete(path);
        yield* Scope.close(watcher.scope, Exit.void);
      }
    }
    for (const [path, projects] of desired) {
      const existing = watchers.get(path);
      if (existing) {
        existing.projects = projects;
        continue;
      }
      const watcherScope = yield* Scope.make("sequential");
      const watcher = { scope: watcherScope, projects };
      watchers.set(path, watcher);
      failedWatchPaths.delete(path);
      yield* Stream.runForEach(fs.watch(path), () =>
        queueRefresh(watchers.get(path)?.projects ?? []),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (watchers.get(path) !== watcher) return;
            failedWatchPaths.add(path);
            const reason = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "Watch stream ended";
            for (const id of watcher.projects)
              warnings.set(id, [
                ...(warnings.get(id) ?? []),
                {
                  scope: "project",
                  commandName: "",
                  path,
                  reason: `Skill watcher unavailable; polling will retry: ${reason}`,
                },
              ]);
          }),
        ),
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(watcherScope),
      );
    }
  });

  const refresh = Effect.gen(function* () {
    const model = yield* engine.getReadModel();
    const ids = new Set(dirty);
    dirty.clear();
    const active = new Set(
      model.projects
        .filter((project) => project.deletedAt === null && !isScratchProject(project))
        .map((project) => project.id),
    );
    for (const id of pathsByProject.keys()) {
      if (!active.has(id)) {
        pathsByProject.delete(id);
        warnings.delete(id);
      }
    }
    for (const project of model.projects) {
      if (!active.has(project.id) || !ids.has(project.id)) continue;
      yield* Effect.gen(function* () {
        const result = yield* scanProjectSkills({
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
        });
        pathsByProject.set(project.id, result.watchPaths);
        warnings.set(project.id, result.warnings);
        if (
          buildProjectSkillFingerprint(project.skills ?? []) !==
          buildProjectSkillFingerprint(result.skills)
        ) {
          yield* engine.dispatch({
            type: "project.skills.replace",
            commandId: CommandId.makeUnsafe(`project-skills:${crypto.randomUUID()}`),
            projectId: project.id,
            skills: [...result.skills],
            updatedAt: new Date().toISOString(),
          });
        }
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          dirty.add(project.id);
          return Effect.logWarning("project skill refresh failed; queued for retry", {
            projectId: project.id,
            cause: Cause.pretty(cause),
          });
        }),
      );
    }
  }).pipe(Effect.ensuring(reconcileWatchers));

  worker = yield* makeBackgroundWorker(
    () =>
      refresh.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project skill refresh failed", { cause: String(cause) }),
        ),
      ),
    { name: "ProjectSkillSyncService", key: () => "projects" },
  );

  const drain = Effect.gen(function* () {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    for (const [id, paths] of pathsByProject)
      if (paths.some((path) => failedWatchPaths.has(path))) dirty.add(id);
    if (!stopping && dirty.size > 0) yield* worker.enqueue(undefined);
    yield* worker.drain;
  });

  const stopSources = Effect.gen(function* () {
    stopping = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (poller) {
      yield* Fiber.interrupt(poller);
      poller = undefined;
    }
    for (const [path, watcher] of watchers) {
      watchers.delete(path);
      yield* Scope.close(watcher.scope, Exit.void);
    }
  });
  yield* registerShutdown("project-skill-sources", "admission", () => stopSources);
  yield* registerShutdown("project-skill-work", "drain", () => worker.drain);

  const start: ProjectSkillSyncServiceShape["start"] = Ref.getAndSet(startedRef, true).pipe(
    Effect.flatMap((alreadyStarted) =>
      alreadyStarted
        ? Deferred.await(started)
        : Effect.gen(function* () {
            yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
              event.type === "project.created" ||
              event.type === "project.meta-updated" ||
              event.type === "project.deleted"
                ? queueRefresh([event.aggregateId as ProjectId])
                : Effect.void,
            ).pipe(Effect.forkIn(scope, { startImmediately: true }));
            for (const project of (yield* engine.getReadModel()).projects) dirty.add(project.id);
            yield* drain.pipe(Effect.orDie);
            // Watch failures/deleted roots recover even if the OS emits no final event.
            poller = yield* Effect.sync(
              () =>
                new Set([
                  ...dirty,
                  ...[...pathsByProject]
                    .filter(([, paths]) => paths.some((path) => failedWatchPaths.has(path)))
                    .map(([id]) => id),
                ]),
            ).pipe(
              Effect.flatMap(queueRefresh),
              Effect.repeat(Schedule.spaced("30 seconds")),
              Effect.forkIn(scope),
            );
            yield* Deferred.succeed(started, undefined);
          }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    stopSources.pipe(Effect.andThen(Effect.sync(() => failedWatchPaths.clear()))),
  );

  return {
    start,
    drain,
    getWarnings: (projectId) => Effect.sync(() => warnings.get(projectId) ?? []),
  } satisfies ProjectSkillSyncServiceShape;
});

export const ProjectSkillSyncServiceLive = Layer.effect(ProjectSkillSyncService, make);
