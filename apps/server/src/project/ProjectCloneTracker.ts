import { networkFailureDetail } from "../git/networkFailureDetail.ts";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Data, Effect, Fiber, Schema, Semaphore, type Scope } from "effect";
import { ProjectCloneJob, ProjectId, type ProjectCloneInput } from "@t3tools/contracts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";

class CloneInputError extends Data.TaggedError("CloneInputError")<{ message: string }> {}

export function normalizeCloneUrl(raw: string): string {
  const value = raw.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(value))
    return `https://github.com/${value.replace(/\.git$/, "")}.git`;
  if (/^git@[\w.-]+:[\w./-]+$/.test(value)) return value;
  const url = new URL(value);
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.username && !(url.protocol === "ssh:" && url.username === "git"))
  ) {
    throw new Error("Use an HTTPS repository URL without credentials, or a git SSH URL.");
  }
  return url.href;
}

export function validateCloneDirectory(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/<>:"|?*]/.test(name) ||
    /\p{Cc}/u.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error("Choose a single valid folder name for the clone.");
  }
}

/** Server-owned jobs outlive the palette and reconnects. Failed/cancelled directories are retained. */
export const makeProjectCloneTracker = Effect.fn(function* (input: {
  stateDir: string;
  git: Pick<GitCoreShape, "cloneRepository">;
  scope: Scope.Scope;
  onComplete: (job: ProjectCloneJob) => Effect.Effect<void, Error>;
}) {
  const file = path.join(input.stateDir, "project-clones.json");
  const jobs = new Map<string, ProjectCloneJob>();
  const fibers = new Map<string, Fiber.Fiber<void, never>>();
  const writes = yield* Semaphore.make(1);
  const slots = yield* Semaphore.make(2);
  const persisted = yield* Effect.tryPromise(async () => {
    try {
      return Schema.decodeUnknownSync(Schema.Array(ProjectCloneJob))(
        JSON.parse(await fs.readFile(file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // This optional job history must not prevent the profile server booting.
      // Preserve the original bytes for inspection; never overwrite a corrupt file.
      const quarantined = `${file}.corrupt-${randomUUID()}`;
      await fs.rename(file, quarantined);
      return { quarantined };
    }
  });
  const records = "quarantined" in persisted ? [] : persisted;
  if ("quarantined" in persisted)
    yield* Effect.logWarning("Invalid clone history moved aside", { path: persisted.quarantined });
  for (const job of records)
    jobs.set(
      job.operationId,
      job.status === "queued" || job.status === "cloning"
        ? {
            ...job,
            status: "failed",
            error:
              "Server restarted during cloning. Git may have removed incomplete data. Inspect the destination before retrying in a new folder.",
          }
        : job,
    );
  const persist = Effect.tryPromise(async () => {
    await fs.mkdir(input.stateDir, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify([...jobs.values()]));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  });
  if (records.some((job) => job.status === "queued" || job.status === "cloning")) yield* persist;
  const update = (id: string, patch: Partial<ProjectCloneJob>) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const job = jobs.get(id);
        if (!job || (patch.status === "cancelled" && job.status === "complete")) return;
        jobs.set(id, { ...job, ...patch });
        yield* persist;
      }),
    );
  const list = () => [...jobs.values()].map((job) => ({ ...job }));
  const start = (request: ProjectCloneInput) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const url = yield* Effect.try({
          try: () => normalizeCloneUrl(request.url),
          catch: (error) =>
            new CloneInputError({
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        yield* Effect.try({
          try: () => validateCloneDirectory(request.directoryName),
          catch: (error) =>
            new CloneInputError({
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        const parent = yield* Effect.tryPromise(() => fs.realpath(request.parentPath));
        const destination = path.join(parent, request.directoryName);
        const previous = jobs.get(request.operationId);
        if (previous) {
          if (previous.url !== url || previous.destination !== destination)
            return yield* Effect.fail(
              new Error(
                "Clone operation ID was already used for another repository or destination.",
              ),
            );
          return previous;
        }
        if (
          [...jobs.values()].filter((job) => job.status === "queued" || job.status === "cloning")
            .length >= 10
        )
          return yield* Effect.fail(
            new Error("Wait for a repository clone to finish before starting another."),
          );
        const job: ProjectCloneJob = {
          ...request,
          url,
          parentPath: parent,
          destination,
          projectId: ProjectId.makeUnsafe(request.operationId),
          status: "queued",
          progress: "Waiting to clone",
          error: null,
          createdAt: new Date().toISOString(),
        };
        // mkdir without recursive reserves a new destination and refuses existing data or symlinks.
        yield* Effect.tryPromise(() => fs.mkdir(destination));
        const original = new Map(jobs);
        jobs.set(job.operationId, job);
        for (const old of jobs.values()) {
          if (jobs.size <= 100) break;
          if (old.status !== "queued" && old.status !== "cloning") jobs.delete(old.operationId);
        }
        yield* persist.pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              jobs.clear();
              for (const [id, entry] of original) jobs.set(id, entry);
            }),
          ),
        );
        const run = slots
          .withPermits(1)(
            Effect.gen(function* () {
              yield* update(job.operationId, {
                status: "cloning",
                progress: "Connecting to repository",
              });
              const decoder = new TextDecoder();
              let tail = "";
              yield* input.git.cloneRepository({
                cwd: destination,
                url,
                onProgress: (chunk) => {
                  tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4096);
                  const matches = [
                    ...tail.matchAll(
                      /(Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d{1,3})%/g,
                    ),
                  ];
                  const match = matches.at(-1);
                  const live = jobs.get(job.operationId);
                  if (live && match)
                    jobs.set(job.operationId, { ...live, progress: `${match[1]}: ${match[2]}%` });
                },
              });
              // Once Git succeeds, finish registration atomically with respect to cancellation.
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* input.onComplete(job);
                  yield* update(job.operationId, { status: "complete", progress: "Project ready" });
                }),
              );
            }),
          )
          .pipe(
            Effect.catch((error) => {
              const detail = networkFailureDetail(error.message);
              return Effect.logWarning("Repository clone failed", {
                operationId: job.operationId,
                detail,
              }).pipe(
                Effect.andThen(
                  update(job.operationId, {
                    status: "failed",
                    error: `${detail} Git may have removed incomplete data. Inspect the destination before retrying in a new folder.`,
                  }),
                ),
              );
            }),
            Effect.onInterrupt(() =>
              update(job.operationId, {
                status: "cancelled",
                error:
                  "Clone cancelled. Git may have removed incomplete data. Inspect the destination before retrying.",
              }).pipe(Effect.orDie),
            ),
            Effect.ensuring(Effect.sync(() => fibers.delete(job.operationId))),
            Effect.catchCause((cause) => Effect.logError("Could not persist clone status", cause)),
          );
        const fiber = yield* run.pipe(Effect.interruptible, Effect.forkIn(input.scope));
        fibers.set(job.operationId, fiber);
        return job;
      }).pipe(Effect.uninterruptible),
    );
  const cancel = (id: string) =>
    Effect.gen(function* () {
      const job = jobs.get(id);
      if (
        !job ||
        job.status === "complete" ||
        job.status === "failed" ||
        job.status === "cancelled"
      )
        return;
      const fiber = fibers.get(id);
      if (fiber) yield* Fiber.interrupt(fiber);
    });
  return { start, list, cancel };
});
