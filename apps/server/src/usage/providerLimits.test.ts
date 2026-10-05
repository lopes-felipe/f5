import { describe, expect, it } from "vitest";
import { normalizeProviderLimits } from "./providerLimits.ts";
import { normalizeResetCredits, normalizeRateLimits } from "./codexAccountUsage.ts";

describe("provider limits", () => {
  it("uses Cursor dashboard percentages and rejects non-finite values", () => {
    expect(
      normalizeProviderLimits("cursor", {
        planUsage: { totalPercentUsed: 30, apiPercentUsed: NaN },
        billingCycleEnd: "1791000000000",
      }),
    ).toEqual([
      {
        id: "totalPercentUsed",
        label: "Monthly",
        usedPercent: 30,
        resetsAt: new Date(1791000000000).toISOString(),
      },
    ]);
  });
  it("normalizes subscription windows without inventing credentials or quota", () => {
    expect(
      normalizeProviderLimits("grok", { config: { creditUsagePercent: 140 } })[0]?.usedPercent,
    ).toBe(100);
    expect(
      normalizeProviderLimits("opencode", { usage: { weekly: { percent: 0, resetsAt: "bad" } } }),
    ).toEqual([{ id: "weekly", label: "Go · weekly", usedPercent: 0, resetsAt: null }]);
    expect(normalizeProviderLimits("antigravity", {})).toEqual([]);
  });
  it("keeps main and Spark windows separate and distinguishes omitted reset credits", () => {
    const limits = normalizeRateLimits({
      rateLimits: { limitId: "spark", primary: { usedPercent: 90 } },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 20 } },
        spark: { primary: { usedPercent: 90 } },
      },
    });
    expect(limits.find((limit) => limit.id === "codex")?.primary?.usedPercent).toBe(20);
    expect(normalizeResetCredits({})).toEqual({});
    expect(
      normalizeResetCredits({ rateLimitResetCredits: { availableCount: 0, credits: [] } }),
    ).toEqual({ resetCredits: { availableCount: 0, nextExpiresAt: null } });
  });
});

it("reads only the configured hub account and never sends its management key to the provider", async () => {
  const { Effect } = await import("effect");
  const Semaphore = await import("effect/Semaphore");
  const { ProviderInstanceId } = await import("@t3tools/contracts");
  const { makeProviderLimits } = await import("./providerLimits.ts");
  const { vi } = await import("vitest");
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          files: [
            {
              id: "different",
              provider: "antigravity",
              auth_index: "wrong",
              email: "same@example.com",
            },
            {
              id: "chosen",
              provider: "antigravity",
              auth_index: "right",
              email: "same@example.com",
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status_code: 200,
          body: JSON.stringify({
            models: {
              model: {
                displayName: "Gemini",
                quotaInfo: { remainingFraction: 0.75, resetTime: "2026-10-02T19:00:00Z" },
              },
            },
          }),
        }),
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const capability = yield* makeProviderLimits({
          provider: "antigravity",
          instanceId: ProviderInstanceId.make("antigravity-test"),
          displayName: "Account",
          enabled: true,
          environment: {
            F5_CLIPROXY_HUB_URL: "https://hub.example",
            F5_CLIPROXY_API_KEY: "secret-test-key",
            F5_CLIPROXY_ACCOUNT_ID: "chosen",
          },
        });
        const permits = yield* Semaphore.make(1);
        yield* capability.refresh("force", permits);
        for (let index = 0; index < 20; index++) {
          const value = yield* capability.getSnapshot;
          if (value.refreshState === "idle") return value;
          yield* Effect.sleep("10 millis");
        }
        return yield* capability.getSnapshot;
      }).pipe(Effect.scoped),
    );
    expect(snapshot.sections[0]?.outcome).toBe("available");
    const section = snapshot.sections[0];
    if (section?.kind === "provider-limits")
      expect(section.snapshot?.data.windows[0]?.usedPercent).toBe(25);
    expect(fetchMock.mock.calls.map((call) => new URL(call[0]).hostname)).toEqual([
      "hub.example",
      "hub.example",
    ]);
    const sent = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(sent.auth_index).toBe("right");
    expect(sent.header.Authorization).toBe("Bearer $TOKEN$");
    expect(fetchMock.mock.calls[1]![1].redirect).toBe("error");
  } finally {
    vi.unstubAllGlobals();
  }
});
