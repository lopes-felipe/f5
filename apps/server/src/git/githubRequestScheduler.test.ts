import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { GitHubRequestPriority, makeGitHubRequestScheduler } from "./githubRequestScheduler.ts";

describe("GitHub host scheduling", () => {
  it("charges every batched search page and accounts for GraphQL search cost", async () => {
    const scheduler = makeGitHubRequestScheduler(() => 0);
    const search = scheduler
      .run("github.com", "search", Effect.succeed(true), { searchPages: 11, graphql: true })
      .pipe(Effect.provideService(GitHubRequestPriority, "background"));
    expect(await Effect.runPromise(search)).toBe(true);
    expect(await Effect.runPromise(search)).toBe(true);
    expect((await Effect.runPromise(search.pipe(Effect.flip))).kind).toBe("rate_limited");
    const points = makeGitHubRequestScheduler(() => 0);
    const page = points
      .run("enterprise", "search", Effect.succeed(true), { graphql: true })
      .pipe(Effect.provideService(GitHubRequestPriority, "background"));
    await Effect.runPromise(page);
    points.record(
      "enterprise",
      "search",
      { status: 200, rateLimit: { remaining: 4000, limit: 5000 } },
      500,
      true,
    );
    expect((await Effect.runPromise(page.pipe(Effect.flip))).kind).toBe("rate_limited");
  });

  it("limits background search and resumes the next budget window", async () => {
    let now = 0;
    const scheduler = makeGitHubRequestScheduler(() => now);
    const request = scheduler
      .run("github.com", "search", Effect.succeed("sent"))
      .pipe(Effect.provideService(GitHubRequestPriority, "background"));
    for (let i = 0; i < 10; i++) expect(await Effect.runPromise(request)).toBe("sent");
    const error = await Effect.runPromise(request.pipe(Effect.flip));
    expect(error.kind).toBe("rate_limited");
    expect(error.rateLimit?.retryAfterSeconds).toBe(60);
    expect(
      await Effect.runPromise(scheduler.run("github.com", "search", Effect.succeed("interactive"))),
    ).toBe("interactive");
    now = 60_000;
    expect(await Effect.runPromise(request)).toBe("sent");
  });
  it("reserves quota for interactive work and honors Retry-After", async () => {
    let now = 0;
    const scheduler = makeGitHubRequestScheduler(() => now);
    scheduler.record("github.com", "rest", {
      status: 200,
      rateLimit: { limit: 100, remaining: 20, resetAt: new Date(60_000).toISOString() },
    });
    const read = scheduler.run("github.com", "rest", Effect.succeed(true));
    expect(
      await Effect.runPromise(
        read.pipe(Effect.provideService(GitHubRequestPriority, "background")),
      ),
    ).toBe(true);
    scheduler.record("github.com", "rest", {
      status: 200,
      rateLimit: { limit: 100, remaining: 4, resetAt: new Date(60_000).toISOString() },
    });
    const error = await Effect.runPromise(
      read.pipe(Effect.provideService(GitHubRequestPriority, "background"), Effect.flip),
    );
    expect(error.kind).toBe("rate_limited");
    expect(scheduler.status("github.com").resources[0]?.resumeAt).toBe(
      new Date(60_000).toISOString(),
    );
    expect(scheduler.status("github.com").resources[0]?.remaining).toBe(4);
    expect(await Effect.runPromise(read)).toBe(true);
    scheduler.record("github.com", "rest", { status: 429, rateLimit: { retryAfterSeconds: 30 } });
    expect((await Effect.runPromise(read.pipe(Effect.flip))).rateLimit?.retryAfterSeconds).toBe(30);
    now = 30_000;
    expect(await Effect.runPromise(read)).toBe(true);
  });
  it("bounds simultaneous writes and reads", async () => {
    const scheduler = makeGitHubRequestScheduler();
    for (const [resource, expected] of [
      ["write", 1],
      ["rest", 2],
    ] as const) {
      let active = 0;
      let maximum = 0;
      const work = Effect.gen(function* () {
        active++;
        maximum = Math.max(maximum, active);
        yield* Effect.sleep(5);
        active--;
      });
      await Effect.runPromise(
        Effect.all(
          Array.from({ length: 8 }, () => scheduler.run("github.com", resource, work)),
          { concurrency: "unbounded" },
        ),
      );
      expect(maximum).toBe(expected);
    }
  });
  it("reopens reserved quota at the monitoring window and reports expired upstream quota as unknown", async () => {
    let now = 0;
    const scheduler = makeGitHubRequestScheduler(() => now);
    const read = scheduler
      .run("github.com", "rest", Effect.succeed(true))
      .pipe(Effect.provideService(GitHubRequestPriority, "background"));
    const resetAt = new Date(600_000).toISOString();
    scheduler.record("github.com", "rest", { status: 200, rateLimit: { remaining: 20, resetAt } });
    await Effect.runPromise(read);
    scheduler.record("github.com", "rest", { status: 200, rateLimit: { remaining: 4, resetAt } });
    expect((await Effect.runPromise(read.pipe(Effect.flip))).rateLimit?.retryAfterSeconds).toBe(
      180,
    );
    expect(scheduler.status("github.com").resources[0]?.resumeAt).toBe(
      new Date(180_000).toISOString(),
    );
    now = 180_000;
    expect(await Effect.runPromise(read)).toBe(true);
    now = 600_000;
    expect(scheduler.status("github.com").resources[0]?.remaining).toBeNull();
    expect(scheduler.status("github.com").resources[0]?.resetAt).toBeNull();
  });
  it("backs off network failures without retrying operations", async () => {
    let now = 0;
    let calls = 0;
    const scheduler = makeGitHubRequestScheduler(
      () => now,
      () => 0.5,
    );
    const write = scheduler.run(
      "github.com",
      "write",
      Effect.sync(() => {
        calls++;
      }),
    );
    scheduler.networkFailure("github.com");
    expect((await Effect.runPromise(write.pipe(Effect.flip))).rateLimit?.retryAfterSeconds).toBe(
      30,
    );
    expect(calls).toBe(0);
    now = 30_000;
    await Effect.runPromise(write);
    expect(calls).toBe(1);
    scheduler.networkFailure("github.com");
    expect((await Effect.runPromise(write.pipe(Effect.flip))).rateLimit?.retryAfterSeconds).toBe(
      60,
    );
  });
});
