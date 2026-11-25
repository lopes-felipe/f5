import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";
import { AcpSessionRuntime } from "./AcpSessionRuntime";
import { writeAcpWrapper } from "../../testUtils/cli";

/** The item id of the first assistant segment one runtime's prompt produces. */
const firstAssistantItemId = async (
  options: { readonly resumeSessionId?: string; readonly resumeMethod?: "resume" | "load" } = {},
) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-segments-"));
  const executable = writeAcpWrapper(
    path.join(cwd, "agent"),
    path.resolve("scripts/acp-mock-agent.ts"),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn: { command: executable, args: [], cwd },
            cwd,
            clientInfo: { name: "test", version: "1" },
            authMethodId: "test",
            ...options,
          }),
        );
        const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
        yield* runtime.start();
        const started = yield* runtime.getEvents().pipe(
          Stream.filter((event) => event._tag === "AssistantItemStarted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.prompt({ prompt: [{ type: "text", text: "hello" }] });
        const [event] = yield* Fiber.join(started);
        return event?._tag === "AssistantItemStarted" ? event.itemId : undefined;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
};

describe("ACP assistant segment ids", () => {
  it("never reuses a finished message's id after resuming without replay", async () => {
    const first = await firstAssistantItemId({
      resumeSessionId: "existing",
      resumeMethod: "resume",
    });
    const second = await firstAssistantItemId({
      resumeSessionId: "existing",
      resumeMethod: "resume",
    });
    expect(first).toMatch(/^assistant:existing:r[0-9a-f]{8}:segment:0$/);
    expect(second).toMatch(/^assistant:existing:r[0-9a-f]{8}:segment:0$/);
    expect(second).not.toBe(first);
  }, 20_000);

  it("keeps plain ids for new and loaded sessions", async () => {
    expect(await firstAssistantItemId()).toMatch(/^assistant:[^:]+:segment:0$/);
    expect(await firstAssistantItemId({ resumeSessionId: "existing" })).toBe(
      "assistant:existing:segment:0",
    );
  }, 20_000);
});
