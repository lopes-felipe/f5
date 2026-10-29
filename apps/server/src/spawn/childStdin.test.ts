import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";

// Larger than any pipe buffer, so the write is still pending when the child exits.
const payload = new Uint8Array(8 * 1024 * 1024).fill(97);

describe("child stdin", () => {
  it.live("reports the exit code of a child that exits before reading its stdin", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", "process.exit(3)"], {
          stdin: Stream.make(payload),
        }),
      );
      expect(Number(yield* child.exitCode)).toBe(3);
      // The pending write fails with EPIPE after the exit; give it time to surface.
      yield* Effect.sleep("200 millis");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
