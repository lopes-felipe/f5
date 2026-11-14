import { Deferred, Effect, Scope } from "effect";
import { expect, it } from "vitest";
import { ThreadId, type GitStatusResult } from "@t3tools/contracts";
import { makeTurnGitStatusRefresh } from "./turnGitStatusRefresh";

it("publishes other workspaces while Git is blocked, and coalesces newer completions", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const firstStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const publishedOther = yield* Deferred.make<void>();
        const publishedLatest = yield* Deferred.make<void>();
        const pushes: Array<{ cwd: string; status: GitStatusResult }> = [];
        let reads = 0;
        const schedule = makeTurnGitStatusRefresh({
          scope,
          resolveCwd: (id) => Effect.succeed(String(id)),
          read: (cwd) =>
            Effect.gen(function* () {
              if (cwd === "repo-a" && ++reads === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(release);
              }
              return { branch: cwd, aheadCount: reads } as GitStatusResult;
            }),
          publish: (cwd, status) =>
            Effect.gen(function* () {
              pushes.push({ cwd, status });
              yield* Deferred.succeed(
                cwd === "repo-b" ? publishedOther : publishedLatest,
                undefined,
              );
            }),
        });
        yield* schedule(ThreadId.makeUnsafe("repo-a"));
        yield* Deferred.await(firstStarted);
        for (let i = 0; i < 10; i++) yield* schedule(ThreadId.makeUnsafe("repo-a"));
        yield* schedule(ThreadId.makeUnsafe("repo-b"));
        yield* Deferred.await(publishedOther);
        expect(pushes.map((push) => push.cwd)).toEqual(["repo-b"]);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(publishedLatest);
        expect(reads).toBe(2);
        expect(pushes.map((push) => push.cwd)).toEqual(["repo-b", "repo-a"]);
      }),
    ).pipe(Effect.timeout("3 seconds")),
  );
});
