import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CursorSettings,
  GrokSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { writeAcpWrapper, waitForAgentExit } from "../../testUtils/cli.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

const agent = fileURLToPath(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
for (const provider of ["cursor", "grok", "antigravity"] as const) {
  describe(`${provider} ACP transport lifecycle`, () => {
    it.each(["malformed", "exit"])(
      "settles an active request and publishes one exit after %s",
      async (mode) => {
        const directory = await mkdtemp(path.join(tmpdir(), "f5-acp-lifecycle-"));
        const exitLog = path.join(directory, "exit.log");
        const binaryPath = writeAcpWrapper(path.join(directory, "agent"), agent, {
          env: { T3_ACP_FAIL_PROMPT_TRANSPORT: mode, T3_ACP_EXIT_LOG_PATH: exitLog },
        });
        const layer = ServerConfig.layerTest(process.cwd(), directory, {
          acpHardeningEnabled: true,
        }).pipe(Layer.provideMerge(NodeServices.layer));
        try {
          await Effect.runPromise(
            Effect.gen(function* () {
              const adapter = yield* provider === "cursor"
                ? makeCursorAdapter(Schema.decodeSync(CursorSettings)({ binaryPath }))
                : makeGrokAdapter(Schema.decodeSync(GrokSettings)({ binaryPath }), { provider });
              const events: ProviderRuntimeEvent[] = [];
              const exited = yield* Deferred.make<void>();
              const consumer = yield* adapter.streamEvents.pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    events.push(event);
                    if (event.type === "session.exited") yield* Deferred.succeed(exited, undefined);
                  }),
                ),
                Effect.forkScoped({ startImmediately: true }),
              );
              const threadId = ThreadId.makeUnsafe(`lifecycle-${provider}-${mode}`);
              yield* adapter.startSession({
                threadId,
                provider,
                cwd: process.cwd(),
                runtimeMode: "full-access",
              });
              const result = yield* Effect.exit(
                adapter.sendTurn({ threadId, input: "trigger transport failure", attachments: [] }),
              ).pipe(Effect.timeout("1 second"));
              expect(Exit.isFailure(result)).toBe(true);
              yield* Deferred.await(exited).pipe(Effect.timeout("1 second"));
              expect(yield* adapter.hasSession(threadId)).toBe(false);
              yield* adapter.stopAll();
              yield* adapter.stopAll();
              expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
              expect(
                events.filter((event) => event.type === "session.exited")[0]?.payload,
              ).toMatchObject({ exitKind: "error" });
              expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(1);
              yield* Fiber.interrupt(consumer);
            }).pipe(Effect.provide(layer), Effect.scoped),
          );
          await waitForAgentExit(exitLog);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      15_000,
    );
  });
}
