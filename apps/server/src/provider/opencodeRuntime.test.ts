import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  buildOpenCodePermissionRules,
  buildOpenCodeWorkflowPermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  resolveOpenCodeInvocation,
  loadOpenCodeSkills,
} from "./opencodeRuntime.ts";

it("bounds a stuck CLI probe and closes its process scope", async () => {
  const started = Date.now();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      return yield* runtime
        .runOpenCodeCommand({
          binaryPath: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          timeoutMs: 100,
        })
        .pipe(Effect.result);
    }).pipe(Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provide(NodeServices.layer)))),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.detail).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(5000);
});

it("reads workspace skills over the SDK without the CLI's pipe-size truncation", async () => {
  const inventory = Array.from({ length: 100 }, (_, index) => ({
    name: `skill-${index}`,
    description: `Description ${index}`,
    location: `/workspace/.opencode/skills/skill-${index}/SKILL.md`,
    content: "x".repeat(1024),
  }));
  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    directory: "/workspace",
    throwOnError: true,
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const request = input instanceof Request ? input : new Request(String(input));
        expect(new URL(request.url).pathname).toBe("/skill");
        expect(new URL(request.url).searchParams.get("directory")).toBe("/workspace");
        return Response.json(inventory);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const skills = await Effect.runPromise(loadOpenCodeSkills(client));
  expect(skills).toHaveLength(100);
  expect(skills.at(-1)).toEqual({
    name: "skill-99",
    description: "Description 99",
    path: "/workspace/.opencode/skills/skill-99/SKILL.md",
    enabled: true,
  });
  expect(skills[0]).not.toHaveProperty("content");
});

describe("buildOpenCodePermissionRules", () => {
  it("allows edits but keeps shell and network gated in auto-accept-edits mode", () => {
    const rules = buildOpenCodePermissionRules("auto-accept-edits");

    expect(rules).toContainEqual({ permission: "edit", pattern: "*", action: "allow" });
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
    expect(rules).toContainEqual({ permission: "webfetch", pattern: "*", action: "ask" });
  });

  it.each(["approval-required", "auto-accept-edits"] as const)(
    "does not block local task bookkeeping in %s",
    (mode) => {
      const rules = buildOpenCodePermissionRules(mode);
      expect(rules).toContainEqual({ permission: "todowrite", pattern: "*", action: "allow" });
      expect(rules).toContainEqual({ permission: "todoread", pattern: "*", action: "allow" });
      expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "ask" });
    },
  );

  it("fails closed for unsupported AI review mode", () => {
    expect(() => buildOpenCodePermissionRules("auto")).toThrow(
      "OpenCode does not support AI-reviewed approvals",
    );
  });

  it("allows only inspection and attended questions in workflow profiles", () => {
    const attended = buildOpenCodeWorkflowPermissionRules("attended-readonly");
    expect(attended).toContainEqual({ permission: "read", pattern: "*", action: "allow" });
    expect(attended).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(attended).toContainEqual({ permission: "question", pattern: "*", action: "allow" });
    expect(attended).not.toContainEqual({
      permission: "webfetch",
      pattern: "*",
      action: "allow",
    });
    expect(attended).not.toContainEqual({
      permission: "codesearch",
      pattern: "*",
      action: "allow",
    });
    expect(buildOpenCodeWorkflowPermissionRules("unattended-readonly")).toContainEqual({
      permission: "question",
      pattern: "*",
      action: "deny",
    });
  });
});

describe("resolveOpenCodeInvocation", () => {
  it("routes OpenCode commands through the shared invocation resolver", () => {
    expect(resolveOpenCodeInvocation(process.execPath, ["serve", "--port=0"], process.env)).toEqual(
      {
        file: process.execPath,
        args: ["serve", "--port=0"],
        kind: "native",
      },
    );
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
