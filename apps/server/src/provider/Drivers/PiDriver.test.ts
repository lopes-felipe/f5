import { tmpdir } from "node:os";
import { PiSettings, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { PreviewMcpHttpServer } from "../../mcp/PreviewMcpHttpServer.ts";
import { fixture, threadId } from "../pi/PiAdapter.testkit.ts";
import { PiDriver } from "./PiDriver.ts";

it("publishes an explicit Pi instance's workspace catalog and scopes F5 thread credentials to its owned child", async () =>
  fixture(async ({ settings, options, trace }) => {
    const configs: Array<{ threadId: ThreadId; catalog?: string }> = [];
    let disposed = 0;
    const services = Layer.mergeAll(
      ServerConfig.layerTest(tmpdir(), { prefix: "pi-driver-state-" }),
      Layer.succeed(PreviewMcpHttpServer, {
        supportsThreadCatalog: true,
        getUrl: () => "http://127.0.0.1:12345/mcp/thread",
        createSessionConfig: (input) => {
          configs.push(input);
          return {
            serverName: "f5_thread",
            serverDefinition: {
              type: "http",
              url: "http://127.0.0.1:12345/mcp/thread",
              bearerTokenEnvVar: "OWNED_TOKEN",
            },
            env: { OWNED_TOKEN: "PRIVATE_PI_BEARER" },
            dispose: () => {
              disposed++;
            },
          };
        },
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instanceId = options.instanceId;
          const a = yield* PiDriver.create({
            instanceId,
            displayName: "Pi work",
            enabled: true,
            config: settings,
            environment: Object.entries(options.environment).flatMap(([name, value]) =>
              value === undefined ? [] : [{ name, value, sensitive: false }],
            ),
          });
          const b = yield* PiDriver.create({
            instanceId: ProviderInstanceId.make("pi-disabled"),
            displayName: undefined,
            enabled: false,
            config: { ...settings, customModels: ["different/custom"] },
            environment: [],
          });
          expect((yield* b.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
            "default",
            "different/custom",
          ]);
          expect((yield* b.snapshot.getSnapshot).status).toBe("disabled");
          const session = yield* a.adapter.startSession({
            threadId,
            cwd: tmpdir(),
            runtimeMode: "approval-required",
          });
          expect(session.providerInstanceId).toBe(instanceId);
          const snapshot = yield* a.snapshot.getSnapshot;
          expect(snapshot.driver).toBe("pi");
          expect(snapshot.displayName).toBe("Pi work");
          expect(snapshot.models.map((model) => model.slug)).toContain("one/shared");
          expect(snapshot.slashCommands?.some((command) => command.name === "reload")).toBe(true);
          expect(snapshot.auth.status).toBe("unknown");
          expect(configs).toMatchObject([
            { threadId, providerInstanceId: instanceId, catalog: "thread" },
          ]);
          yield* a.adapter.stopSession(threadId);
          expect(disposed).toBe(1);
          expect(yield* b.adapter.hasSession(threadId)).toBe(false);
        }),
      ).pipe(Effect.provide(services)),
    );
    const records = await trace();
    expect(JSON.stringify(records)).not.toContain("PRIVATE_PI_BEARER");
    const processes = records.filter((record) => record.type === "spawn");
    expect(processes.some((record) => record.hasMcp === true)).toBe(true);
    expect(processes.filter((record) => record.hasMcp === true)).toHaveLength(1);
    for (const record of processes) expect(() => process.kill(Number(record.pid), 0)).toThrow();
  }));

it("uses the same typed defaults as saved Pi instance configurations", () => {
  expect(PiDriver.defaultConfig()).toEqual(Schema.decodeSync(PiSettings)({}));
});
