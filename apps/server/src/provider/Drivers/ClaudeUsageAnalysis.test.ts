import type { Query, query } from "@anthropic-ai/claude-agent-sdk";
import * as NodePath from "@effect/platform-node/NodePath";
import { ClaudeSettings, type ClaudeUsageAnalysis, type UsageAccount } from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";
import { describe, expect, it, vi } from "vitest";

import { AccountUsageReadError } from "../../usage/accountUsageErrors.ts";
import { analyzeClaudeUsage, normalizeClaudeUsageAnalysis } from "../Layers/ClaudeProvider.ts";
import { makeClaudeUsageAnalyzer } from "./ClaudeUsageAnalysis.ts";

const analysis: ClaudeUsageAnalysis = {
  analyzedAt: "2026-11-03T10:00:00.000Z",
  day: null,
  week: { requestCount: 3, sessionCount: 1, behaviors: [], recommendations: [] },
};

describe("normalizeClaudeUsageAnalysis", () => {
  it("keeps behaviors and titled recommendations, clamps shares, and drops `fix`", () => {
    expect(
      normalizeClaudeUsageAnalysis(
        {
          behaviors: {
            day: {
              request_count: 12.4,
              session_count: -2,
              behaviors: [
                { key: "max_effort", pct: 140, count: 4 },
                { key: " ", pct: 10, count: 1 },
                "bogus",
              ],
              recommendations: [
                {
                  key: "max_effort",
                  pct: 61.5,
                  title: "Lower effort for routine turns",
                  detail: "Most requests ran at max effort.",
                  fix: "/effort high",
                },
                { key: "workflow", pct: 5 },
              ],
            },
          },
        },
        analysis.analyzedAt,
      ),
    ).toEqual({
      analyzedAt: analysis.analyzedAt,
      day: {
        requestCount: 12,
        sessionCount: 0,
        behaviors: [{ key: "max_effort", pct: 100, count: 4 }],
        recommendations: [
          {
            key: "max_effort",
            pct: 61.5,
            title: "Lower effort for routine turns",
            detail: "Most requests ran at max effort.",
          },
        ],
      },
      week: null,
    });
    expect(normalizeClaudeUsageAnalysis(undefined, analysis.analyzedAt)).toEqual({
      analyzedAt: analysis.analyzedAt,
      day: null,
      week: null,
    });
  });

  it("asks the SDK for behaviors (no skipBehaviors) and aborts the probe", async () => {
    const read = vi.fn(async () => ({ behaviors: { week: { request_count: 2 } } }));
    const abort = vi.fn();
    const createQuery: typeof query = (input) => {
      input.options?.abortController?.signal.addEventListener("abort", abort);
      return {
        initializationResult: async () => ({ commands: [] }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: read,
      } as unknown as Query;
    };
    const result = await Effect.runPromise(
      analyzeClaudeUsage(Schema.decodeSync(ClaudeSettings)({}), process.env, {
        createQuery,
      }).pipe(Effect.provide(NodePath.layer)),
    );
    expect(read).toHaveBeenCalledWith({});
    expect(result.week?.requestCount).toBe(2);
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("makeClaudeUsageAnalyzer", () => {
  it("joins a running scan, takes one shared permit, and merges the result into snapshots", async () => {
    let runs = 0;
    const gate = Effect.runSync(Deferred.make<void>());
    const started = Effect.runSync(Deferred.make<void>());
    const run = Effect.gen(function* () {
      runs += 1;
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(gate);
      return analysis;
    });
    const permits = Effect.runSync(Semaphore.make(2));
    const account = { providerInstanceId: "claude" } as unknown as UsageAccount;
    const program = Effect.gen(function* () {
      const analyzer = yield* makeClaudeUsageAnalyzer(run);
      const first = yield* Effect.forkChild(analyzer.analyze(permits));
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(analyzer.analyze(permits));
      yield* Effect.yieldNow;
      expect(runs).toBe(1);
      // One of the two shared permits is held by the scan.
      expect(Option.isNone(yield* permits.withPermitsIfAvailable(2)(Effect.void))).toBe(true);
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(first)).toEqual(analysis);
      expect(yield* Fiber.join(second)).toEqual(analysis);
      expect(Option.isSome(yield* permits.withPermitsIfAvailable(2)(Effect.void))).toBe(true);
      const capability = analyzer.withAnalysis({
        identity: "claude",
        getSnapshot: Effect.succeed(account),
        refresh: () => Effect.void,
      });
      expect((yield* capability.getSnapshot).usageAnalysis).toEqual(analysis);
      // A later request starts a fresh scan rather than replaying the finished one.
      yield* analyzer.analyze(permits);
      expect(runs).toBe(2);
    });
    await Effect.runPromise(Effect.scoped(program));
  });

  it("passes probe failures through and reports instance removal as process-unavailable", async () => {
    const permits = Effect.runSync(Semaphore.make(2));
    const failing = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const analyzer = yield* makeClaudeUsageAnalyzer(
            Effect.fail(new AccountUsageReadError("timeout")),
          );
          return yield* Effect.flip(analyzer.analyze(permits));
        }),
      ),
    );
    expect(failing.code).toBe("timeout");

    const scope = Effect.runSync(Scope.make());
    const analyzer = await Effect.runPromise(
      makeClaudeUsageAnalyzer(Effect.never).pipe(Scope.provide(scope)),
    );
    const waiting = Effect.runFork(analyzer.analyze(permits));
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    const exit = await Effect.runPromise(Fiber.await(waiting));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("process-unavailable");
  });
});
