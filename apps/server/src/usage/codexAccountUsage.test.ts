import { Effect } from "effect";
import type { CodexControlClient } from "../codex/CodexControlClient.ts";
import { describe, expect, it } from "vitest";
import { quotaWindowsFromSection } from "@t3tools/shared/usageLimit";

import { readCodexAccountSections } from "./codexAccountUsage.ts";

describe("Codex account usage", () => {
  it("normalizes token totals and all named rate-limit windows", async () => {
    const client = {
      readAccountTokenUsage: async () => ({
        summary: {
          lifetimeTokens: 1_250_000,
          peakDailyTokens: "92000",
          longestRunningTurnSec: 480,
          currentStreakDays: 3,
          longestStreakDays: 8,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-18", tokens: 42_000 }],
      }),
      readAccountRateLimits: async () => ({
        rateLimits: {},
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_787_000_000 },
            secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_787_500_000 },
            credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            planType: "plus",
          },
        },
      }),
    } as unknown as CodexControlClient;

    const sections = await Effect.runPromise(readCodexAccountSections(client));
    expect(sections.map((section) => section.outcome)).toEqual(["available", "available"]);
    expect(sections[0]?.snapshot?.data).toEqual({
      tokenSummary: {
        lifetimeTokens: "1250000",
        peakDailyTokens: "92000",
        longestRunningTurnSec: "480",
        currentStreakDays: "3",
        longestStreakDays: "8",
      },
      dailyUsageBuckets: [{ startDate: "2026-08-18", tokens: "42000" }],
    });
    expect(sections[1]?.snapshot?.data).toEqual({
      rateLimits: [
        {
          id: "codex",
          name: "Codex",
          planType: "plus",
          primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_787_000_000 },
          secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_787_500_000 },
          credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        },
      ],
    });
  });

  it("reads an Enterprise monthly credit allowance without a window duration", async () => {
    const individualLimit = { remainingPercent: 99, resetsAt: 1_784_500_000 };
    const client = {
      readAccountTokenUsage: async () => ({}),
      readAccountRateLimits: async () => ({
        rateLimits: {
          limitId: "codex",
          planType: "enterprise_cbp_usage_based",
          primary: null,
          secondary: null,
          individualLimit,
        },
      }),
    } as unknown as CodexControlClient;

    const sections = await Effect.runPromise(readCodexAccountSections(client));
    const data = sections[1]?.snapshot?.data;
    expect(data).toEqual({
      rateLimits: [
        {
          id: "codex",
          name: null,
          planType: "enterprise_cbp_usage_based",
          primary: null,
          secondary: null,
          individual: { usedPercent: 1, windowDurationMins: null, resetsAt: 1_784_500_000 },
          credits: null,
        },
      ],
    });
    expect(quotaWindowsFromSection(sections[1]!)).toEqual([
      {
        windowKey: "codex:individual",
        label: "Monthly credit limit",
        usedPercent: 1,
        resetsAt: "2026-07-19T22:26:40.000Z",
      },
    ]);
  });

  it("reads the shared monthly credit allowance only from the main Codex bucket", async () => {
    const individualLimit = { remainingPercent: 60, resetsAt: 1_784_500_000 };
    const client = {
      readAccountTokenUsage: async () => ({}),
      readAccountRateLimits: async () => ({
        rateLimitsByLimitId: {
          codex: { limitId: "codex", individualLimit },
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            limitName: "Spark",
            primary: { usedPercent: 5, windowDurationMins: 300 },
            individualLimit,
          },
        },
      }),
    } as unknown as CodexControlClient;

    const sections = await Effect.runPromise(readCodexAccountSections(client));
    expect(
      quotaWindowsFromSection(sections[1]!).map((window) => [window.windowKey, window.usedPercent]),
    ).toEqual([
      ["codex:individual", 40],
      ["codex_bengalfox:primary", 5],
    ]);
  });

  it("keeps partial endpoint support usable", async () => {
    const client = {
      readAccountTokenUsage: async () => ({ summary: {}, dailyUsageBuckets: [] }),
      readAccountRateLimits: async () => {
        throw new Error("method not found");
      },
    } as unknown as CodexControlClient;

    const sections = await Effect.runPromise(readCodexAccountSections(client));
    expect(sections[0]?.outcome).toBe("available");
    expect(sections[1]).toMatchObject({ outcome: "unsupported", errorCode: "unsupported" });
  });
});
