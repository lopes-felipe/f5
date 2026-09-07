import { describe, expect, it } from "vitest";
import type { PrHubSnapshot } from "@t3tools/contracts";
import { makeGitHubRequestScheduler } from "../git/githubRequestScheduler.ts";
import { nextPrHubRefreshAt } from "./refreshSchedule.ts";

const snapshot: PrHubSnapshot = {
  status: "degraded",
  host: "github.com",
  viewerLogin: "me",
  pullRequests: [],
  recentlyResolved: [],
  lastPolledAt: new Date(0).toISOString(),
};
describe("PR recovery schedule", () => {
  it("wakes at host eligibility and keeps that deadline when the cooldown expires", () => {
    let now = 0;
    const scheduler = makeGitHubRequestScheduler(
      () => now,
      () => 0.5,
    );
    scheduler.record("github.com", "search", { status: 502, rateLimit: {} });
    const nextRefreshAt = nextPrHubRefreshAt(snapshot, 300, scheduler.status("github.com"), now);
    expect(nextRefreshAt).toBe(new Date(30_000).toISOString());
    now = 30_000;
    expect(
      nextPrHubRefreshAt({ ...snapshot, nextRefreshAt }, 300, scheduler.status("github.com"), now),
    ).toBe(nextRefreshAt);
    expect(
      nextPrHubRefreshAt({ ...snapshot, nextRefreshAt }, 0, scheduler.status("github.com"), now),
    ).toBeNull();
  });
  it("retains ordinary polling for healthy snapshots and bounds retries without a provider deadline", () => {
    const scheduler = makeGitHubRequestScheduler(() => 0);
    expect(
      nextPrHubRefreshAt({ ...snapshot, status: "ok" }, 300, scheduler.status("github.com"), 0),
    ).toBe(new Date(300_000).toISOString());
    expect(nextPrHubRefreshAt(snapshot, 300, scheduler.status("github.com"), 0)).toBe(
      new Date(60_000).toISOString(),
    );
  });
});
