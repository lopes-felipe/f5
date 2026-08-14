import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  resolveOpenCodeInvocation,
} from "./opencodeRuntime.ts";

describe("buildOpenCodePermissionRules", () => {
  it("allows edits but keeps shell and network gated in auto-accept-edits mode", () => {
    const rules = buildOpenCodePermissionRules("auto-accept-edits");

    expect(rules).toContainEqual({ permission: "edit", pattern: "*", action: "allow" });
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
    expect(rules).toContainEqual({ permission: "webfetch", pattern: "*", action: "ask" });
  });

  it("fails closed for unsupported AI review mode", () => {
    expect(() => buildOpenCodePermissionRules("auto")).toThrow(
      "OpenCode does not support AI-reviewed approvals",
    );
  });
});

describe("resolveOpenCodeInvocation", () => {
  it("routes OpenCode commands through the shared invocation resolver", () => {
    expect(resolveOpenCodeInvocation("opencode", ["serve", "--port=0"], process.env)).toEqual({
      file: "opencode",
      args: ["serve", "--port=0"],
      kind: "native",
    });
  });

  it.skipIf(process.platform !== "win32")(
    "routes the real runtime spawn path through npm-shim resolution on Windows",
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "f5 opencode runtime & "));
      const script = path.join(directory, "node_modules", "opencode", "cli.js");
      const shim = path.join(directory, "opencode.cmd");
      mkdirSync(path.dirname(script), { recursive: true });
      writeFileSync(script, "process.exit(0)\n");
      writeFileSync(
        shim,
        [
          "@ECHO off",
          'IF EXIST "%~dp0\\node.exe" (',
          '  "%~dp0\\node.exe" "%~dp0\\node_modules\\opencode\\cli.js" %*',
          ") ELSE (",
          '  node "%~dp0\\node_modules\\opencode\\cli.js" %*',
          ")",
        ].join("\r\n"),
      );

      let observedCommand: unknown;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          observedCommand = command;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }),
      );
      const runtimeLayer = OpenCodeRuntimeLive.pipe(Layer.provide(spawnerLayer));
      const environment = {
        ...process.env,
        PATH: `${directory};${process.env.PATH ?? ""}`,
        PATHEXT: ".CMD;.EXE",
      };

      await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          yield* runtime.runOpenCodeCommand({
            binaryPath: "opencode",
            args: ["--version", "value & literal"],
            environment,
          });
        }).pipe(Effect.provide(runtimeLayer)),
      );

      const command = observedCommand as { command?: string; args?: ReadonlyArray<string> };
      expect(command.command?.toLowerCase()).toMatch(/node\.exe$/);
      expect(command.args).toEqual([script, "--version", "value & literal"]);
    },
  );
});
