import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../../serverSettings.ts";

import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import { ProviderUpdateAdvisor } from "../Services/ProviderUpdateAdvisor.ts";
import {
  failureRetryDelayMs,
  hasAdvisoryStateChanged,
  ProviderUpdateAdvisorLive,
} from "./ProviderUpdateAdvisorLive.ts";

function makeProvider(input: {
  readonly instanceId: string;
  readonly driver?: "codex" | "cursor";
  readonly version: string | null;
}): ServerProvider {
  const driver = ProviderDriverKind.make(input.driver ?? "codex");
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    enabled: true,
    installed: true,
    version: input.version,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-05-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function registryLayer(providers: ReadonlyArray<ServerProvider>) {
  const registry: ProviderRegistryShape = {
    getProviders: Effect.succeed(providers),
    refresh: () => Effect.succeed(providers),
    refreshInstance: () => Effect.succeed(providers),
    streamChanges: Stream.empty,
  };
  return Layer.succeed(ProviderRegistry, registry);
}

function httpClientLayer(version: string, calls: { count: number }) {
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.count += 1;
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ version })));
    }),
  );
  return Layer.succeed(HttpClient.HttpClient, client);
}

describe("ProviderUpdateAdvisorLive", () => {
  it("keeps checkedAt-only changes out of advisory stream diffs", () => {
    assert.strictEqual(
      hasAdvisoryStateChanged(
        {
          status: "behind_latest",
          currentVersion: "0.1.0",
          latestVersion: "0.2.0",
          updateCommand: {
            executable: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
            channel: "npm",
          },
          checkedAt: "2026-05-26T00:00:00.000Z",
          message: "old",
        },
        {
          status: "behind_latest",
          currentVersion: "0.1.0",
          latestVersion: "0.2.0",
          updateCommand: {
            executable: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
            channel: "npm",
          },
          checkedAt: "2026-05-26T01:00:00.000Z",
          message: "new",
        },
      ),
      false,
    );
  });

  it("applies per-failure retry delays and rate-limit exponential backoff caps", () => {
    assert.strictEqual(failureRetryDelayMs({ _tag: "network", cause: "offline" }, 0), 1_800_000);
    assert.strictEqual(failureRetryDelayMs({ _tag: "not_found" }, 0), 86_400_000);
    assert.strictEqual(failureRetryDelayMs({ _tag: "parse", cause: "bad json" }, 0), 21_600_000);
    assert.strictEqual(failureRetryDelayMs({ _tag: "rate_limited" }, 0), 1_800_000);
    assert.strictEqual(failureRetryDelayMs({ _tag: "rate_limited" }, 1), 3_600_000);
    assert.strictEqual(failureRetryDelayMs({ _tag: "rate_limited" }, 20), 86_400_000);
    assert.strictEqual(
      failureRetryDelayMs({ _tag: "rate_limited", retryAfterMs: 7_200_000 }, 0),
      7_200_000,
    );
  });

  it.effect(
    "shares latest-version lookup by driver while deriving per-instance advisory state",
    () => {
      const calls = { count: 0 };
      const layer = ProviderUpdateAdvisorLive.pipe(
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(
          registryLayer([
            makeProvider({ instanceId: "codex-old", version: "0.1.0" }),
            makeProvider({ instanceId: "codex-current", version: "0.2.0" }),
          ]),
        ),
        Layer.provide(httpClientLayer("0.2.0", calls)),
      );

      return Effect.gen(function* () {
        const advisor = yield* ProviderUpdateAdvisor;
        yield* advisor.refreshAdvisories({ force: true });

        const oldAdvisory = yield* advisor.getAdvisoryFor({
          instanceId: ProviderInstanceId.make("codex-old"),
          driver: ProviderDriverKind.make("codex"),
          currentVersion: "0.1.0",
        });
        const currentAdvisory = yield* advisor.getAdvisoryFor({
          instanceId: ProviderInstanceId.make("codex-current"),
          driver: ProviderDriverKind.make("codex"),
          currentVersion: "0.2.0",
        });

        assert.strictEqual(calls.count, 1);
        assert.strictEqual(oldAdvisory.status, "behind_latest");
        assert.strictEqual(oldAdvisory.latestVersion, "0.2.0");
        assert.deepStrictEqual(oldAdvisory.updateCommand?.args, [
          "install",
          "-g",
          "@openai/codex@latest",
        ]);
        assert.strictEqual(currentAdvisory.status, "current");
        assert.strictEqual(currentAdvisory.updateCommand, null);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does not call the registry for cursor latest-version checks", () => {
    const calls = { count: 0 };
    const layer = ProviderUpdateAdvisorLive.pipe(
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(
        registryLayer([makeProvider({ instanceId: "cursor", driver: "cursor", version: "1.0.0" })]),
      ),
      Layer.provide(httpClientLayer("9.9.9", calls)),
    );

    return Effect.gen(function* () {
      const advisor = yield* ProviderUpdateAdvisor;
      yield* advisor.refreshAdvisories({ force: true });
      const advisory = yield* advisor.getAdvisoryFor({
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        currentVersion: "1.0.0",
      });

      assert.strictEqual(calls.count, 0);
      assert.strictEqual(advisory.status, "unknown");
      assert.strictEqual(advisory.latestVersion, null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops checks while disabled and refreshes immediately when re-enabled", () => {
    const calls = { count: 0 };
    const settingsLayer = ServerSettingsService.layerTest({ enableProviderUpdateChecks: false });
    const advisorLayer = ProviderUpdateAdvisorLive.pipe(
      Layer.provide(settingsLayer),
      Layer.provide(registryLayer([makeProvider({ instanceId: "codex", version: "0.1.0" })])),
      Layer.provide(httpClientLayer("0.2.0", calls)),
    );
    const layer = Layer.merge(settingsLayer, advisorLayer);

    return Effect.gen(function* () {
      const advisor = yield* ProviderUpdateAdvisor;
      const settings = yield* ServerSettingsService;

      yield* advisor.refreshAdvisories({ force: true });
      yield* advisor.noteRegistryChanged;
      yield* Effect.yieldNow;
      assert.strictEqual(calls.count, 0);

      yield* settings.updateSettings({ enableProviderUpdateChecks: true });
      for (let index = 0; index < 10 && calls.count === 0; index += 1) {
        yield* Effect.yieldNow;
      }
      assert.strictEqual(calls.count, 1);

      yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      yield* Effect.yieldNow;
      yield* advisor.refreshAdvisories({ force: true });
      yield* advisor.noteRegistryChanged;
      yield* Effect.yieldNow;
      assert.strictEqual(calls.count, 1);
    }).pipe(Effect.provide(layer));
  });
});
