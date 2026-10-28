import { existsSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";

import { writeCliScript } from "../testUtils/cli.ts";
import { awaitProcessExit, awaitStalledCli, stalledCliSource } from "../testUtils/stalledCli.ts";
import { terminateOnRelease } from "./terminateOnRelease.ts";

/** Spawn `script`, wait for the PID it reports, then close the scope it was spawned in. */
const spawnAndRelease = (script: string, pidPath: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.make();
    yield* spawner
      .spawn(ChildProcess.make(process.execPath, [script]))
      .pipe(Effect.tap(terminateOnRelease), Effect.uninterruptible, Scope.provide(scope));
    // The fixture safety net stays in the test scope, so it cannot pre-empt the release.
    const pid = yield* awaitStalledCli(pidPath);
    yield* Scope.close(scope, Exit.void);
    return pid;
  });

describe("terminateOnRelease", () => {
  it.live("lets a helper that honours SIGTERM finish its cleanup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-terminate-graceful-" });
      const pidPath = path.join(dir, "helper.pid");
      const markerPath = path.join(dir, "cleaned-up");
      const script = writeCliScript(
        path.join(dir, "helper"),
        `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(markerPath)}, "");
    process.exit(0);
  }, 200);
});
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`,
      );

      const pid = yield* spawnAndRelease(script, pidPath);

      yield* awaitProcessExit(pid);
      expect(existsSync(markerPath)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.platform === "win32")(
    "kills a descendant that ignores SIGTERM after its wrapper exits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-terminate-wrapper-" });
        const pidPath = path.join(dir, "descendant.pid");
        const descendant = writeCliScript(path.join(dir, "descendant"), stalledCliSource(pidPath));
        // The wrapper exits on SIGTERM; its descendant stays in the same group.
        const wrapper = writeCliScript(
          path.join(dir, "wrapper"),
          `
require("node:child_process").spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
        );

        const pid = yield* spawnAndRelease(wrapper, pidPath);

        yield* awaitProcessExit(pid);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
