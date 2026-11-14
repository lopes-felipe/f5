import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Fiber, Layer, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AcpSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { writeAcpWrapper } from "../../testUtils/cli.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AcpDriver } from "./AcpDriver.ts";
it.each([false, true])(
  "isolates custom instances, preserves Plan through steering and resume, and generates metadata (URL modes: %s)",
  async (urlModes) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-driver-"));
    const log = path.join(cwd, "requests.jsonl");
    try {
      const command = writeAcpWrapper(
        path.join(cwd, "agent"),
        path.resolve("scripts/acp-mock-agent.ts"),
        {
          env: {
            T3_ACP_REQUEST_LOG_PATH: log,
            ACP_MOCK_AUTH_FAIL: "1",
            T3_ACP_PROMPT_RESPONSE_TEXT: '{"ok":true}',
            T3_ACP_URL_MODES: urlModes ? "1" : "0",
            T3_ACP_MODE_PATH: path.join(cwd, "mode"),
            T3_ACP_PROMPT_GATE_PATH: path.join(cwd, "release-prompt"),
          },
        },
      );
      const config = Schema.decodeUnknownSync(AcpSettings)({
        command,
        args: ["--acp"],
        env: { AGENT_HOME: "/instance-a" },
        customModels: ["only-a"],
      });
      const services = Layer.mergeAll(
        ServerConfig.layerTest(cwd, { prefix: "acp-driver-state-" }),
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const aId = ProviderInstanceId.make("acp_a"),
              bId = ProviderInstanceId.make("acp_b");
            const a = yield* AcpDriver.create({
              instanceId: aId,
              displayName: "Agent A",
              enabled: true,
              config,
              environment: [],
            });
            const b = yield* AcpDriver.create({
              instanceId: bId,
              displayName: "Agent B",
              enabled: false,
              config: { ...config, env: { AGENT_HOME: "/instance-b" }, customModels: ["only-b"] },
              environment: [],
            });
            const threadId = ThreadId.makeUnsafe("acp-driver-thread");
            const session = yield* a.adapter.startSession({
              threadId,
              provider: "acp",
              cwd,
              runtimeMode: "approval-required",
              modelSelection: { instanceId: aId, model: "gpt-5.4" },
            });
            expect(session.providerInstanceId).toBe(aId);
            expect(session.model).toBe("gpt-5.4");
            let snapshot = yield* a.snapshot.getSnapshot;
            for (let n = 0; n < 100 && !snapshot.models.some((m) => m.slug === "gpt-5.4"); n++) {
              yield* Effect.sleep("20 millis");
              snapshot = yield* a.snapshot.getSnapshot;
            }
            expect(snapshot.displayName).toBe("Agent A");
            expect(snapshot.models.map((m) => m.slug)).toContain("gpt-5.4");
            expect(snapshot.models.map((m) => m.slug)).toContain("only-a");
            const other = yield* b.snapshot.getSnapshot;
            expect(other.models.map((m) => m.slug)).toEqual(["acp-default", "only-b"]);
            expect(other.status).toBe("disabled");
            expect(yield* b.adapter.hasSession(threadId)).toBe(false);
            const plan = yield* a.adapter
              .sendTurn({
                threadId,
                input: "Plan the change",
                attachments: [],
                interactionMode: "plan",
              })
              .pipe(Effect.forkChild);
            // Wait until the Plan prompt is in flight, then change the composer's
            // requested mode on a steering send. No selector may change mid-turn.
            for (let n = 0; n < 200; n++) {
              const logged = yield* Effect.promise(() => readFile(log, "utf8"));
              if (logged.includes('"method":"session/prompt"')) break;
              yield* Effect.sleep("5 millis");
            }
            const steering = yield* a.adapter
              .sendTurn({
                threadId,
                input: "Refine the plan",
                attachments: [],
                interactionMode: "default",
              })
              .pipe(Effect.forkChild);
            for (let n = 0; n < 200; n++) {
              const logged = yield* Effect.promise(() => readFile(log, "utf8"));
              if (logged.split('"method":"session/prompt"').length >= 3) break;
              yield* Effect.sleep("5 millis");
            }
            const duringPlan = (yield* Effect.promise(() => readFile(log, "utf8")))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            expect(
              duringPlan.filter((r) => r.method === "session/set_mode").map((r) => r.params.modeId),
            ).toEqual([
              urlModes
                ? "https://agentclientprotocol.com/protocol/session-modes#architect"
                : "architect",
            ]);
            expect(duringPlan.filter((r) => r.method === "session/prompt")).toHaveLength(2);
            yield* Effect.promise(() => writeFile(path.join(cwd, "release-prompt"), ""));
            yield* Fiber.join(plan);
            yield* Fiber.join(steering);
            // Reload the same native session through a new ACP runtime/process.
            yield* a.adapter.startSession({
              threadId,
              provider: "acp",
              cwd,
              runtimeMode: "approval-required",
              modelSelection: { instanceId: aId, model: "gpt-5.4" },
              resumeCursor: session.resumeCursor,
            });
            yield* a.adapter.sendTurn({
              threadId,
              input: "Implement the change",
              attachments: [],
              interactionMode: "default",
            });
            const metadata = yield* a.textGeneration.generateStructuredJson({
              cwd,
              operation: "fixture",
              prompt: "Return JSON",
              outputSchema: Schema.Struct({ ok: Schema.Boolean }),
            });
            expect(metadata).toEqual({ ok: true });
            yield* a.adapter.stopSession(threadId);
          }),
        ).pipe(Effect.provide(services)),
      );
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.some((r) => r.method === "authenticate")).toBe(false);
      expect(requests.filter((r) => r.method === "initialize")).toHaveLength(4);
      expect(
        requests.filter((r) => r.method === "session/set_mode").map((r) => r.params.modeId),
      ).toEqual(
        ["architect", "ask"].map((id) =>
          urlModes ? "https://agentclientprotocol.com/protocol/session-modes#" + id : id,
        ),
      );
      expect(
        requests
          .filter((r) => r.method === "session/set_config_option" && r.params?.configId === "mode")
          .map((r) => r.params.value),
      ).toEqual(urlModes ? [] : ["architect", "ask"]);
      expect(
        requests.some(
          (r) => r.params?.modelId === "acp-default" || r.params?.value === "acp-default",
        ),
      ).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
