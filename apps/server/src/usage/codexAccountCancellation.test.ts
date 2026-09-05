import * as Semaphore from "effect/Semaphore";
import { makeAccountUsageCapability, emptyAccountSection } from "./Layers/AccountUsageService.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { it, expect } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Fiber, Scope, Exit } from "effect";
import { TestClock } from "effect/testing";
import { probeCodexAccountSections } from "./codexAccountUsage.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../codexAppServerManager.ts", () => ({
  assertSupportedCodexCliVersion: () => {},
  buildCodexInitializeParams: () => ({}),
  killChildTree: (child: ChildProcessWithoutNullStreams) => child.kill(),
}));
vi.mock("../spawn/resolveCommand.ts", () => ({
  resolveInvocation: () => ({ command: "codex", args: [] }),
}));

function processHarness(phase: "initialize" | "usage", tokensSucceed = false) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
  });
  const outstanding = new Set<unknown>();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  child.kill = vi.fn(() => {
    child.killed = true;
    outstanding.clear();
    child.stdout.end();
    child.emit("exit", 0, null);
    return true;
  });
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.id === undefined) continue;
      const isUsage = message.method.startsWith("account/");
      if ((phase === "initialize" && message.method === "initialize") || isUsage) {
        if (tokensSucceed && message.method === "account/usage/read") {
          child.stdout.write(
            JSON.stringify({ id: message.id, result: { summary: {}, dailyUsageBuckets: [] } }) +
              "\n",
          );
        } else outstanding.add(message.id);
        if (phase === "initialize" || message.method === "account/rateLimits/read") ready();
      } else child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    }
  });
  mocks.spawn.mockReturnValue(child);
  return { child, started, outstanding };
}

for (const phase of ["initialize", "usage"] as const) {
  it.effect(`interrupting ${phase} closes the real control client and its pending RPCs`, () =>
    Effect.gen(function* () {
      const harness = processHarness(phase);
      const fiber = yield* probeCodexAccountSections({ cwd: process.cwd() }).pipe(Effect.forkChild);
      yield* Effect.promise(() => harness.started);
      expect(harness.outstanding.size).toBeGreaterThan(0);
      yield* Fiber.interrupt(fiber);
      expect(harness.child.kill).toHaveBeenCalledOnce();
      expect(harness.outstanding.size).toBe(0);
    }),
  );
}

it.effect(
  "the eight-second deadline closes pending RPCs while preserving the successful section",
  () =>
    Effect.gen(function* () {
      const harness = processHarness("usage", true);
      const fiber = yield* probeCodexAccountSections({ cwd: process.cwd() }).pipe(Effect.forkChild);
      yield* Effect.promise(() => harness.started);
      yield* TestClock.adjust("8 seconds");
      const sections = yield* Fiber.join(fiber);
      expect(sections[0]).toMatchObject({ outcome: "available" });
      expect(sections[1]).toMatchObject({ outcome: "unavailable", errorCode: "timeout" });
      expect(harness.child.kill).toHaveBeenCalledOnce();
      expect(harness.outstanding.size).toBe(0);
    }),
);

it.effect(
  "configuration scope retirement stops actual RPC work before releasing the shared permit",
  () =>
    Effect.gen(function* () {
      const harness = processHarness("usage");
      const scope = yield* Scope.make();
      const permits = yield* Semaphore.make(1);
      const capability = yield* makeAccountUsageCapability(
        {
          key: "codex:default",
          provider: "codex",
          providerInstanceId: null,
          displayName: "Codex",
          enabled: true,
          refreshState: "idle",
          sections: [emptyAccountSection("codex-tokens"), emptyAccountSection("codex-limits")],
        },
        probeCodexAccountSections({ cwd: process.cwd() }),
        { readerOwnsTimeout: true },
      ).pipe(Effect.provideService(Scope.Scope, scope));
      yield* capability.refresh("force", permits);
      yield* Effect.promise(() => harness.started);
      yield* Scope.close(scope, Exit.void);
      yield* permits.withPermits(1)(
        Effect.sync(() => {
          expect(harness.child.kill).toHaveBeenCalledOnce();
          expect(harness.outstanding.size).toBe(0);
        }),
      );
      expect((yield* capability.getSnapshot).refreshState).toBe("idle");
      expect(
        (yield* capability.getSnapshot).sections.every((section) => section.snapshot === null),
      ).toBe(true);
    }),
);

it.effect("the startup deadline aborts initialization rather than leaving a pending client", () =>
  Effect.gen(function* () {
    const harness = processHarness("initialize");
    const fiber = yield* probeCodexAccountSections({ cwd: process.cwd() }).pipe(
      Effect.result,
      Effect.forkChild,
    );
    yield* Effect.promise(() => harness.started);
    yield* TestClock.adjust("8 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TimeoutError" },
    });
    expect(harness.child.kill).toHaveBeenCalledOnce();
    expect(harness.outstanding.size).toBe(0);
  }),
);
