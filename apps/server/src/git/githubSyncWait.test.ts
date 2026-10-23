import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { GitHubCliError } from "./Errors.ts";
import { GitHubRequestPolicy } from "./githubRequestPolicy.ts";
import { GitHubSyncWait, makeGitHubRequestScheduler } from "./githubRequestScheduler.ts";
import { makeGitHubApi } from "./githubApi.ts";
import type { GitHubCliShape } from "./Services/GitHubCli.ts";

it.effect(
  "manual sync defers transport backoff instead of waiting and repeatedly retrying a broken server",
  () =>
    Effect.gen(function* () {
      const scheduler = makeGitHubRequestScheduler(() => 0);
      scheduler.networkFailure("github.com");
      const result = yield* Deferred.make<number, GitHubCliError>();
      let calls = 0;
      yield* scheduler
        .run(
          "github.com",
          "rest",
          Effect.sync(() => ++calls),
        )
        .pipe(
          Effect.provideService(GitHubSyncWait, true),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(result, exit)),
          Effect.forkChild,
        );
      for (let turn = 0; turn < 3; turn++) yield* Effect.yieldNow;
      assert.isTrue(yield* Deferred.isDone(result));
      assert.equal((yield* Deferred.await(result).pipe(Effect.flip)).kind, "rate_limited");
      assert.equal(calls, 0);
      assert.equal(scheduler.status("github.com").cooldownReason, "network");
    }),
);

it.effect("manual sync waits through a reset before dispatching its read", () =>
  Effect.gen(function* () {
    let now = 0;
    let calls = 0;
    const scheduler = makeGitHubRequestScheduler(() => now);
    scheduler.record("github.com", "rest", { status: 429, rateLimit: { retryAfterSeconds: 30 } });
    const result = yield* Deferred.make<number, GitHubCliError>();
    yield* scheduler
      .run(
        "github.com",
        "rest",
        Effect.sync(() => ++calls),
      )
      .pipe(
        Effect.provideService(GitHubSyncWait, true),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(result, exit)),
        Effect.forkChild,
      );
    yield* Effect.yieldNow;
    assert.equal(calls, 0);
    now = 30_000;
    yield* TestClock.adjust("30 seconds");
    assert.equal(yield* Deferred.await(result), 1);
    assert.equal(scheduler.status("github.com").activeOrQueuedRequests, 0);
  }),
);

it.effect("account invalidation cancels a manual wait and releases its queue entry", () =>
  Effect.gen(function* () {
    const scheduler = makeGitHubRequestScheduler(() => 0);
    scheduler.record("github.com", "rest", { status: 429, rateLimit: { retryAfterSeconds: 60 } });
    const invalidated = yield* Deferred.make<never, GitHubCliError>();
    let calls = 0;
    const fiber = yield* scheduler
      .run(
        "github.com",
        "rest",
        Effect.sync(() => ++calls),
      )
      .pipe(
        Effect.provideService(GitHubSyncWait, true),
        Effect.provideService(GitHubRequestPolicy, {
          beforeSend: () => Effect.void,
          readInvalidated: Deferred.await(invalidated),
        }),
        Effect.flip,
        Effect.forkChild,
      );
    yield* Effect.yieldNow;
    yield* Deferred.fail(
      invalidated,
      new GitHubCliError({ operation: "scope", kind: "forbidden", detail: "Account changed" }),
    );
    assert.equal((yield* Fiber.join(fiber)).kind, "forbidden");
    assert.equal(calls, 0);
    assert.equal(scheduler.status("github.com").activeOrQueuedRequests, 0);
  }),
);

it.effect("manual scope neither waits on writes nor replays an admitted operation", () =>
  Effect.gen(function* () {
    const scheduler = makeGitHubRequestScheduler(() => 0);
    scheduler.record("github.com", "rest", { status: 429, rateLimit: { retryAfterSeconds: 60 } });
    let writes = 0;
    const denied = yield* scheduler
      .run(
        "github.com",
        "write",
        Effect.sync(() => ++writes),
      )
      .pipe(Effect.provideService(GitHubSyncWait, true), Effect.flip);
    assert.equal(denied.kind, "rate_limited");
    assert.equal(writes, 0);
    const fresh = makeGitHubRequestScheduler();
    let reads = 0;
    const error = yield* fresh
      .run(
        "github.com",
        "rest",
        Effect.suspend(() => {
          reads++;
          return Effect.fail(
            new GitHubCliError({
              operation: "schedule",
              kind: "rate_limited",
              detail: "Dispatched operation failed",
              rateLimit: { retryAfterSeconds: 60 },
            }),
          );
        }),
      )
      .pipe(Effect.provideService(GitHubSyncWait, true), Effect.flip);
    assert.equal(error.detail, "Dispatched operation failed");
    assert.equal(reads, 1);
  }),
);

it.effect(
  "a rate-limited HTTP read waits and retries once while a mutation is never replayed",
  () =>
    Effect.gen(function* () {
      for (const write of [false, true]) {
        let now = Date.now();
        let calls = 0;
        const received = yield* Deferred.make<void>();
        const execute: GitHubCliShape["execute"] = (input) =>
          Effect.gen(function* () {
            const identity = input.args[1] === "user";
            if (!identity) {
              calls++;
              yield* Deferred.succeed(received, undefined);
            }
            const limited = !identity && calls === 1;
            return {
              stdout: `HTTP/1.1 ${limited ? 429 : 200} Response\r\nContent-Type: application/json\r\n${limited ? "Retry-After: 1\r\n" : ""}\r\n${JSON.stringify(identity ? { id: 1, login: "viewer" } : { ok: true })}`,
              stderr: "",
              code: 0,
              signal: null,
              timedOut: false,
            };
          });
        const scheduler = makeGitHubRequestScheduler(() => now);
        const api = makeGitHubApi(execute, scheduler, () => Effect.succeed("private-token"));
        const context = yield* api.getCredentialContext({ host: "github.com", cwd: "." });
        const fiber = yield* api
          .request({
            cwd: ".",
            context,
            method: write ? "POST" : "GET",
            endpoint: write ? "graphql" : "repos/o/r",
            ...(write ? { body: { query: "mutation { example }" } } : {}),
          })
          .pipe(Effect.provideService(GitHubSyncWait, true), Effect.forkChild);
        yield* Deferred.await(received);
        if (!write) {
          while (scheduler.status("github.com").retryAt === null) yield* Effect.yieldNow;
          now += 1000;
          yield* TestClock.adjust("1 second");
        }
        assert.equal((yield* Fiber.join(fiber)).status, write ? 429 : 200);
        assert.equal(calls, write ? 1 : 2);
      }
    }),
);
