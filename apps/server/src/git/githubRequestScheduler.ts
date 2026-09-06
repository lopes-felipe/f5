import { Effect, Option, Semaphore, ServiceMap } from "effect";
import type { SourceControlRateLimit, PrHubSchedulerState } from "@t3tools/contracts";
import { GitHubCliError } from "./Errors.ts";

export class GitHubRequestPriority extends ServiceMap.Service<
  GitHubRequestPriority,
  "interactive" | "background"
>()("t3/git/githubRequestScheduler/GitHubRequestPriority") {}
export type GitHubResource = "rest" | "search" | "graphql" | "write";
interface Budget {
  windowStart: number;
  minuteStart: number;
  searchMinute: number;
  used: Record<Exclude<GitHubResource, "write">, number>;
  quota: Partial<Record<Exclude<GitHubResource, "write">, SourceControlRateLimit>>;
  reserve: Partial<Record<Exclude<GitHubResource, "write">, number>>;
  blockedUntil: number;
  failures: number;
  queued: number;
  reads: ReturnType<typeof Semaphore.makeUnsafe>;
  writes: ReturnType<typeof Semaphore.makeUnsafe>;
  background: ReturnType<typeof Semaphore.makeUnsafe>;
}

/** No retries: admission failure leaves resumable work for the next poll. */
export function makeGitHubRequestScheduler(now = Date.now, random = Math.random) {
  const hosts = new Map<string, Budget>();
  const budgetFor = (host: string) => {
    let budget = hosts.get(host);
    if (!budget) {
      budget = {
        windowStart: now(),
        minuteStart: now(),
        searchMinute: 0,
        used: { rest: 0, search: 0, graphql: 0 },
        quota: {},
        reserve: {},
        blockedUntil: 0,
        failures: 0,
        queued: 0,
        reads: Semaphore.makeUnsafe(2),
        writes: Semaphore.makeUnsafe(1),
        background: Semaphore.makeUnsafe(1),
      };
      hosts.set(host, budget);
    }
    return budget;
  };
  const deferred = (until: number, detail: string) =>
    new GitHubCliError({
      operation: "schedule",
      kind: "rate_limited",
      detail,
      rateLimit: {
        retryAfterSeconds: Math.max(1, Math.ceil((until - now()) / 1000)),
        resetAt: new Date(until).toISOString(),
      },
    });

  const run = <A, E, R>(
    host: string,
    resource: GitHubResource,
    effect: Effect.Effect<A, E, R>,
    weights?: { readonly searchPages?: number; readonly graphql?: boolean },
  ): Effect.Effect<A, E | GitHubCliError, R> =>
    Effect.gen(function* () {
      const priority = yield* Effect.serviceOption(GitHubRequestPriority);
      const background = Option.getOrElse(priority, () => "interactive") === "background";
      const budget = budgetFor(host);
      if (budget.queued >= 128)
        return yield* deferred(now() + 30_000, "GitHub request queue is full; retry shortly.");
      budget.queued++;
      const admitted = Effect.gen(function* () {
        const timestamp = now();
        if (timestamp - budget.windowStart >= 180_000) {
          budget.windowStart = timestamp;
          budget.used = { rest: 0, search: 0, graphql: 0 };
          budget.reserve = {};
        }
        if (timestamp - budget.minuteStart >= 60_000) {
          budget.minuteStart = timestamp;
          budget.searchMinute = 0;
        }
        if (budget.blockedUntil > timestamp)
          return yield* deferred(
            budget.blockedUntil,
            "GitHub requests are waiting for the retry window.",
          );
        if (resource !== "write") {
          const resources =
            weights?.graphql && resource !== "graphql"
              ? [resource, "graphql" as const]
              : [resource];
          for (const quotaResource of resources) {
            const quota = budget.quota[quotaResource];
            const reset = quota?.resetAt ? Date.parse(quota.resetAt) : timestamp + 60_000;
            if (background && quota?.remaining != null && reset > timestamp)
              budget.reserve[quotaResource] ??= Math.ceil(quota.remaining * 0.2);
            if (
              quota?.remaining != null &&
              reset > timestamp &&
              (quota.remaining === 0 ||
                (background && quota.remaining <= (budget.reserve[quotaResource] ?? 0)))
            )
              return yield* deferred(
                quota.remaining === 0 ? reset : Math.min(reset, budget.windowStart + 180_000),
                "GitHub quota is reserved for interactive work until the next budget window.",
              );
          }
          const limit = { rest: 60, search: 30, graphql: 500 }[resource];
          const units = resource === "search" ? Math.max(1, weights?.searchPages ?? 1) : 1;
          if (
            background &&
            (budget.used[resource] + units > limit ||
              (weights?.graphql && budget.used.graphql >= 500))
          )
            return yield* deferred(
              budget.windowStart + 180_000,
              "PR monitoring reached its request budget; remaining work will resume.",
            );
          if (background && resource === "search" && budget.searchMinute >= 10)
            return yield* deferred(
              budget.minuteStart + 60_000,
              "PR monitoring reached its search budget; remaining pages will resume.",
            );
          if (background) {
            budget.used[resource] += units;
            if (weights?.graphql && resource !== "graphql") budget.used.graphql++;
            if (resource === "search") budget.searchMinute++;
          }
        }
        return yield* effect;
      });
      const limited = (resource === "write" ? budget.writes : budget.reads).withPermits(1)(
        admitted,
      );
      // One background reader leaves the second read slot available to selected PRs.
      return yield* (
        background && resource !== "write" ? budget.background.withPermits(1)(limited) : limited
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            budget.queued--;
          }),
        ),
      );
    });
  const record = (
    host: string,
    resource: GitHubResource,
    result: { status: number; rateLimit: SourceControlRateLimit },
    cost = 1,
    graphql = resource === "graphql",
  ) => {
    const budget = budgetFor(host);
    const quotaResource = graphql ? "graphql" : resource === "write" ? null : resource;
    if (quotaResource) {
      if (budget.quota[quotaResource]?.resetAt !== result.rateLimit.resetAt)
        delete budget.reserve[quotaResource];
      budget.quota[quotaResource] = result.rateLimit;
    }
    if (graphql && Number.isFinite(cost) && cost > 0)
      budget.used.graphql += Math.max(0, cost - (resource === "write" ? 0 : 1));
    if (
      result.status === 429 ||
      (result.status === 403 &&
        (result.rateLimit.remaining === 0 || result.rateLimit.retryAfterSeconds != null))
    ) {
      const reset = result.rateLimit.resetAt ? Date.parse(result.rateLimit.resetAt) : now();
      budget.blockedUntil = Math.max(
        now() + (result.rateLimit.retryAfterSeconds ?? 30) * 1000,
        reset,
      );
    } else if (result.status >= 500) networkFailure(host);
    else if (result.status < 400) budget.failures = 0;
  };
  const networkFailure = (host: string) => {
    const budget = budgetFor(host);
    budget.failures++;
    budget.blockedUntil =
      now() +
      Math.min(900_000, 30_000 * 2 ** Math.min(5, budget.failures - 1)) * (0.8 + random() * 0.4);
  };
  const status = (host: string): PrHubSchedulerState => {
    const budget = budgetFor(host);
    const timestamp = now();
    const currentWindow = timestamp - budget.windowStart < 180_000;
    const retryAt =
      budget.blockedUntil > timestamp ? new Date(budget.blockedUntil).toISOString() : null;
    return {
      retryAt,
      activeOrQueuedRequests: budget.queued,
      resources: (["rest", "search", "graphql"] as const).map((resource) => {
        const quota = budget.quota[resource];
        const used = currentWindow ? budget.used[resource] : 0;
        const windowLimit = { rest: 60, search: 30, graphql: 500 }[resource];
        let resume = used >= windowLimit ? budget.windowStart + 180_000 : 0;
        if (
          resource === "search" &&
          timestamp - budget.minuteStart < 60_000 &&
          budget.searchMinute >= 10
        )
          resume = Math.max(resume, budget.minuteStart + 60_000);
        if (
          quota?.remaining != null &&
          quota.resetAt &&
          Date.parse(quota.resetAt) > timestamp &&
          quota.remaining <= (currentWindow ? (budget.reserve[resource] ?? 0) : 0)
        )
          resume = Math.max(
            resume,
            quota.remaining === 0
              ? Date.parse(quota.resetAt)
              : Math.min(Date.parse(quota.resetAt), budget.windowStart + 180_000),
          );
        const quotaExpired = quota?.resetAt != null && Date.parse(quota.resetAt) <= timestamp;
        return {
          resource,
          used,
          windowLimit,
          remaining: quotaExpired ? null : (quota?.remaining ?? null),
          resetAt: quotaExpired ? null : (quota?.resetAt ?? null),
          resumeAt: resume > timestamp ? new Date(resume).toISOString() : null,
        };
      }),
    };
  };
  return { run, record, networkFailure, status };
}

export const githubRequestScheduler = makeGitHubRequestScheduler();
