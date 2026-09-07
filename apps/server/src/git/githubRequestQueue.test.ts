import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeGitHubRequestQueue, type GitHubPriority } from "./githubRequestQueue.ts";

it("orders waiting background reads and reserves a cold reconciliation admission", async () => {
  const schedule = makeGitHubRequestQueue();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = Effect.runPromise(
    schedule(
      "attention",
      false,
      Effect.promise(() => {
        started();
        return block;
      }),
    ),
  );
  await ready;
  const order: string[] = [];
  const calls = (
    ["cold", "discovery", "changed", "attention", "attention"] as GitHubPriority[]
  ).map((priority) =>
    Effect.runPromise(
      schedule(
        priority,
        false,
        Effect.sync(() => {
          order.push(priority);
        }),
      ),
    ),
  );
  await Effect.runPromise(
    schedule(
      "interactive",
      false,
      Effect.sync(() => {
        order.push("interactive");
      }),
    ),
  );
  release();
  await Promise.all([first, ...calls]);
  expect(order).toEqual(["interactive", "attention", "attention", "cold", "changed", "discovery"]);
});

it("removes canceled queued requests without consuming a permit", async () => {
  const schedule = makeGitHubRequestQueue();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = Effect.runPromise(
    schedule(
      "interactive",
      true,
      Effect.promise(() => {
        started();
        return block;
      }),
    ),
  );
  await ready;
  let sent = false;
  const controller = new AbortController();
  const pending = Effect.runPromise(
    schedule(
      "interactive",
      true,
      Effect.sync(() => {
        sent = true;
      }),
    ),
    { signal: controller.signal },
  ).catch(() => undefined);
  controller.abort();
  await pending;
  release();
  await first;
  await Effect.runPromise(schedule("interactive", true, Effect.void));
  expect(sent).toBe(false);
});
