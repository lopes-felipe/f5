import { Effect } from "effect";
import { expect, it } from "vitest";
import { enforceGitHubRequestPolicy, GitHubRequestPolicy } from "./githubRequestPolicy.ts";
import { makeGitHubRequestQueue } from "./githubRequestQueue.ts";
import { GitHubCliError } from "./Errors.ts";

const denied = new GitHubCliError({ operation: "test", kind: "forbidden", detail: "excluded" });
it("rechecks scope after admission and prevents a queued write from sending", async () => {
  const queue = makeGitHubRequestQueue();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = Effect.runPromise(
    queue(
      "interactive",
      true,
      Effect.promise(() => {
        started();
        return held;
      }),
    ),
  );
  await ready;
  let excluded = false;
  let sent = false;
  const next = Effect.runPromise(
    queue(
      "interactive",
      true,
      enforceGitHubRequestPolicy(
        Effect.sync(() => {
          sent = true;
        }),
        true,
      ),
    ).pipe(
      Effect.provideService(GitHubRequestPolicy, {
        beforeSend: () => Effect.suspend(() => (excluded ? Effect.fail(denied) : Effect.void)),
        readInvalidated: Effect.never,
      }),
      Effect.exit,
    ),
  );
  excluded = true;
  release();
  await first;
  expect((await next)._tag).toBe("Failure");
  expect(sent).toBe(false);
});

it("cancels invalidated reads but does not report an already-dispatched write as canceled", async () => {
  for (const write of [false, true]) {
    let invalidate!: () => void;
    let finish!: () => void;
    let started!: () => void;
    const invalidated = new Promise<void>((resolve) => {
      invalidate = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let interrupted = false;
    const running = Effect.runPromise(
      enforceGitHubRequestPolicy(
        Effect.promise((signal) => {
          signal.addEventListener("abort", () => {
            interrupted = true;
          });
          started();
          return held;
        }),
        write,
      ).pipe(
        Effect.provideService(GitHubRequestPolicy, {
          beforeSend: () => Effect.void,
          readInvalidated: Effect.promise(() => invalidated).pipe(
            Effect.andThen(Effect.fail(denied)),
          ),
        }),
        Effect.exit,
      ),
    );
    await ready;
    invalidate();
    if (write) finish();
    expect((await running)._tag).toBe(write ? "Success" : "Failure");
    expect(interrupted).toBe(!write);
  }
});
