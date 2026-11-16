import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import { it, assert } from "@effect/vitest";
import { ServerConfig } from "../../config.ts";
import { ObservabilityLive } from "./Observability.ts";

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-observability-fail-open-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("observability failure isolation", (it) => {
  it.effect("keeps server work running when the logs destination cannot be created", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blocked = path.join(config.stateDir, "not-a-directory");
      yield* fs.writeFileString(blocked, "fixture");
      const result = yield* Effect.succeed("server work completed").pipe(
        Effect.withSpan("server.continues"),
        Effect.provide(ObservabilityLive),
        Effect.provideService(ServerConfig, {
          ...config,
          logsDir: blocked,
          observabilityEnabled: true,
        }),
      );
      assert.equal(result, "server work completed");
      assert.equal(yield* fs.readFileString(blocked), "fixture");
    }),
  );
});
