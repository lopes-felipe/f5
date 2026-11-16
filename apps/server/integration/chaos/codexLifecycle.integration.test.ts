import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { CodexAppServerManager } from "../../src/codexAppServerManager.ts";
import { ServerConfig } from "../../src/config.ts";
import { makeCodexAdapter } from "../../src/provider/Layers/CodexAdapter.ts";
import {
  makeOrchestrationIntegrationHarness,
  seedOrchestrationProjectAndThread,
} from "../OrchestrationEngineHarness.integration.ts";
import { makeClientTransport } from "./transport.ts";
import { connectStoreClient } from "./client.ts";
import { chaosTimeout } from "./timeouts.ts";

it.live(
  "desktop stdio output converges after interruption and provider source shutdown",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const manager = new CodexAppServerManager(yield* Effect.services<never>());
        const adapter = yield* makeCodexAdapter({
          manager,
          defaultProviderOptions: {
            codex: {
              binaryPath: fileURLToPath(
                new URL("../../../../scripts/fixtures/codex-lifecycle-host.mjs", import.meta.url),
              ),
              homePath: config.stateDir,
            },
          },
        });
        const harness = yield* Effect.acquireRelease(
          makeOrchestrationIntegrationHarness({ adapter }),
          (harness) => harness.dispose,
        );
        yield* seedOrchestrationProjectAndThread(harness);
        const transport = yield* makeClientTransport(harness);
        const client = yield* Effect.acquireRelease(
          Effect.promise(() => connectStoreClient(transport.url)),
          (client) => Effect.promise(() => client.close()),
        );
        yield* Effect.promise(() => client.next("ready"));
        const threadId = ThreadId.makeUnsafe("thread-1");
        for (const end of ["interrupt", "shutdown"] as const) {
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`desktop-${end}`),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(`desktop-user-${end}`),
              role: "user",
              text: "F5_SMOKE_STREAM",
              attachments: [],
            },
            assistantDeliveryMode: "streaming",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          });
          const streaming = yield* harness.waitForThread(threadId, (thread) =>
            thread.messages.some(
              (message) => message.streaming && message.text.includes("Desktop stream"),
            ),
          );
          if (end === "interrupt")
            yield* harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe("desktop-stop"),
              threadId,
              createdAt: new Date().toISOString(),
            });
          else yield* Effect.promise(() => manager.shutdown(Date.now() + 1_800));
          yield* harness.waitForThread(
            threadId,
            (thread) =>
              thread.session?.activeTurnId === null &&
              thread.latestTurn?.state !== "running" &&
              thread.messages.every((message) => !message.streaming),
          );
          const state = yield* harness.engine.getReadModel();
          for (const before of streaming.messages) {
            const after = state.threads[0]!.messages.find((message) => message.id === before.id);
            assert.isTrue(after?.text.startsWith(before.text));
          }
          const expected = state.threads.map((thread) => ({
            id: thread.id,
            messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
          }));
          let observed: Record<string, unknown> | undefined;
          for (let attempt = 0; attempt < 100; attempt++) {
            client.send("inspect");
            observed = yield* Effect.promise(() => client.next("state"));
            if (JSON.stringify(observed.threads) === JSON.stringify(expected)) break;
            yield* Effect.sleep("10 millis");
          }
          assert.deepEqual(observed?.threads, expected);
        }
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "f5-desktop-provider-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  chaosTimeout(30_000),
);
