import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Schema, ServiceMap, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import type { GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

class GrokAdapter extends ServiceMap.Service<GrokAdapter, GrokAdapterShape>()(
  "t3/provider/Layers/GrokAdapter.test/GrokAdapter",
) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const GrokAdapterHardeningTestLayer = Layer.effect(
  GrokAdapter,
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-")));
    const wrapperPath = path.join(dir, "fake-grok.sh");
    yield* Effect.promise(async () => {
      await writeFile(
        wrapperPath,
        `#!/bin/sh\nexport T3_ACP_PROMPT_DELAY_MS=80\nexport T3_ACP_LOAD_FAIL_NOT_FOUND=1\nexec bun ${JSON.stringify(mockAgentPath)} "$@"\n`,
        "utf8",
      );
      await chmod(wrapperPath, 0o755);
    });
    const settings = Schema.decodeSync(GrokSettings)({ binaryPath: wrapperPath });
    return yield* makeGrokAdapter(settings);
  }),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(
      process.cwd(),
      { prefix: "t3code-grok-adapter-hardening-test-" },
      { acpHardeningEnabled: true },
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GrokAdapterHardeningTestLayer)("GrokAdapterLive ACP hardening", (it) => {
  it.effect("threads resume cursors through the hardened load fallback", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-resume-hardening");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "missing-session" },
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps overlapping prompts steered into one active turn", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const threadId = ThreadId.make("grok-overlapping-steering-hardening");
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkScoped);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const first = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      const second = yield* adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.forkChild);
      const [firstResult, secondResult] = yield* Effect.all(
        [Fiber.join(first), Fiber.join(second)],
        {
          concurrency: "unbounded",
        },
      );
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));

      assert.equal(firstResult.turnId, secondResult.turnId);
      const turnStarted = events.filter((event) => event.type === "turn.started");
      const turnCompleted = events.filter((event) => event.type === "turn.completed");
      assert.equal(turnStarted.length, 1);
      assert.equal(turnCompleted.length, 1);
      assert.equal(turnCompleted[0]?.turnId, firstResult.turnId);

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);
    }),
  );
});
