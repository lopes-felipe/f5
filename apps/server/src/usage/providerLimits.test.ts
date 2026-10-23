import { describe, expect, it } from "vitest";
import { normalizeProviderLimits, providerLimitsIdentity } from "./providerLimits.ts";
import { normalizeResetCredits, normalizeRateLimits } from "./codexAccountUsage.ts";

describe("provider limits", () => {
  it("changes the history identity when any account-selecting input changes", () => {
    const base = { HOME: "/users/me" };
    const identity = (
      environment: NodeJS.ProcessEnv,
      extra: { serverUrl?: string; apiEndpoint?: string } = {},
    ) => providerLimitsIdentity({ provider: "cursor", environment, ...extra });
    const reference = identity(base);
    expect(identity({ ...base })).toBe(reference);
    // Unrelated variables do not split the account.
    expect(identity({ ...base, PATH: "/bin" })).toBe(reference);
    for (const change of [
      { CURSOR_AUTH_TOKEN: "token-b" },
      { CURSOR_API_KEY: "key-b" },
      { CURSOR_API_ENDPOINT: "https://other" },
      { AGENT_CLI_CREDENTIAL_STORE: "file" },
      { XDG_CONFIG_HOME: "/cfg" },
      { APPDATA: "/appdata" },
      { GROK_AUTH: "{}" },
      { GROK_HOME: "/grok" },
      { GROK_CONFIG: "/grok.toml" },
      { OPENCODE_API_KEY: "oc" },
      { F5_CLIPROXY_ACCOUNT_ID: "acct" },
    ])
      expect(identity({ ...base, ...change }), JSON.stringify(change)).not.toBe(reference);
    expect(identity(base, { apiEndpoint: "https://other" })).not.toBe(reference);
    expect(identity(base, { serverUrl: "http://localhost:1" })).not.toBe(reference);
    // Secrets are hashed, never stored verbatim.
    expect(identity({ ...base, CURSOR_AUTH_TOKEN: "secret-token" })).not.toContain("secret");
  });

  it("keeps history across rotations that do not change the account", () => {
    const opencode = (environment: NodeJS.ProcessEnv) =>
      providerLimitsIdentity({ provider: "opencode", environment });
    const auth = (goKey: string, otherToken: string) =>
      JSON.stringify({
        "opencode-go": { type: "api", key: goKey },
        anthropic: { type: "oauth", access: otherToken },
      });
    // Another provider's token refreshing inside the blob is not an account switch.
    expect(opencode({ OPENCODE_AUTH_CONTENT: auth("go-a", "t1") })).toBe(
      opencode({ OPENCODE_AUTH_CONTENT: auth("go-a", "t2") }),
    );
    expect(opencode({ OPENCODE_AUTH_CONTENT: auth("go-a", "t1") })).not.toBe(
      opencode({ OPENCODE_AUTH_CONTENT: auth("go-b", "t1") }),
    );
    // The CLIProxy account ID identifies the account; rotating the hub key does not.
    const hub = (key: string, account: string) =>
      providerLimitsIdentity({
        provider: "antigravity",
        environment: {
          F5_CLIPROXY_HUB_URL: "https://hub",
          F5_CLIPROXY_ACCOUNT_ID: account,
          F5_CLIPROXY_API_KEY: key,
        },
      });
    expect(hub("key-1", "acct")).toBe(hub("key-2", "acct"));
    expect(hub("key-1", "acct")).not.toBe(hub("key-1", "other"));
    // A raw API key is the only account signal, so rotating it starts new history.
    const cursor = (token: string) =>
      providerLimitsIdentity({ provider: "cursor", environment: { CURSOR_AUTH_TOKEN: token } });
    expect(cursor("v1")).not.toBe(cursor("v2"));
  });

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
    // A billing read with nothing metered yet is a 0% meter, not an unsupported account.
    expect(normalizeProviderLimits("grok", { config: { currentPeriod: { end: "bad" } } })).toEqual([
      { id: "subscription", label: "Subscription", usedPercent: 0, resetsAt: null },
    ]);
    expect(normalizeProviderLimits("grok", { config: { creditUsagePercent: "n/a" } })).toEqual([]);
    expect(normalizeProviderLimits("grok", {})).toEqual([]);
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
