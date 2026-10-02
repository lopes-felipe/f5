import * as NodePath from "node:path";
import { runDistributionCommand } from "./distribution/commands";
import { watchLauncher } from "./distribution/activation";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Layer from "effect/Layer";

import { CliConfig, t3Cli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./wsServer";
import { NetService } from "@t3tools/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

watchLauncher();
if (process.env.F5_STANDALONE === "1") {
  process.env.F5_STANDALONE_DIR = NodePath.dirname(process.execPath);
  process.env.PATH = `${NodePath.join(process.env.F5_STANDALONE_DIR, "runtime")}${NodePath.delimiter}${process.env.PATH ?? ""}`;
}
void runDistributionCommand(process.argv.slice(2))
  .then((handled) => {
    if (handled) return;
    Command.run(t3Cli, { version }).pipe(
      Effect.provide(RuntimeLayer),
      NodeRuntime.runMain({
        teardown: (exit, onExit) =>
          Runtime.defaultTeardown(exit, (code) => onExit(process.exitCode === 78 ? 78 : code)),
      }),
    );
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "F5 command failed.");
    process.exitCode = 1;
  });
