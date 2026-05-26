import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import {
  ProviderAdvisoryProjection,
  type ProviderAdvisoryProjectionShape,
} from "../Services/ProviderAdvisoryProjection.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import {
  ProviderUpdateAdvisor,
  type ProviderUpdateAdvisorShape,
} from "../Services/ProviderUpdateAdvisor.ts";
import { ProviderAdvisoryProjectionLive } from "./ProviderAdvisoryProjectionLive.ts";

function makeProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-05-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function makeAdvisory(): ServerProviderVersionAdvisory {
  return {
    status: "behind_latest",
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    updateCommand: {
      executable: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
      channel: "npm",
    },
    checkedAt: "2026-05-26T00:00:00.000Z",
    message: "Installed v0.1.0 · latest v0.2.0",
  };
}

function registryLayer(
  providers: ReadonlyArray<ServerProvider>,
  streamChanges = Stream.make(providers),
) {
  const registry: ProviderRegistryShape = {
    getProviders: Effect.succeed(providers),
    refresh: () => Effect.succeed(providers),
    refreshInstance: () => Effect.succeed(providers),
    streamChanges,
  };
  return Layer.succeed(ProviderRegistry, registry);
}

function advisorLayer(
  advisory: ServerProviderVersionAdvisory,
  streamChanges: ProviderUpdateAdvisorShape["streamChanges"] = Stream.empty,
) {
  const advisor: ProviderUpdateAdvisorShape = {
    getAdvisoryFor: () => Effect.succeed(advisory),
    streamChanges,
    noteRegistryChanged: Effect.void,
    refreshAdvisories: () => Effect.void,
  };
  return Layer.succeed(ProviderUpdateAdvisor, advisor);
}

describe("ProviderAdvisoryProjectionLive", () => {
  it.effect("decorates provider reads without mutating registry snapshots", () => {
    const provider = makeProvider();
    const layer = ProviderAdvisoryProjectionLive.pipe(
      Layer.provide(registryLayer([provider])),
      Layer.provide(advisorLayer(makeAdvisory())),
    );

    return Effect.gen(function* () {
      const projection = yield* ProviderAdvisoryProjection;
      const providers = yield* projection.getProviders;

      assert.strictEqual(providers[0]?.versionAdvisory?.status, "behind_latest");
      assert.strictEqual(provider.versionAdvisory, undefined);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not attach unknown advisories to provider snapshots", () => {
    const provider = makeProvider();
    const unknownAdvisory: ServerProviderVersionAdvisory = {
      status: "unknown",
      currentVersion: "0.1.0",
      latestVersion: null,
      updateCommand: null,
      checkedAt: "2026-05-26T00:00:00.000Z",
      message: null,
    };
    const layer = ProviderAdvisoryProjectionLive.pipe(
      Layer.provide(registryLayer([provider])),
      Layer.provide(advisorLayer(unknownAdvisory)),
    );

    return Effect.gen(function* () {
      const projection = yield* ProviderAdvisoryProjection;
      const providers = yield* projection.getProviders;

      assert.strictEqual(providers[0]?.versionAdvisory, undefined);
    }).pipe(Effect.provide(layer));
  });

  it.effect("decorates registry stream changes", () => {
    const provider = makeProvider();
    const layer = ProviderAdvisoryProjectionLive.pipe(
      Layer.provide(registryLayer([provider])),
      Layer.provide(advisorLayer(makeAdvisory())),
    );

    return Effect.gen(function* () {
      const projection: ProviderAdvisoryProjectionShape = yield* ProviderAdvisoryProjection;
      const emitted = yield* projection.streamChanges.pipe(Stream.runCollect);

      assert.strictEqual(emitted[0]?.[0]?.versionAdvisory?.latestVersion, "0.2.0");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not emit provider projection changes for advisor-only updates", () => {
    const provider = makeProvider();
    const advisoryEntry = {
      instanceId: provider.instanceId,
      driver: provider.driver,
      versionAdvisory: makeAdvisory(),
    };
    const layer = ProviderAdvisoryProjectionLive.pipe(
      Layer.provide(registryLayer([provider], Stream.empty)),
      Layer.provide(advisorLayer(makeAdvisory(), Stream.make([advisoryEntry]))),
    );

    return Effect.gen(function* () {
      const projection: ProviderAdvisoryProjectionShape = yield* ProviderAdvisoryProjection;
      const emitted = yield* projection.streamChanges.pipe(Stream.runCollect);

      assert.strictEqual(emitted.length, 0);
    }).pipe(Effect.provide(layer));
  });
});
