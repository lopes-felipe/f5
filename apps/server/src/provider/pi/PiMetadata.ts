import type { ServerProviderModel } from "@t3tools/contracts";
import { Effect, FileSystem, Stream } from "effect";
import {
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
  type PiDiscoveredCommands,
} from "./commands.ts";
import { parsePiDiscoveredModels } from "./discovery.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./launch.ts";
import { makePiRpcConnection, PiRpcError, type PiRpcConnection } from "./PiRpc.ts";

export interface PiLaunchSettings {
  readonly binaryPath: string;
  readonly launchArgs: string;
}
export interface PiCatalog extends PiDiscoveredCommands {
  readonly models: readonly ServerProviderModel[];
  readonly state: unknown;
}

/** Called on the live session for its real workspace command catalog. Failures leave the old catalog intact. */
export const readPiCatalog = (connection: PiRpcConnection) =>
  Effect.gen(function* () {
    const state = yield* connection.request({ type: "get_state" });
    const models = parsePiDiscoveredModels(
      yield* connection.request({ type: "get_available_models" }),
      state,
    );
    const commands = parsePiDiscoveredCommands(yield* connection.request({ type: "get_commands" }));
    return {
      state,
      models,
      ...commands,
      slashCommands: withPiBuiltinSlashCommands(commands.slashCommands),
    } satisfies PiCatalog;
  });

/** Background probes run without tools, extensions, persistent history or access to the project directory. */
export const probePiCatalog = (settings: PiLaunchSettings, environment: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parsed = resolvePiLaunchArgs(settings.launchArgs);
      if (!parsed.ok) return yield* new PiRpcError({ operation: "launch", detail: parsed.message });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "f5-pi-probe-" });
      const launch = buildPiRpcLaunch({
        launchArgs: parsed.args,
        environment,
        extensionPath: undefined,
        mcpSession: undefined,
        ephemeral: true,
        disableExtensions: true,
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: settings.binaryPath || "pi",
        args: launch.args,
        cwd,
        env: launch.env,
      });
      yield* connection.events.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      return yield* readPiCatalog(connection);
    }),
  ).pipe(Effect.timeout("15 seconds"));
