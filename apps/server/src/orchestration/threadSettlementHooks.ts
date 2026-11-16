import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { CommandId, EventId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import {
  Cause,
  Clock,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import {
  withRepositoryLifecycleLock,
  withWorktreeLifecycleLock,
} from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { runOwnedProjectScript } from "../project/runOwnedProjectScript.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

class SettlementScriptSnapshotError extends Data.TaggedError("SettlementScriptSnapshotError") {}

interface HookJob {
  threadId: string;
  jobId: string;
  settledAt: string;
  worktreePath: string;
  projectId: string;
  scriptsJson: string;
}
export const makeThreadSettlementHooks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  const git = yield* Effect.serviceOption(GitCore);
  const requests = yield* Queue.dropping<void>(1);
  yield* Effect.addFinalizer(() => Queue.shutdown(requests));
  const running = new Map<string, Fiber.Fiber<void, never>>();
  const request = Queue.offer(requests, undefined).pipe(Effect.asVoid);
  const notice = (job: HookJob, text: string, suffix: string, tone: "error" | "info" = "error") =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`${job.jobId}:${suffix}`),
          threadId: ThreadId.makeUnsafe(job.threadId),
          createdAt: new Date(now).toISOString(),
          activity: {
            id: EventId.makeUnsafe(`${job.jobId}:${suffix}`),
            kind: "settlement.script",
            tone,
            summary: text,
            payload: {},
            turnId: null,
            createdAt: new Date(now).toISOString(),
          },
        }),
      ),
      Effect.ignore,
    );
  const stillSettled = (job: HookJob) =>
    engine.getReadModel().pipe(
      Effect.map((model) => {
        const thread = model.threads.find(
          (thread) => thread.id === job.threadId && !thread.deletedAt && !thread.archivedAt,
        );
        const project = model.projects.find(
          (project) => project.id === job.projectId && !project.deletedAt,
        );
        return thread?.settledAt === job.settledAt &&
          thread.worktreePath === job.worktreePath &&
          project
          ? { thread, project }
          : null;
      }),
    );
  const run = (job: HookJob) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claim =
          yield* sql`UPDATE thread_settlement_hooks SET state='running',updated_at=${new Date(yield* Clock.currentTimeMillis).toISOString()} WHERE thread_id=${job.threadId} AND job_id=${job.jobId} AND state='pending' AND EXISTS(SELECT 1 FROM projection_threads t WHERE t.thread_id=${job.threadId} AND t.settled_at=${job.settledAt} AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.worktree_path=${job.worktreePath}) RETURNING job_id`;
        if (!claim.length) {
          yield* sql`UPDATE thread_settlement_hooks SET state='canceled' WHERE thread_id=${job.threadId} AND job_id=${job.jobId} AND state='pending' AND NOT EXISTS(SELECT 1 FROM projection_threads t WHERE t.thread_id=${job.threadId} AND t.settled_at=${job.settledAt} AND t.worktree_path=${job.worktreePath} AND t.archived_at IS NULL AND t.deleted_at IS NULL)`;
          return;
        }
        let skipped = false;
        const outcome = yield* restore(
          Effect.scoped(
            Effect.gen(function* () {
              if (Option.isNone(git)) return yield* Effect.fail(new Error("Git is unavailable"));
              const worktree = yield* Effect.tryPromise(() =>
                canonicalWorktreePath(job.worktreePath),
              );
              const common = yield* git.value.resolveCommonDir(worktree);
              return yield* withWorktreeLifecycleLock(
                worktree,
                withRepositoryLifecycleLock(
                  config.baseDir,
                  common,
                  Effect.gen(function* () {
                    const current = yield* stillSettled(job);
                    if (!current) {
                      skipped = true;
                      return;
                    }
                    const root = yield* Effect.tryPromise(() =>
                      canonicalWorktreePath(current.project.workspaceRoot),
                    );
                    const marker = yield* Effect.tryPromise(() =>
                      FS.lstat(Path.join(worktree, ".git")),
                    );
                    if (root === worktree || !marker.isFile() || marker.isSymbolicLink())
                      return yield* Effect.fail(
                        new Error("The checkout is not an owned linked worktree"),
                      );
                    const scripts = yield* Effect.try({
                      try: () =>
                        Schema.decodeUnknownSync(
                          Schema.Array(ProjectScript).check(Schema.isMaxLength(20)),
                        )(JSON.parse(job.scriptsJson)),
                      catch: () => new SettlementScriptSnapshotError(),
                    });
                    const env = projectScriptRuntimeEnv({
                      project: { cwd: current.project.workspaceRoot },
                      worktreePath: worktree,
                    });
                    let failures = 0;
                    for (const script of scripts) {
                      if (!(yield* stillSettled(job))) {
                        skipped = true;
                        return;
                      }
                      const result = yield* runOwnedProjectScript({
                        command: script.command,
                        name: script.name,
                        cwd: worktree,
                        env,
                        purpose: "Settlement",
                      }).pipe(Effect.timeout("2 minutes"), Effect.result);
                      if (result._tag === "Failure") failures++;
                    }
                    if (failures)
                      return yield* Effect.fail(new Error("A settlement script failed"));
                  }),
                  { mode: "user" },
                ),
              );
            }),
          ).pipe(Effect.timeout("5 minutes")),
        ).pipe(Effect.exit);
        // Scope finalizers have confirmed owned processes exited before releasing this durable claim.
        const state =
          skipped || (Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
            ? "canceled"
            : Exit.isSuccess(outcome)
              ? "completed"
              : "failed";
        yield* sql`UPDATE thread_settlement_hooks SET state=${state},updated_at=${new Date(yield* Clock.currentTimeMillis).toISOString()} WHERE thread_id=${job.threadId} AND job_id=${job.jobId} AND state='running'`;
        if (state === "completed")
          yield* notice(job, "Settlement scripts completed.", "completed", "info");
        if (state === "failed")
          yield* notice(
            job,
            "A settlement script failed or timed out. The thread stays settled; cleanup may continue after safety checks.",
            "failed",
          );
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Settlement scripts could not complete"),
      ),
    );
  const drain = Effect.gen(function* () {
    const jobs =
      yield* sql<HookJob>`SELECT thread_id AS "threadId",job_id AS "jobId",settled_at AS "settledAt",worktree_path AS "worktreePath",project_id AS "projectId",scripts_json AS "scriptsJson" FROM thread_settlement_hooks WHERE state='pending' ORDER BY updated_at LIMIT 100`;
    yield* Effect.forEach(
      jobs,
      (job) =>
        Effect.gen(function* () {
          if (running.has(job.threadId)) return;
          const fiber = yield* run(job).pipe(Effect.forkChild);
          running.set(job.threadId, fiber);
          yield* Fiber.await(fiber).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (running.get(job.threadId) === fiber) running.delete(job.threadId);
              }),
            ),
          );
        }),
      { concurrency: 2, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Settlement script queue could not be read"),
    ),
  );
  const recover = Effect.gen(function* () {
    const interrupted =
      yield* sql<HookJob>`UPDATE thread_settlement_hooks SET state='orphaned' WHERE state='running' RETURNING thread_id AS "threadId",job_id AS "jobId",settled_at AS "settledAt",worktree_path AS "worktreePath",project_id AS "projectId",scripts_json AS "scriptsJson"`;
    for (const job of interrupted)
      yield* notice(
        job,
        "A settlement script was interrupted by a server restart. It was not replayed; the worktree is kept because process completion could not be verified.",
        "interrupted",
      );
  });
  const start = Effect.gen(function* () {
    yield* recover.pipe(
      Effect.catchCause(() =>
        Effect.logWarning(
          "Settlement script recovery could not be recorded; worktrees remain protected",
        ),
      ),
    );
    yield* Effect.forever(Queue.take(requests).pipe(Effect.andThen(drain))).pipe(Effect.forkScoped);
    yield* Stream.runForEach(engine.streamDomainEvents, (event) => {
      if (event.type === "thread.settled") return request;
      if (
        event.type !== "thread.unsettled" &&
        event.type !== "thread.archived" &&
        event.type !== "thread.deleted"
      )
        return Effect.void;
      const fiber = running.get(event.payload.threadId);
      return fiber ? Fiber.interrupt(fiber).pipe(Effect.asVoid) : Effect.void;
    }).pipe(Effect.forkScoped);
    yield* request.pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped);
  });
  return { start, drain, recover };
});
