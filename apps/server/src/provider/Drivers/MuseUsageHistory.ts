import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { MuseSettings } from "@t3tools/contracts";
import { MUSE_SERVE_ARGS } from "@t3tools/shared/museProtocolManifest";
import { version } from "../../../package.json" with { type: "json" };
import { expandHomePath } from "../../pathExpansion.ts";
import { makeNativeHistoryCapability } from "../../usage/nativeHistory.ts";
import { MuseHistoryReader } from "../../usage/museHistory.ts";
import { makeMspTransport } from "../msp/MspTransport.ts";
import { openMspHost } from "../msp/MspSessionRuntime.ts";
import { realpath } from "node:fs/promises";

// Runtime-scoped weak ownership; aliases sharing a canonical home share one reader and in-flight scan.
const readersByRuntime = new WeakMap<object, Map<string, MuseHistoryReader>>();
function readerFor(runtime: object, home: string) {
  let readers = readersByRuntime.get(runtime);
  if (!readers) {
    readers = new Map();
    readersByRuntime.set(runtime, readers);
  }
  let reader = readers.get(home);
  if (!reader) reader = new MuseHistoryReader(home);
  readers.delete(home);
  readers.set(home, reader);
  if (readers.size > 32) readers.delete(readers.keys().next().value!);
  return reader;
}

export const makeMuseUsageHistory = (
  config: MuseSettings,
  environment: NodeJS.ProcessEnv,
  enabled: boolean,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const discover = Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeMspTransport({
          binaryPath: expandHomePath(config.binaryPath || "muse"),
          args: [...MUSE_SERVE_ARGS, "--disable-shell", "--disable-write", "--no-session-log"],
          cwd: process.cwd(),
          environment: { ...environment, MUSE_NO_AUTO_UPDATE: "1" },
        });
        const host = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            openMspHost({ transport: transport.transport, clientVersion: version }),
          ).pipe(Effect.interruptible),
          (host) => Effect.promise(() => host.close().catch(() => undefined)),
        );
        return yield* Effect.tryPromise(() => realpath(host.initializeResult.museHome));
      }),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    return yield* makeNativeHistoryCapability({
      enabled,
      discover,
      scan: (home) => Effect.tryPromise((signal) => readerFor(spawner, home).read(signal)),
    });
  });
