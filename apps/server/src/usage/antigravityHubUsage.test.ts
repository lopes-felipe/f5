import { ProviderInstanceId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeProviderLimits, normalizeProviderLimits } from "./providerLimits.ts";

const DAILY = "daily-cloudcode-pa.googleapis.com";
const STANDARD = "cloudcode-pa.googleapis.com";
const resetTime = "2026-11-03T00:00:00Z";
const bucket = (bucketId: string, remainingFraction: number, window = "5h") => ({
  bucketId,
  remainingFraction,
  window,
  resetTime,
});
const hubResponse = (body: unknown, status_code = 200) =>
  new Response(JSON.stringify({ status_code, body: JSON.stringify(body) }));

async function probe(
  respond: (endpoint: URL, signal: AbortSignal) => Response | Promise<Response>,
  options: { discoveryDelayMs?: number; stallDiscovery?: boolean } = {},
) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).hostname).toBe("hub.example");
    expect(init.headers).toMatchObject({ Authorization: "Bearer management-key" });
    if (new URL(url).pathname === "/v0/management/auth-files") {
      if (options.stallDiscovery) return new Promise<Response>(() => {});
      if (options.discoveryDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.discoveryDelayMs));
      return new Response(
        JSON.stringify({
          files: [{ id: "chosen", provider: "antigravity", auth_index: "selected" }],
        }),
      );
    }
    const request = JSON.parse(String(init.body));
    expect(request).toMatchObject({
      auth_index: "selected",
      method: "POST",
      header: { Authorization: "Bearer $TOKEN$" },
      data: JSON.stringify({ project: "my-project" }),
    });
    expect(request.header["User-Agent"]).toMatch(/^antigravity\/hub\/2\.24\.0 /);
    return respond(new URL(request.url), init.signal!);
  });
  vi.stubGlobal("fetch", fetchMock);
  const refreshed = await Effect.runPromise(
    Effect.gen(function* () {
      const capability = yield* makeProviderLimits({
        provider: "antigravity",
        instanceId: ProviderInstanceId.make("antigravity-test"),
        displayName: "Antigravity",
        enabled: true,
        environment: {
          F5_CLIPROXY_HUB_URL: "https://hub.example",
          F5_CLIPROXY_API_KEY: "management-key",
          F5_CLIPROXY_ACCOUNT_ID: "chosen",
          F5_ANTIGRAVITY_PROJECT: "my-project",
        },
      });
      const permits = yield* Semaphore.make(1);
      return yield* capability.refreshAccount!(permits);
    }).pipe(Effect.scoped),
  );
  const section = refreshed.snapshot.sections[0];
  if (section?.kind !== "provider-limits") throw new Error("Missing provider limits");
  return { section, fetchMock, fresh: refreshed.fresh };
}

async function timedProbe(
  respond: Parameters<typeof probe>[0],
  options: Parameters<typeof probe>[1] = {},
) {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const pending = probe(respond, options);
  await vi.advanceTimersByTimeAsync(7_500);
  return pending;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Antigravity hub quotas", () => {
  it("queries both hosts concurrently and keeps Gemini and the most-used duplicate buckets", async () => {
    const pending: Array<() => void> = [];
    const called: string[] = [];
    const { section, fetchMock } = await probe(async (endpoint) => {
      expect(endpoint.pathname).toBe("/v1internal:retrieveUserQuotaSummary");
      called.push(endpoint.hostname);
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        if (pending.length === 2) pending.forEach((resume) => resume());
      });
      return hubResponse({
        groups: [
          {
            buckets:
              endpoint.hostname === DAILY
                ? [bucket("3p-weekly", 0, "weekly"), bucket("3p-5h", 0.9)]
                : [
                    bucket("gemini-5h", 0.8),
                    bucket("gemini-weekly", 0.7, "weekly"),
                    bucket("3p-weekly", 0.5, "weekly"),
                    bucket("3p-5h", 0.3),
                  ],
          },
        ],
      });
    });
    expect(called).toEqual([DAILY, STANDARD]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(section.outcome).toBe("available");
    const windows = new Map(section.snapshot?.data.windows.map((window) => [window.id, window]));
    expect([...windows.keys()].sort()).toEqual([
      "3p-5h",
      "3p-weekly",
      "gemini-5h",
      "gemini-weekly",
    ]);
    expect(windows.get("3p-5h")?.usedPercent).toBeCloseTo(70);
    expect(windows.get("3p-weekly")?.usedPercent).toBe(100);
    expect(windows.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
    expect(windows.get("gemini-5h")?.resetsAt).toBe("2026-11-03T00:00:00.000Z");
  });

  it.each(["network", "http", "provider", "json"] as const)(
    "keeps usable quotas when one host has a %s failure",
    async (failure) => {
      const { section, fetchMock, fresh } = await probe((endpoint) => {
        if (endpoint.hostname === STANDARD)
          return hubResponse({ buckets: [bucket("gemini-5h", 0.75)] });
        if (failure === "network") throw new Error("offline");
        if (failure === "http") return new Response("", { status: 503 });
        if (failure === "provider") return hubResponse({}, 503);
        return new Response(JSON.stringify({ status_code: 200, body: "malformed" }));
      });
      expect(section.outcome).toBe("unavailable");
      expect(section.errorCode).toBe("temporary-failure");
      expect(fresh).toBe(false);
      expect(section.snapshot?.data.windows).toMatchObject([{ id: "gemini-5h", usedPercent: 25 }]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    },
  );

  it("keeps usable quotas when one host ignores abort and stalls through both operations", async () => {
    const { section, fresh } = await timedProbe((endpoint) =>
      endpoint.hostname === STANDARD
        ? hubResponse({ buckets: [bucket("gemini-5h", 0.75)] })
        : new Promise<Response>(() => {}),
    );
    expect(section.outcome).toBe("unavailable");
    expect(section.errorCode).toBe("temporary-failure");
    expect(section.snapshot?.data.windows).toMatchObject([{ id: "gemini-5h", usedPercent: 25 }]);
    expect(fresh).toBe(false);
  });

  it("includes slow discovery in the budget without losing the fulfilled host's quotas", async () => {
    const { section } = await timedProbe(
      (endpoint) =>
        endpoint.hostname === STANDARD
          ? hubResponse({ buckets: [bucket("gemini-5h", 0.75)] })
          : new Promise<Response>(() => {}),
      { discoveryDelayMs: 5_500 },
    );
    expect(section.snapshot?.data.windows).toMatchObject([{ id: "gemini-5h", usedPercent: 25 }]);
    expect(section.errorCode).toBe("temporary-failure");
  });

  it("reserves model fallback time after slow discovery and a stalled summary", async () => {
    const { section, fresh } = await timedProbe(
      (endpoint) => {
        if (endpoint.hostname === DAILY) return hubResponse({ buckets: [bucket("3p-5h", 0.5)] });
        if (endpoint.pathname.endsWith(":retrieveUserQuotaSummary"))
          return new Promise<Response>(() => {});
        return hubResponse({ models: { gemini: { quotaInfo: { remainingFraction: 0.75 } } } });
      },
      { discoveryDelayMs: 5_500 },
    );
    expect(section.outcome).toBe("unavailable");
    expect(section.snapshot?.data.windows.map((window) => window.id).sort()).toEqual([
      "3p-5h",
      "gemini",
    ]);
    expect(fresh).toBe(false);
  });

  it("bounds discovery even when the transport ignores cancellation", async () => {
    const { section, fetchMock } = await timedProbe(() => hubResponse({}), {
      stallDiscovery: true,
    });
    expect(section).toMatchObject({ outcome: "unavailable", errorCode: "timeout", snapshot: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "http", "unrecognized"] as const)(
    "falls back on a host's %s summary even when the other host has shared buckets",
    async (summary) => {
      const { section, fresh } = await probe((endpoint) => {
        if (endpoint.hostname === DAILY) return hubResponse({ buckets: [bucket("3p-5h", 0.5)] });
        if (endpoint.pathname.endsWith(":retrieveUserQuotaSummary"))
          return summary === "http"
            ? hubResponse({}, 503)
            : hubResponse(summary === "empty" ? { buckets: [] } : {});
        return hubResponse({ models: { gemini: { quotaInfo: { remainingFraction: 0.75 } } } });
      });
      expect(section.outcome).toBe(summary === "http" ? "unavailable" : "available");
      expect(fresh).toBe(summary !== "http");
      expect(section.snapshot?.data.windows.map((window) => window.id).sort()).toEqual([
        "3p-5h",
        "gemini",
      ]);
    },
  );

  it("falls back to both model endpoints only when summaries have no usable windows", async () => {
    const called: string[] = [];
    const { section } = await probe((endpoint) => {
      called.push(endpoint.href);
      if (endpoint.pathname.endsWith(":retrieveUserQuotaSummary"))
        return hubResponse({ groups: [] });
      return hubResponse({
        models: {
          shared: { quotaInfo: { remainingFraction: endpoint.hostname === DAILY ? 0.9 : 0.2 } },
          [endpoint.hostname === DAILY ? "claude" : "gemini"]: {
            quotaInfo: { remainingFraction: 0.5 },
          },
        },
      });
    });
    for (const host of [DAILY, STANDARD])
      expect(
        called.filter((url) => new URL(url).hostname === host).map((url) => new URL(url).pathname),
      ).toEqual(["/v1internal:retrieveUserQuotaSummary", "/v1internal:fetchAvailableModels"]);
    const windows = new Map(section.snapshot?.data.windows.map((window) => [window.id, window]));
    expect([...windows.keys()].sort()).toEqual(["claude", "gemini", "shared"]);
    expect(windows.get("shared")?.usedPercent).toBe(80);
  });

  it("reports successful responses with no recognizable quotas as unsupported", async () => {
    const { section } = await probe(() => hubResponse({}));
    expect(section).toMatchObject({
      outcome: "unsupported",
      errorCode: "unsupported",
      snapshot: null,
    });
  });

  it("reports failed requests as a temporary failure rather than unsupported", async () => {
    const { section, fresh } = await probe(() => {
      throw new Error("offline");
    });
    expect(section).toMatchObject({
      outcome: "unavailable",
      errorCode: "temporary-failure",
      snapshot: null,
    });
    expect(fresh).toBe(false);
  });

  it("keeps model fallback quotas when the other host fails", async () => {
    const { section } = await probe((endpoint) => {
      if (endpoint.hostname === DAILY) throw new Error("offline");
      if (endpoint.pathname.endsWith(":retrieveUserQuotaSummary"))
        return hubResponse({ buckets: [] });
      return hubResponse({
        models: { gemini: { quotaInfo: { remainingFraction: 0.75 } } },
      });
    });
    expect(section.outcome).toBe("unavailable");
    expect(section.snapshot?.data.windows).toMatchObject([{ id: "gemini", usedPercent: 25 }]);
  });

  it("skips malformed and disabled summary buckets and supports ungrouped quotas", () => {
    expect(
      normalizeProviderLimits("antigravity", {
        buckets: [
          null,
          { bucketId: "invalid", remainingFraction: "unknown" },
          { ...bucket("disabled", 0), disabled: true },
          bucket("gemini-5h", 0.8),
          bucket("gemini-5h", 0.3),
          { ...bucket("custom", 0.5, "other"), displayName: "Custom" },
        ],
      }),
    ).toEqual([
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour",
        usedPercent: 70,
        resetsAt: "2026-11-03T00:00:00.000Z",
      },
      {
        id: "custom",
        label: "custom · Custom",
        usedPercent: 50,
        resetsAt: "2026-11-03T00:00:00.000Z",
      },
    ]);
  });

  it("labels Argon separately from the main Gemini allowance", () => {
    const windows = normalizeProviderLimits("antigravity", {
      groups: [
        { buckets: [bucket("gemini-weekly", 0.8, "weekly")] },
        {
          displayName: "Gemini 4 Argon",
          buckets: [bucket("gemini-argon-wtu-weekly", 0.6, "weekly")],
        },
      ],
    });
    expect(windows.map((window) => window.label)).toEqual([
      "Gemini · Weekly",
      "Gemini 4 Argon · Weekly",
    ]);
  });

  it.each(["5h", "weekly"] as const)(
    "suppresses only untouched rolling %s resets within a minute of the request",
    (window) => {
      const requestedAt = Date.parse("2026-11-02T12:00:00Z");
      const durationMs = (window === "5h" ? 5 : 7 * 24) * 60 * 60_000;
      const resetAt = (offset: number) => new Date(requestedAt + durationMs + offset).toISOString();
      const reported = {
        ...bucket("quota", 1, window),
        resetTime: resetAt(0),
      };
      const resets = (buckets: unknown[]) =>
        normalizeProviderLimits("antigravity", { buckets }, requestedAt).map(
          (quota) => quota.resetsAt,
        );
      expect(
        resets(
          [-60_000, 0, 60_000].map((offset, index) => ({
            ...reported,
            bucketId: String(index),
            resetTime: resetAt(offset),
          })),
        ),
      ).toEqual([null, null, null]);
      expect(
        resets([
          { ...reported, bucketId: "used", remainingFraction: 0.5 },
          { ...reported, bucketId: "spent", remainingFraction: 0 },
          { ...reported, bucketId: "described", description: "" },
          { ...reported, bucketId: "distant", resetTime: resetAt(61_000) },
          { ...reported, bucketId: "overfull", remainingFraction: 1.01 },
        ]),
      ).toEqual([resetAt(0), resetAt(0), resetAt(0), resetAt(61_000), resetAt(0)]);
      expect(
        normalizeProviderLimits(
          "antigravity",
          {
            models: { model: { quotaInfo: { remainingFraction: 1, resetTime: resetAt(0) } } },
          },
          requestedAt,
        )[0]?.resetsAt,
      ).toBe(resetAt(0));
    },
  );
});
