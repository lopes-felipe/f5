import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderKind,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer, PubSub, Stream } from "effect";

import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { defaultProviderContinuationIdentity, type ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapterShape = {
  provider: "claudeAgent",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  runOneOffPrompt: vi.fn(),
  compactConversation: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

function makeInstance(input: {
  provider: ProviderKind;
  adapter: CodexAdapterShape | ClaudeAdapterShape;
}): ProviderInstance {
  const driverKind = ProviderDriverKind.make(input.provider);
  const instanceId = defaultInstanceIdForDriver(driverKind);
  return {
    instanceId,
    driverKind,
    displayName: input.provider,
    enabled: true,
    continuationIdentity: defaultProviderContinuationIdentity({ driverKind, instanceId }),
    adapter: input.adapter,
    snapshot: {} as never,
    textGeneration: {} as never,
  };
}

const instances = [
  makeInstance({ provider: "codex", adapter: fakeCodexAdapter }),
  makeInstance({ provider: "claudeAgent", adapter: fakeClaudeAdapter }),
];

const layer = it.layer(
  Layer.mergeAll(
    Layer.provide(
      ProviderAdapterRegistryLive,
      Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
        listInstances: Effect.succeed(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
          Effect.flatMap(PubSub.subscribe),
        ),
      }),
    ),
    NodeServices.layer,
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const codex = yield* registry.getByProvider("codex");
      const claude = yield* registry.getByProvider("claudeAgent");
      assert.equal(codex, fakeCodexAdapter);
      assert.equal(claude, fakeClaudeAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, ["codex", "claudeAgent"]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});
