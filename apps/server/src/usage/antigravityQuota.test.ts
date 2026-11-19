import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { makeAntigravityQuotaReader } from "./antigravityQuota.ts";
import { normalizeProviderLimits } from "./providerLimits.ts";

const credentials = (refreshToken = "refresh-a") =>
  JSON.stringify({
    client_id: "client",
    client_secret: "secret",
    refresh_token: refreshToken,
    project_id: "project",
  });
const quota = { buckets: [{ bucketId: "gemini-session", remainingFraction: 0.75, window: "5h" }] };
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const normalize = (value: unknown, at: number) => normalizeProviderLimits("antigravity", value, at);

describe("Antigravity native quota", () => {
  it("publishes good quotas as partial within the shared budget when another host hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const read = makeAntigravityQuotaReader({
        profileDirectory: "/instance",
        readFile: async () => credentials(),
        normalize,
        fetch: async (url) => {
          if (String(url).includes("/token")) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            return response({ access_token: "access", expires_in: 3600 });
          }
          if (String(url).includes("daily-")) return new Promise<Response>(() => {});
          return response(quota);
        },
      });
      const result = read(new AbortController().signal);
      await vi.advanceTimersByTimeAsync(7_000);
      expect(await result).toMatchObject({ partial: true, windows: [{ usedPercent: 25 }] });
      expect(performance.now()).toBe(7_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("reads only this instance's token file and caches access tokens without writing credentials", async () => {
    const readFile = vi.fn(async () => credentials());
    const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
      async (url) =>
        response(
          String(url).includes("/token") ? { access_token: "access", expires_in: 3600 } : quota,
        ),
    );
    const read = makeAntigravityQuotaReader({
      profileDirectory: "/instance",
      readFile,
      fetch,
      normalize,
    });
    const first = await read(new AbortController().signal);
    expect(first?.windows[0]?.usedPercent).toBe(25);
    expect(first?.partial).toBe(false);
    await read(new AbortController().signal);
    expect(readFile).toHaveBeenCalledWith(join("/instance", "antigravity-acp", "acp_token.json"));
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(1);
    const request = fetch.mock.calls.find(([url]) =>
      String(url).includes("retrieveUserQuotaSummary"),
    );
    expect(request?.[1]?.headers).toMatchObject({ Authorization: "Bearer access" });
    expect(request?.[1]?.redirect).toBe("error");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ project: "project" });
  });

  it("invalidates a cached token when the signed-in account changes", async () => {
    let stored = credentials();
    const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
      async (url) =>
        response(
          String(url).includes("/token") ? { access_token: "access", expires_in: 3600 } : quota,
        ),
    );
    const read = makeAntigravityQuotaReader({
      profileDirectory: "/instance",
      readFile: async () => stored,
      fetch,
      normalize,
    });
    const first = await read(new AbortController().signal);
    stored = credentials("refresh-b");
    const next = await read(new AbortController().signal);
    expect(next?.accountFingerprint).not.toBe(first?.accountFingerprint);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(2);
  });

  it("falls back per host and keeps the more conservative model quota", async () => {
    const read = makeAntigravityQuotaReader({
      profileDirectory: "/instance",
      readFile: async () => credentials(),
      normalize,
      fetch: vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
        async (url) => {
          if (String(url).includes("/token"))
            return response({ access_token: "access", expires_in: 3600 });
          if (String(url).includes("retrieveUserQuotaSummary")) return response({});
          return response({
            models: {
              "gemini-pro": {
                quotaInfo: { remainingFraction: String(url).includes("daily-") ? 0.9 : 0.2 },
              },
            },
          });
        },
      ),
    });
    const result = await read(new AbortController().signal);
    expect(result?.windows[0]?.usedPercent).toBe(80);
  });

  it("does not send requests without credentials and never follows an OAuth redirect", async () => {
    const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>();
    const read = makeAntigravityQuotaReader({
      profileDirectory: "/instance",
      readFile: async () => "{}",
      fetch,
      normalize,
    });
    expect(await read(new AbortController().signal)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves usable quotas when another host fails", async () => {
    const read = makeAntigravityQuotaReader({
      profileDirectory: "/instance",
      readFile: async () => credentials(),
      normalize,
      fetch: vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
        async (url) => {
          if (String(url).includes("/token"))
            return response({ access_token: "access", expires_in: 3600 });
          if (String(url).includes("daily-")) throw new Error("offline");
          return response(quota);
        },
      ),
    });
    const result = await read(new AbortController().signal);
    expect(result?.windows).toHaveLength(1);
    expect(result?.partial).toBe(true);
  });
});
