import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { PtyAdapter } from "../Services/PTY";
import { isPtyShellNotFoundError } from "../resolvePtyShell.ts";
import { ensureNodePtySpawnHelperExecutable, NodePtyAdapterLive } from "./NodePTY";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(NodeServices.layer))));

describe("ensureNodePtySpawnHelperExecutable", () => {
  it.skipIf(process.platform === "win32")(
    "adds executable bits when helper exists but is not executable",
    async () => {
      await runNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
          const helperPath = path.join(dir, "spawn-helper");
          yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
          yield* fs.chmod(helperPath, 0o644);

          yield* ensureNodePtySpawnHelperExecutable(helperPath);

          const mode = (yield* fs.stat(helperPath)).mode & 0o777;
          expect(mode & 0o111).toBe(0o111);
        }),
      );
    },
  );

  it.skipIf(process.platform === "win32")("keeps executable helper as executable", async () => {
    await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
        const helperPath = path.join(dir, "spawn-helper");
        yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(helperPath, 0o755);

        yield* ensureNodePtySpawnHelperExecutable(helperPath);

        const mode = (yield* fs.stat(helperPath)).mode & 0o777;
        expect(mode & 0o111).toBe(0o111);
      }),
    );
  });
});

it("recognizes node-pty's message-only missing-shell error", () => {
  expect(isPtyShellNotFoundError(new Error("File not found: C:\\missing\\pwsh.exe"))).toBe(true);
  expect(isPtyShellNotFoundError(new Error("CreateProcess failed"))).toBe(false);
});

it("classifies a missing shell before calling the native node-pty backend", async () => {
  const result = await runNode(
    Effect.gen(function* () {
      const adapter = yield* PtyAdapter;
      return yield* adapter
        .spawn({
          shell: "/definitely/missing/f5-shell",
          cwd: process.cwd(),
          cols: 100,
          rows: 30,
          env: { PATH: "" },
        })
        .pipe(Effect.result);
    }).pipe(Effect.provide(NodePtyAdapterLive)),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.reason).toBe("notFound");
});

it.skipIf(process.platform !== "win32")(
  "supports real NodePTY terminal I/O, resize, and cleanup on Windows",
  async () => {
    const output = await runNode(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        const terminal = yield* adapter.spawn({
          shell: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/q"],
          cwd: process.cwd(),
          cols: 100,
          rows: 30,
          env: process.env,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              terminal.kill();
            } catch {
              // The short-lived smoke command normally exits first.
            }
          }),
        );
        return yield* Effect.callback<string>((resume) => {
          let text = "";
          const unsubscribeData = terminal.onData((chunk) => {
            text += chunk;
          });
          const unsubscribeExit = terminal.onExit(() => {
            unsubscribeData();
            unsubscribeExit();
            resume(Effect.succeed(text));
          });
          terminal.resize(120, 40);
          terminal.write("echo F5_NODE_PTY_SMOKE\r\nexit\r\n");
        }).pipe(Effect.timeout("5 seconds"));
      }).pipe(Effect.provide(NodePtyAdapterLive)),
    );
    expect(output).toMatch(/F5_NODE_PTY_SMOKE/);
  },
);
