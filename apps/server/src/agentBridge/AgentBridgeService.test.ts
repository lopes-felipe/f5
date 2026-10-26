import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { Deferred, Effect, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeAgentBridgeService } from "./AgentBridgeService.ts";
import { makeAgentBridgeStore } from "./AgentBridgeStore.ts";
import { makeBotTaskStore } from "./BotTaskStore.ts";
import { agentBridgeLocalCredentialsPath } from "./localCredentials.ts";
import { FakeAgentBridgeHost } from "./testing/fakeHost.ts";

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

layer("local Agent Bridge activation", (it) => {
  it.effect("requires fresh activation for previously saved enablement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-shelved-bridge-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => fs.rmSync(stateDir, { recursive: true, force: true })),
        );
        const sql = yield* SqlClient.SqlClient;
        const host = new FakeAgentBridgeHost();
        const savedSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          agentBridge: {
            ...DEFAULT_SERVER_SETTINGS.agentBridge,
            enabled: true,
            exposedProjectIds: [ProjectId.makeUnsafe("shared-project")],
          },
        };
        host.settings = savedSettings;
        const changeGate = yield* Deferred.make<void>();
        const applied = yield* Deferred.make<void>();
        const service = yield* makeAgentBridgeService({
          host: host.shape,
          store: makeAgentBridgeStore(sql),
          tasks: makeBotTaskStore(sql),
          settingsChanges: Stream.fromEffect(Deferred.await(changeGate)).pipe(
            Stream.flatMap(() =>
              Stream.make(
                {
                  ...savedSettings,
                  agentBridge: { ...savedSettings.agentBridge, enabled: false },
                },
                savedSettings,
              ),
            ),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(applied, undefined)).pipe(Stream.drain),
            ),
          ),
          stateDir,
          serverVersion: "test",
          stdio: { desktop: null, cli: { command: "t3", args: [], env: {} } },
          publish: () => Effect.void,
        });

        const initial = yield* service.getState;
        assert.strictEqual(initial.enabled, false);
        assert.deepStrictEqual(initial.local, { status: "stopped", port: null, detail: null });
        assert.strictEqual(fs.existsSync(agentBridgeLocalCredentialsPath(stateDir)), false);

        yield* Deferred.succeed(changeGate, undefined);
        yield* Deferred.await(applied);
        const updated = yield* service.getState;
        assert.strictEqual(updated.enabled, false);
        assert.deepStrictEqual(updated.local, { status: "stopped", port: null, detail: null });
        assert.strictEqual(fs.existsSync(agentBridgeLocalCredentialsPath(stateDir)), false);
        assert.deepStrictEqual(host.settings, savedSettings);
        assert.deepStrictEqual(
          updated.clients[0]?.projectIds,
          savedSettings.agentBridge.exposedProjectIds,
        );
      }),
    ),
  );
});
