import type { GitCreateWorktreeResult, GitPrepareWorktreeInput } from "@t3tools/contracts";
import { Deferred, Effect, Scope, Semaphore } from "effect";

import type { ProjectSetupScriptRunnerShape } from "./Services/ProjectSetupScriptRunner.ts";

/** Keeps creation and setup owned by the server across disconnected/retried RPCs. */
export const makeWorktreePreparation = <E extends Error>(deps: {
  scope: Scope.Scope;
  createWorktree: (input: GitPrepareWorktreeInput) => Effect.Effect<GitCreateWorktreeResult, E>;
  runSetup: ProjectSetupScriptRunnerShape["runForThread"];
}) =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    const entries = new Map<
      string,
      {
        fingerprint: string;
        worktree?: GitCreateWorktreeResult;
        prepared?: GitCreateWorktreeResult;
        running?: Deferred.Deferred<GitCreateWorktreeResult, Error>;
      }
    >();
    return (input: GitPrepareWorktreeInput): Effect.Effect<GitCreateWorktreeResult, Error> =>
      gate
        .withPermits(1)(
          Effect.gen(function* () {
            const key = JSON.stringify([input.projectCwd, input.newBranch]);
            const fingerprint = JSON.stringify(input);
            if (!entries.has(key) && entries.size >= 1_024) {
              return yield* Effect.fail(
                new Error(
                  "Too many worktree preparations in this server session. Restart the server before preparing another worktree.",
                ),
              );
            }
            const entry = entries.get(key) ?? { fingerprint };
            if (entry.fingerprint !== fingerprint) {
              return yield* Effect.fail(
                new Error("That recovery branch is already preparing a different workspace."),
              );
            }
            if (entry.running) return entry.running;
            const done = yield* Deferred.make<GitCreateWorktreeResult, Error>();
            if (entry.prepared) {
              yield* Deferred.succeed(done, entry.prepared);
              return done;
            }
            entry.running = done;
            entries.set(key, entry);
            const run = Effect.gen(function* () {
              // Retain a successful checkout if launching setup fails; retry only setup.
              const result = entry.worktree ?? (yield* deps.createWorktree(input));
              entry.worktree = result;
              yield* deps.runSetup({
                threadId: input.threadId,
                projectCwd: input.projectCwd,
                worktreePath: result.worktree.path,
                preferredTerminalId: `setup-${input.newBranch.replaceAll("/", "-")}`,
              });
              entry.prepared = result;
              return result;
            });
            yield* run.pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                gate.withPermits(1)(
                  Effect.gen(function* () {
                    delete entry.running;
                    yield* Deferred.done(done, exit);
                  }),
                ),
              ),
              Effect.forkIn(deps.scope),
            );
            return done;
          }),
        )
        .pipe(Effect.flatMap(Deferred.await));
  });
