import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeProviderLimits, GROK_USAGE_URL } from "./providerLimits.ts";

afterEach(() => vi.unstubAllGlobals());

it("reads Grok usage through the selected xAI hub account", async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe("https://hub.example");
    expect(init.redirect).toBe("error");
    if (url.endsWith("/auth-files")) {
      return Response.json({
        files: [
          { id: "selected", provider: "antigravity", auth_index: "wrong-provider" },
          { id: "wrong", provider: "xai", auth_index: "wrong-account" },
          { id: "selected", provider: "xai", auth_index: "right" },
        ],
      });
    }
    expect(url).toBe("https://hub.example/v0/management/api-call");
    expect(JSON.parse(String(init.body))).toMatchObject({
      auth_index: "right",
      url: GROK_USAGE_URL,
      method: "GET",
      header: {
        Authorization: "Bearer $TOKEN$",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": "1.0.77",
      },
    });
    return Response.json({
      status_code: 200,
      body: JSON.stringify({ config: { creditUsagePercent: 35 } }),
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const capability = yield* makeProviderLimits({
        provider: "grok",
        instanceId: ProviderInstanceId.make("instance"),
        displayName: "Account",
        enabled: true,
        environment: {
          F5_CLIPROXY_HUB_URL: "https://hub.example/management.html",
          F5_CLIPROXY_API_KEY: "management",
          F5_CLIPROXY_ACCOUNT_ID: "selected",
        },
      });
      return yield* capability.refreshAccount!(yield* Semaphore.make(1));
    }).pipe(Effect.scoped),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.snapshot.sections[0]?.snapshot?.data).toMatchObject({
    windows: [{ usedPercent: 35 }],
  });
});
