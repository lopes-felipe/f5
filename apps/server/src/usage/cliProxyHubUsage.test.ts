import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeProviderLimits, GROK_USAGE_URL } from "./providerLimits";
import { accountUsageSnapshotIdentity } from "./accountUsage";

afterEach(() => vi.unstubAllGlobals());
describe("selected CLIProxyAPI hub accounts", () => {
  it.each(["xai", "antigravity"])(
    "uses the selected %s auth file and local quota mapper",
    async (provider) => {
      const requests: Record<string, unknown>[] = [];
      let failUserInfo = false;
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        expect(new URL(url).origin).toBe("https://hub.example");
        if (url.endsWith("/auth-files"))
          return new Response(
            JSON.stringify({
              files: [
                { id: "wrong", provider, auth_index: "wrong" },
                { id: "selected", provider, auth_index: "right", project_id: "hub-project" },
              ],
            }),
          );
        const request = JSON.parse(String(init.body));
        requests.push(request);
        expect(request.auth_index).toBe("right");
        expect(request.header.Authorization).toBe("Bearer $TOKEN$");
        if (failUserInfo && request.url.includes("/userinfo")) throw new Error("Unavailable");
        const body =
          request.url === GROK_USAGE_URL
            ? { config: { creditUsagePercent: 35 } }
            : request.url.includes("/userinfo")
              ? { id: "stable-google-account" }
              : { buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.7, window: "5h" }] };
        return new Response(JSON.stringify({ status_code: 200, body: JSON.stringify(body) }));
      });
      vi.stubGlobal("fetch", fetcher);
      await Effect.runPromise(
        Effect.gen(function* () {
          const capability = yield* makeProviderLimits({
            provider: provider === "xai" ? "grok" : "antigravity",
            instanceId: ProviderInstanceId.make("instance"),
            displayName: "Account",
            enabled: true,
            environment: {
              F5_CLIPROXY_HUB_URL: "https://hub.example/management.html",
              F5_CLIPROXY_API_KEY: "management",
              F5_CLIPROXY_ACCOUNT_ID: "selected",
            },
          });
          const result = yield* capability.refreshAccount!(yield* Semaphore.make(1));
          const section = result.snapshot.sections[0];
          expect(section?.snapshot?.data).toMatchObject({
            windows: [{ usedPercent: provider === "xai" ? 35 : expect.closeTo(30) }],
          });
          if (provider === "xai") {
            expect(requests[0]).toMatchObject({
              url: GROK_USAGE_URL,
              method: "GET",
              header: { "x-xai-token-auth": "xai-grok-cli", "x-grok-client-version": "1.0.77" },
            });
          } else {
            expect(
              requests.some(
                (request) => request.url === "https://www.googleapis.com/oauth2/v2/userinfo",
              ),
            ).toBe(true);
            expect(accountUsageSnapshotIdentity(capability, result.snapshot)).toMatch(
              /^antigravity:/,
            );
            expect(accountUsageSnapshotIdentity(capability, result.snapshot)).not.toBe(
              capability.identity,
            );
            const identity = accountUsageSnapshotIdentity(capability, result.snapshot);
            failUserInfo = true;
            yield* capability.invalidate!;
            const retry = yield* capability.refreshAccount!(yield* Semaphore.make(1), "if-stale");
            expect(accountUsageSnapshotIdentity(capability, retry.snapshot)).toBe(identity);
          }
        }).pipe(Effect.scoped),
      );
    },
  );
});
