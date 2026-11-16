import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import { AcpSessionRuntime } from "./AcpSessionRuntime";
import type { AcpToolCallState } from "./AcpRuntimeModel";
import { writeAcpWrapper } from "../../testUtils/cli";

it.each([false, true])(
  "preserves tool lifecycle and samples real ACP argument frames (hardening %s)",
  async (enabled) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-argument-progress-"));
    const executable = writeAcpWrapper(
      path.join(cwd, "agent"),
      path.resolve("scripts/acp-mock-agent.ts"),
      { env: { ACP_MOCK_ARGUMENT_STREAM: "1" } },
    );
    const turns = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            AcpSessionRuntime.layer({
              spawn: { command: executable, args: [], cwd },
              cwd,
              clientInfo: { name: "test", version: "1" },
              authMethodId: "test",
              hardening: { enabled, provider: "custom-acp" },
            }),
          );
          const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
          yield* runtime.start();
          const events: AcpToolCallState[] = [];
          yield* runtime.getEvents().pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event._tag === "ToolCallUpdated") events.push(event.toolCall);
              }),
            ),
            Effect.forkScoped,
          );
          const turns: AcpToolCallState[][] = [];
          for (let turn = 0; turn < 2; turn++) {
            yield* runtime.prompt({ prompt: [{ type: "text", text: "Write the fixture" }] });
            yield* runtime.awaitEventBarrier;
            turns.push(events.splice(0));
          }
          return turns;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    for (const events of turns) {
      expect(events).toHaveLength(17);
      expect(events.slice(0, 2).map((event) => event.status)).toEqual(["pending", "inProgress"]);
      expect(
        events
          .slice(2, 14)
          .map((event) => (event.data.rawInput as { content: string }).content.length),
      ).toEqual(Array.from({ length: 12 }, (_, index) => (index + 1) * 10));
      expect(events[14]?.title).toBe("Arguments finished");
      expect(events[15]?.data.rawOutput).toEqual({ output: "visible result" });
      expect(events.at(-1)).toMatchObject({
        status: "completed",
        data: {
          rawInput: { path: "/fixture/file", content: "x".repeat(120) },
          rawOutput: { output: "visible result" },
        },
      });
    }
  },
  20_000,
);
