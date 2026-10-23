import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  buildOpenCodePermissionRules,
  buildOpenCodeWorkflowPermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  openCodeRuntimeErrorDetail,
  resolveOpenCodeInvocation,
  loadOpenCodeSkills,
  toOpenCodeFileParts,
} from "./opencodeRuntime.ts";

it("formats an error whose message is not a string", () => {
  const timeout = new Error("placeholder");
  Object.defineProperty(timeout, "message", { value: undefined });
  expect(() => openCodeRuntimeErrorDetail(timeout)).not.toThrow();
  expect(openCodeRuntimeErrorDetail(new Error("  connection reset  "))).toBe("connection reset");
});

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

it("sends only plain text, PDFs and images as native OpenCode file parts", () => {
  const attachment = (mimeType: string, type: "file" | "image" = "file") =>
    ({
      type,
      id: `att-${mimeType.replace("/", "-")}`,
      name: `file.${mimeType.split("/")[1]}`,
      mimeType,
      sizeBytes: 10,
    }) as ChatAttachment;
  const parts = toOpenCodeFileParts({
    attachments: [
      attachment("text/plain"),
      attachment("text/html"),
      attachment("text/markdown"),
      attachment("text/csv"),
      attachment("application/pdf"),
      attachment("application/zip"),
      attachment("image/png", "image"),
    ],
    resolveAttachmentPath: (item) => `/attachments/${item.id}`,
  });
  // HTML, Markdown and CSV reach the model API as raw file parts, which providers reject;
  // they still reach the agent as paths in the attachment context.
  expect(parts.map((part) => part.mime)).toEqual(["text/plain", "application/pdf", "image/png"]);
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

function within<T>(promise: Promise<T>, waitingFor: string, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${waitingFor}`)), ms).unref(),
    ),
  ]);
}

it("aborts an in-flight SDK request when the owning server lifetime ends", async () => {
  const { createServer } = await import("node:http");
  const received = Promise.withResolvers<void>();
  const server = createServer(() => received.resolve());
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const lifetime = new AbortController();
  try {
    const runtime = await Effect.runPromise(
      Effect.service(OpenCodeRuntime).pipe(
        Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provide(NodeServices.layer))),
      ),
    );
    const client = runtime.createOpenCodeSdkClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      directory: "/workspace",
      signal: lifetime.signal,
    });
    const result = client.session.list().then(
      () => "completed",
      () => "aborted",
    );
    // Bounded phases name the step that stalls instead of ending in the test timeout.
    await within(received.promise, "the request to reach the server");
    // A collection mid-request must not drop the abort (a weakly followed signal did, on CI).
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    for (let pass = 0; pass < 3; pass++) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    lifetime.abort(new Error("server exited"));
    expect(await within(result, "the request to abort")).toBe("aborted");
  } finally {
    lifetime.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.skipIf(process.platform === "win32")(
  "reaps an owned server and its descendant after both ignore TERM",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "f5-opencode-process-tree-"));
    const executable = path.join(directory, "opencode-mock");
    const identities = path.join(directory, "pids.json");
    let pids: number[] = [];
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      writeFileSync(
        executable,
        `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.on("message", () => {
  writeFileSync(process.env.F5_MOCK_PID_FILE, JSON.stringify([process.pid, child.pid]));
  console.log("opencode server listening on http://127.0.0.1:54321");
});
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const server = yield* runtime.startOpenCodeServerProcess({
              binaryPath: executable,
              environment: { ...process.env, F5_MOCK_PID_FILE: identities },
            });
            expect(server.url).toBe("http://127.0.0.1:54321");
            pids = JSON.parse(readFileSync(identities, "utf8"));
            expect(pids).toHaveLength(2);
            expect(pids.every(alive)).toBe(true);
          }),
        ).pipe(Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provide(NodeServices.layer)))),
      );
      for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(pids.filter(alive)).toEqual([]);
    } finally {
      // Only fixture-owned identities; a failed assertion must not leak processes.
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
