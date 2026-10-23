import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AcpSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { writeAcpWrapper } from "../../testUtils/cli.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AcpDriver } from "./AcpDriver.ts";
it("isolates custom instances, publishes the session's models without a new probe and generates typed metadata", async () => {
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
    expect(requests.filter((r) => r.method === "initialize")).toHaveLength(3);
    expect(
      requests.some(
        (r) => r.params?.modelId === "acp-default" || r.params?.value === "acp-default",
      ),
    ).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 15000);
