import { describe, expect, it } from "vitest";
import type { PrHubSchedulerState, PrHubSnapshot } from "@t3tools/contracts";

import { PR_HUB_BACKLOG_ERROR_KIND } from "./refreshSchedule.ts";
import { prHubSyncState } from "./syncState.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const healthy: PrHubSnapshot = {
  status: "ok",
  host: "github.com",
  viewerLogin: "me",
  pullRequests: [],
  recentlyResolved: [],
  lastPolledAt: at(-60),
  coverage: [],
};

const scheduler = (overrides: Partial<PrHubSchedulerState> = {}): PrHubSchedulerState => ({
  cooldownReason: null,
  retryAt: null,
  activeOrQueuedRequests: 0,
  resources: [],
  ...overrides,
});

const state = (
  snapshot: Partial<PrHubSnapshot>,
  schedulerState: PrHubSchedulerState | undefined = scheduler(),
) => prHubSyncState({ ...healthy, ...snapshot }, schedulerState, at(120), NOW);

describe("PR Hub sync state", () => {
  it("is idle when the last poll finished everything", () => {
    expect(state({})).toEqual({
      state: "idle",
      lastSyncedAt: at(-60),
      nextSyncAt: at(120),
      resumeAt: null,
      pending: { searches: 0, hydrations: 0 },
      message: null,
    });
  });

  it("reports deferred searches and detail backlog as syncing, with the budget's resume time", () => {
    const sync = state(
      {
        errorKind: PR_HUB_BACKLOG_ERROR_KIND,
        errorMessage: "GitHub search budget reached.",
        coverage: [
          {
            scope: "global_relationship_search",
            status: "partial",
            description: "",
            remainingSearches: 3,
            remainingHydrations: 40,
          },
          {
            scope: "known_repositories",
            status: "partial",
            description: "",
            remainingSearches: 1,
            remainingHydrations: 40,
          },
        ],
      },
      scheduler({
        resources: [
          {
            resource: "search",
            used: 10,
            windowLimit: 10,
            remaining: 20,
            resetAt: null,
            resumeAt: at(45),
          },
          {
            resource: "graphql",
            used: 1,
            windowLimit: 100,
            remaining: 4000,
            resetAt: null,
            resumeAt: at(-5),
          },
        ],
      }),
    );
    expect(sync.state).toBe("syncing");
    // Searches add up across scopes; every scope reports the same detail queue.
    expect(sync.pending).toEqual({ searches: 4, hydrations: 40 });
    expect(sync.resumeAt).toBe(at(45));
    expect(sync.message).toBeNull();
  });

  it("is syncing before the first poll and while saved rows await revalidation", () => {
    expect(state({ lastPolledAt: null }, undefined).state).toBe("syncing");
    expect(
      state({
        coverage: [
          {
            scope: "previously_tracked",
            status: "partial",
            description: "",
            remainingHydrations: 7,
          },
        ],
      }).pending,
    ).toEqual({ searches: 0, hydrations: 7 });
  });

  it("separates a rate limit and an unreachable host from a failed refresh", () => {
    expect(state({}, scheduler({ cooldownReason: "rate-limit", retryAt: at(600) }))).toMatchObject({
      state: "rate_limited",
      resumeAt: at(600),
    });
    expect(
      state({ status: "degraded" }, scheduler({ cooldownReason: "network", retryAt: at(30) })),
    ).toMatchObject({ state: "offline", resumeAt: at(30) });
    // A cooldown that already ended no longer explains anything.
    expect(state({}, scheduler({ cooldownReason: "network", retryAt: at(-1) })).state).toBe("idle");
  });

  it("keeps real failures and missing credentials visible", () => {
    expect(state({ status: "degraded", errorMessage: "GitHub returned HTTP 502." })).toMatchObject({
      state: "error",
      message: "GitHub returned HTTP 502.",
    });
    expect(state({ status: "error" }).state).toBe("error");
    expect(state({ status: "gh_missing" }).state).toBe("error");
    expect(
      state(
        { status: "auth_required" },
        scheduler({ cooldownReason: "rate-limit", retryAt: at(600) }),
      ).state,
    ).toBe("auth_required");
  });
});
