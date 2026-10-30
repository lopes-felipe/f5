import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  MuseSettings,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../src/config.ts";
import { ProviderAdapterProcessError } from "../../src/provider/Errors.ts";
import { makeMuseAdapter } from "../../src/provider/Layers/MuseAdapter.ts";
import { makeMspTransport, type MspTransportHandle } from "../../src/provider/msp/MspTransport.ts";
import { openMspHost } from "../../src/provider/msp/MspSessionRuntime.ts";
import {
  makeOrchestrationIntegrationHarness,
  seedOrchestrationProjectAndThread,
} from "../OrchestrationEngineHarness.integration.ts";
import { makeClientTransport } from "./transport.ts";
import { connectStoreClient } from "./client.ts";
import { chaosTimeout } from "./timeouts.ts";

for (const completedItem of [false, true])
  it.live(
    `killing a real MSP host with ${completedItem ? "a completed item" : "streaming output"} ends the turn and converges the real client store`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const handles: MspTransportHandle[] = [];
          const adapter = yield* makeMuseAdapter(Schema.decodeSync(MuseSettings)({}), {
            instanceId: ProviderInstanceId.make("muse"),
            openHost: () =>
              Effect.gen(function* () {
                const transport = yield* makeMspTransport({
                  binaryPath: "bun",
                  args: [fileURLToPath(new URL("../../scripts/msp-mock-host.ts", import.meta.url))],
                  cwd: process.cwd(),
                  environment: {
                    ...process.env,
                    MSP_MOCK_STREAM_TURN: "1",
                    MSP_MOCK_COMPLETE_ITEM: completedItem ? "1" : "0",
                  },
                }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
                handles.push(transport);
                const host = yield* Effect.promise(() =>
                  openMspHost({ transport: transport.transport, clientVersion: "test" }),
                );
                yield* Effect.addFinalizer(() =>
                  Effect.promise(() => host.close().catch(() => {})),
                );
                return { host, stderrTail: transport.stderrTail };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: "muse",
                      threadId: "",
                      detail: "Cannot open test MSP host",
                      cause,
                    }),
                ),
              ),
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
          yield* harness.engine.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.makeUnsafe("msp-crash-mode"),
            createdAt: new Date().toISOString(),
            threadId,
            runtimeMode: "auto-accept-edits",
          });
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("msp-crash-turn"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe("msp-crash-user"),
              role: "user",
              text: "work",
              attachments: [],
            },
            modelSelection: {
              instanceId: ProviderInstanceId.make("muse"),
              model: "muse-spark-1.3",
              options: [],
            },
            assistantDeliveryMode: "streaming",
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          });
          yield* harness
            .waitForThread(threadId, (thread) =>
              thread.messages.some(
                (message) =>
                  message.text === "Muse prefix " && (!completedItem || !message.streaming),
              ),
            )
            .pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const state = (yield* harness.engine.getReadModel()).threads[0];
                  yield* Effect.logError("MSP prefix did not arrive", {
                    state,
                    stderr: handles.map((host) => host.stderrTail()),
                  });
                }),
              ),
            );
          assert.equal(handles.length, 1);
          const host = handles[0]!;
          process.kill(host.pid, "SIGKILL");
          yield* Effect.promise(() => host.exited);
          const stopped = yield* harness
            .waitForThread(
              threadId,
              (thread) =>
                thread.latestTurn?.state === "error" &&
                // turn.completed precedes session.exited. Wait for both before
                // capturing the state the client must converge to.
                thread.session?.status === "stopped" &&
                thread.session?.activeTurnId === null &&
                thread.messages.every((message) => !message.streaming),
            )
            .pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const state = (yield* harness.engine.getReadModel()).threads[0];
                  yield* Effect.logError("MSP turn did not settle", { state });
                }),
              ),
            );
          assert.notEqual(stopped.session?.status, "running");
          assert.isFalse(yield* adapter.hasSession(threadId));
          const expected = (yield* harness.engine.getReadModel()).threads.map((thread) => ({
            id: thread.id,
            messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
          }));
          const expectedLifecycle = [
            {
              id: threadId,
              status: stopped.session?.status,
              activeTurnId: null,
              turnState: "error",
            },
          ];
          let observed: Record<string, unknown> | undefined;
          for (let attempt = 0; attempt < 100; attempt++) {
            client.send("inspect");
            observed = yield* Effect.promise(() => client.next("state"));
            if (
              JSON.stringify(observed.threads) === JSON.stringify(expected) &&
              JSON.stringify(observed.lifecycle) === JSON.stringify(expectedLifecycle)
            )
              break;
            yield* Effect.sleep("10 millis");
          }
          assert.deepEqual(observed?.threads, expected);
          assert.deepEqual(observed?.lifecycle, expectedLifecycle);
          yield* adapter.stopAll();
          let alive = false;
          try {
            process.kill(host.pid, 0);
            alive = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          assert.isFalse(alive);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "f5-chaos-muse-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    chaosTimeout(30_000),
  );
