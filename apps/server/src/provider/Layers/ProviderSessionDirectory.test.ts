import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
    NodeServices.layer,
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it("fences incomplete-history markers and retains them through replacement until exact recovery", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.makeUnsafe("incomplete-history");
      const instanceId = ProviderInstanceId.make("codex");
      yield* directory.upsert({
        threadId,
        provider: "codex",
        providerInstanceId: instanceId,
        runtimePayload: { sessionGeneration: 2, activeTurnId: "turn-2" },
      });
      const marker = {
        eventId: "missing-output",
        turnId: "turn-2",
        historyIdentity: "native-thread",
      };
      assert.isFalse(
        yield* directory.updateHistoryReconciliationIfCurrent({
          threadId,
          instanceId,
          generation: 1,
          marker,
        }),
      );
      assert.isFalse(
        yield* directory.updateHistoryReconciliationIfCurrent({
          threadId,
          instanceId: ProviderInstanceId.make("other"),
          generation: 2,
          marker,
        }),
      );
      assert.isTrue(
        yield* directory.updateHistoryReconciliationIfCurrent({
          threadId,
          instanceId,
          generation: 2,
          marker,
        }),
      );
      yield* directory.upsert({
        threadId,
        provider: "codex",
        providerInstanceId: instanceId,
        runtimePayload: { sessionGeneration: 3, activeTurnId: null },
      });
      const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
      assert.deepEqual(
        (binding.runtimePayload as Record<string, unknown>).historyReconciliationRequired,
        marker,
      );
      assert.isFalse(
        yield* directory.updateHistoryReconciliationIfCurrent({
          threadId,
          instanceId,
          generation: 2,
          marker: null,
          expectedMarkerId: marker.eventId,
        }),
      );
      assert.isFalse(
        yield* directory.updateHistoryReconciliationIfCurrent({
          threadId,
          instanceId,
          generation: 3,
          marker: null,
          expectedMarkerId: "different-recovery",
        }),
      );
      assert.isTrue(
        yield* directory.updateHistoryReconciliationIfCurrent({
          threadId,
          instanceId,
          generation: 3,
          marker: null,
          expectedMarkerId: marker.eventId,
        }),
      );
      const recovered = Option.getOrThrow(yield* directory.getBinding(threadId));
      assert.equal(
        (recovered.runtimePayload as Record<string, unknown>).historyReconciliationRequired,
        null,
      );
    }));

  it("upserts and reads thread bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const initialThreadId = ThreadId.makeUnsafe("thread-1");

      yield* directory.upsert({
        provider: "codex",
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(initialThreadId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialThreadId);
      assert.equal(Option.isSome(resolvedBinding), true);
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.threadId, initialThreadId);
        assert.equal(resolvedBinding.value.provider, "codex");
        assert.equal(typeof resolvedBinding.value.lastSeenAt, "string");
      }

      const nextThreadId = ThreadId.makeUnsafe("thread-2");

      yield* directory.upsert({
        provider: "codex",
        threadId: nextThreadId,
      });
      const updatedBinding = yield* directory.getBinding(nextThreadId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
      }

      const runtime = yield* runtimeRepository.getByThreadId({ threadId: nextThreadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.providerName, "codex");
      }

      const threadIds = yield* directory.listThreadIds();
      assert.deepEqual(threadIds, [nextThreadId]);
    }));

  it("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const threadId = ThreadId.makeUnsafe("thread-runtime");

      yield* directory.upsert({
        provider: "codex",
        threadId,
        status: "starting",
        launchFingerprint: "launch-a",
        resumeCursor: {
          threadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: "codex",
        threadId,
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.launchFingerprint, "launch-a");
        assert.deepEqual(runtime.value.resumeCursor, {
          threadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
      }
    }));

  it("resets adapterKey to the new provider when provider changes without an explicit adapter key", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = ThreadId.makeUnsafe("thread-provider-change");

      yield* runtimeRepository.upsert({
        threadId,
        projectId: null,
        providerName: "cursor",
        adapterKey: "cursor",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: new Date().toISOString(),
        mcpEffectiveConfigVersion: null,
        launchFingerprint: null,
        resumeCursor: null,
        runtimePayload: null,
      });

      yield* directory.upsert({
        provider: "codex",
        threadId,
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerName, "codex");
        assert.equal(runtime.value.adapterKey, "codex");
      }
    }));

  it("conditionally commits MCP state without touching a replacement or unrelated payload", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.makeUnsafe("mcp-fence");
      const instanceId = ProviderInstanceId.make("work");
      yield* directory.upsert({
        threadId,
        provider: "codex",
        providerInstanceId: instanceId,
        mcpEffectiveConfigVersion: "old",
        runtimePayload: { sessionGeneration: 2, cwd: "/keep" },
      });
      const update = {
        threadId,
        instanceId,
        generation: 2,
        effectiveVersion: "v2",
        unconvergedVersion: "v2",
      };
      assert.isFalse(yield* directory.updateMcpStateIfCurrent({ ...update, generation: 1 }));
      assert.isFalse(
        yield* directory.updateMcpStateIfCurrent({
          ...update,
          instanceId: ProviderInstanceId.make("personal"),
        }),
      );
      assert.isTrue(yield* directory.updateMcpStateIfCurrent(update));
      const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
      assert.equal(binding.mcpEffectiveConfigVersion, "v2");
      assert.deepEqual(binding.runtimePayload, {
        sessionGeneration: 2,
        cwd: "/keep",
        mcpUnconvergedConfigVersion: "v2",
      });
      yield* directory.upsert({
        threadId,
        provider: "codex",
        providerInstanceId: instanceId,
        mcpEffectiveConfigVersion: "new-generation",
        runtimePayload: { sessionGeneration: 3 },
      });
      assert.isFalse(yield* directory.updateMcpStateIfCurrent(update));
      assert.equal(
        Option.getOrThrow(yield* directory.getBinding(threadId)).mcpEffectiveConfigVersion,
        "new-generation",
      );
    }));

  it("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-directory-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.makeUnsafe("thread-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: "codex",
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(threadId);
        assert.equal(provider, "codex");

        const resolvedBinding = yield* directory.getBinding(threadId);
        assert.equal(Option.isSome(resolvedBinding), true);
        if (Option.isSome(resolvedBinding)) {
          assert.equal(resolvedBinding.value.threadId, threadId);
          assert.equal(resolvedBinding.value.provider, "codex");
          assert.equal(typeof resolvedBinding.value.lastSeenAt, "string");
        }

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer));

      fs.rmSync(tempDir, { recursive: true, force: true });
    }));

  it.effect("lists only live bindings when asked to exclude stopped rows", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const live = ThreadId.makeUnsafe("thread-live-binding");
      const stopped = ThreadId.makeUnsafe("thread-stopped-binding");
      yield* directory.upsert({ provider: "codex", threadId: live, status: "running" });
      yield* directory.upsert({ provider: "codex", threadId: stopped, status: "stopped" });

      const all = (yield* directory.listBindings()).map((binding) => binding.threadId);
      assert.isTrue(all.includes(live) && all.includes(stopped));
      const liveOnly = (yield* directory.listBindings({ excludeStopped: true })).map(
        (binding) => binding.threadId,
      );
      assert.isTrue(liveOnly.includes(live));
      assert.isFalse(liveOnly.includes(stopped));
    }),
  );
});
