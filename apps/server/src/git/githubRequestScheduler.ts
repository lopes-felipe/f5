import { makeGitHubRequestQueue, type GitHubPriority } from "./githubRequestQueue.ts";
import { Effect, Option, ServiceMap } from "effect";
import type { SourceControlRateLimit, PrHubSchedulerState } from "@t3tools/contracts";
import { GitHubCliError } from "./Errors.ts";
import { enforceGitHubRequestPolicy } from "./githubRequestPolicy.ts";

/** Only explicit read synchronization opts in. Writes and passive polls never retry. */
export class GitHubSyncWait extends ServiceMap.Service<GitHubSyncWait, boolean>()(
  "t3/git/githubRequestScheduler/GitHubSyncWait",
) {}

export class GitHubRequestPriority extends ServiceMap.Service<
  GitHubRequestPriority,
  GitHubPriority
>()("t3/git/githubRequestScheduler/GitHubRequestPriority") {}
export type GitHubResource = "rest" | "search" | "graphql" | "write";
interface Budget {
  windowStart: number;
  minuteStart: number;
  searchMinute: number;
  used: Record<Exclude<GitHubResource, "write">, number>;
  quota: Partial<Record<Exclude<GitHubResource, "write">, SourceControlRateLimit>>;
  reserve: Partial<Record<Exclude<GitHubResource, "write">, number>>;
  rateLimitedUntil: number;
  networkBlockedUntil: number;
  failures: number;
  queued: number;
  schedule: ReturnType<typeof makeGitHubRequestQueue>;
}

/** Passive admission failures leave resumable work for the next poll. */
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
        rateLimitedUntil: 0,
        networkBlockedUntil: 0,
        failures: 0,
        queued: 0,
        schedule: makeGitHubRequestQueue(),
      };
      hosts.set(host, budget);
    }
    return budget;
  };
  const blockedUntil = (budget: Budget) =>
    Math.max(budget.rateLimitedUntil, budget.networkBlockedUntil);
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
      const urgency = Option.getOrElse(priority, () => "interactive" as const);
      const background = urgency !== "interactive";
      const budget = budgetFor(host);
      const admission = Effect.gen(function* () {
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
        if (blockedUntil(budget) > timestamp)
          return yield* deferred(
            blockedUntil(budget),
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
      });
      return yield* Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (budget.queued >= 128)
            return Effect.fail(
              deferred(now() + 30_000, "GitHub request queue is full; retry shortly."),
            );
          budget.queued++;
          return Effect.void;
        }),
        () =>
          Effect.gen(function* () {
            const wait = yield* Effect.serviceOption(GitHubSyncWait);
            while (true) {
              const attempt = yield* budget.schedule(
                urgency,
                resource === "write",
                Effect.gen(function* () {
                  const denied = yield* admission.pipe(
                    Effect.as(null),
                    Effect.catch((error) => Effect.succeed(error)),
                  );
                  if (denied) return { admitted: false as const, error: denied };
                  // Failures after this point are returned directly; never replay dispatched work.
                  return { admitted: true as const, value: yield* effect };
                }),
              );
              if (attempt.admitted) return attempt.value;
              const until = Date.parse(attempt.error.rateLimit?.resetAt ?? "");
              if (
                resource === "write" ||
                budget.networkBlockedUntil > now() ||
                !Option.getOrElse(wait, () => false) ||
                !Number.isFinite(until)
              )
                return yield* attempt.error;
              yield* enforceGitHubRequestPolicy(Effect.sleep(Math.max(1, until - now())), false);
            }
          }),
        () =>
          Effect.sync(() => {
            budget.queued--;
          }),
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
      budget.rateLimitedUntil = Math.max(
        budget.rateLimitedUntil,
        now() + (result.rateLimit.retryAfterSeconds ?? 30) * 1000,
        reset,
      );
    } else if (result.status >= 500) networkFailure(host);
    else if (result.status < 400) budget.failures = 0;
  };
  const networkFailure = (host: string) => {
    const budget = budgetFor(host);
    budget.failures++;
    budget.networkBlockedUntil =
      now() +
      Math.min(900_000, 30_000 * 2 ** Math.min(5, budget.failures - 1)) * (0.8 + random() * 0.4);
  };
  const status = (host: string): PrHubSchedulerState => {
    const budget = budgetFor(host);
    const timestamp = now();
    const currentWindow = timestamp - budget.windowStart < 180_000;
    const retryAt =
      blockedUntil(budget) > timestamp ? new Date(blockedUntil(budget)).toISOString() : null;
    return {
      retryAt,
      cooldownReason:
        budget.networkBlockedUntil > timestamp
          ? "network"
          : budget.rateLimitedUntil > timestamp
            ? "rate-limit"
            : null,
      activeOrQueuedRequests: budget.queued,
      resources: (["rest", "search", "graphql"] as const).map((resource) => {
        const quota = budget.quota[resource];
        const used = currentWindow ? budget.used[resource] : 0;
        const windowLimit = { rest: 60, search: 30, graphql: 500 }[resource];
        let resume = Math.max(
          blockedUntil(budget),
          used >= windowLimit ? budget.windowStart + 180_000 : 0,
        );
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

/** Discovery loops use this before skipping work, preserving passive deferral. */
export function githubCooldownActive(host: string) {
  return Effect.gen(function* () {
    const wait = yield* Effect.serviceOption(GitHubSyncWait);
    while (true) {
      const state = githubRequestScheduler.status(host);
      const retryAt = state.retryAt;
      if (!retryAt) return false;
      if (state.cooldownReason === "network" || !Option.getOrElse(wait, () => false)) return true;
      yield* enforceGitHubRequestPolicy(
        Effect.sleep(Math.max(1, Date.parse(retryAt) - Date.now())),
        false,
      ).pipe(Effect.catch(() => Effect.interrupt));
    }
  });
}
