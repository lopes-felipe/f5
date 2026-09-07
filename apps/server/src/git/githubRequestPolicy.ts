import { Effect, Option, ServiceMap } from "effect";
import type { GitHubCliError } from "./Errors.ts";

/** Server-private operation scope. Never serialized or supplied by a client. */
export class GitHubRequestPolicy extends ServiceMap.Service<
  GitHubRequestPolicy,
  {
    readonly beforeSend: (write: boolean) => Effect.Effect<void, GitHubCliError>;
    readonly readInvalidated: Effect.Effect<never, GitHubCliError>;
  }
>()("t3/git/githubRequestPolicy") {}

export function enforceGitHubRequestPolicy<A, E, R>(work: Effect.Effect<A, E, R>, write: boolean) {
  return Effect.gen(function* () {
    const policy = yield* Effect.serviceOption(GitHubRequestPolicy);
    if (Option.isNone(policy)) return yield* work;
    const checked = policy.value.beforeSend(write).pipe(Effect.andThen(work));
    // Once sent, writes retain their normal durable outcome handling; cancellation cannot undo them.
    return yield* write ? checked : Effect.raceFirst(checked, policy.value.readInvalidated);
  });
}

/** Operation-specific comparison/permission checks run after scheduler admission, before dispatch. */
export function withGitHubWritePrecondition<A, E, R>(
  work: Effect.Effect<A, E, R>,
  verify: Effect.Effect<void, GitHubCliError>,
) {
  return Effect.gen(function* () {
    const parent = yield* Effect.serviceOption(GitHubRequestPolicy);
    return yield* work.pipe(
      Effect.provideService(GitHubRequestPolicy, {
        beforeSend: (write) =>
          Effect.gen(function* () {
            if (Option.isSome(parent)) yield* parent.value.beforeSend(write);
            if (write) yield* verify;
          }),
        readInvalidated: Option.isSome(parent) ? parent.value.readInvalidated : Effect.never,
      }),
    );
  });
}
