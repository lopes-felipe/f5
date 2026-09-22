import * as Semaphore from "effect/Semaphore";
import { makeAccountUsageCapability, emptyAccountSection } from "./Layers/AccountUsageService.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { it, expect } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Fiber, Scope, Exit } from "effect";
import { TestClock } from "effect/testing";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeCodexAccountUsage, probeCodexAccountSections } from "./codexAccountUsage.ts";

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
  resolveInvocation: (command: string, args: string[]) => ({ command, args }),
}));

function processHarness(
  phase: "initialize" | "usage" | "success",
  tokensSucceed = false,
  tokens = "0",
) {
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
        if ((tokensSucceed || phase === "success") && message.method === "account/usage/read") {
          child.stdout.write(
            JSON.stringify({
              id: message.id,
              result: { summary: { lifetimeTokens: tokens }, dailyUsageBuckets: [] },
            }) + "\n",
          );
        } else if (phase === "success") {
          child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
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

it.effect("instance usage keeps managed homes, credentials and cached totals separate", () =>
  Effect.gen(function* () {
    mocks.spawn.mockClear();
    const permits = yield* Semaphore.make(2);
    const capabilities = [];
    for (const [name, tokens] of [
      ["work", "111"],
      ["personal", "222"],
    ] as const) {
      const homePath = process.cwd() + "/provider-homes/" + name;
      const harness = processHarness("success", true, tokens);
      const capability = yield* makeCodexAccountUsage(
        { instanceId: ProviderInstanceId.make(name), displayName: name, enabled: true },
        {
          cwd: process.cwd(),
          homePath,
          processEnvironment: { F5_PROFILE_ISOLATED: "1", CODEX_HOME: homePath },
        },
      );
      capabilities.push(capability);
      yield* capability.refresh("force", permits);
      yield* Effect.promise(() => harness.started);
      for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
      expect(yield* capability.getSnapshot).toMatchObject({
        key: `codex:${name}`,
        providerInstanceId: name,
        displayName: name,
        sections: [
          {
            kind: "codex-tokens",
            snapshot: { data: { tokenSummary: { lifetimeTokens: tokens } } },
          },
          { kind: "codex-limits" },
        ],
      });
      const spawn = mocks.spawn.mock.lastCall!;
      expect(spawn[2].env.CODEX_HOME).toBe(homePath);
      expect(spawn[2].env.F5_PROFILE_ISOLATED).toBe("1");
      expect(spawn[1].join(" ")).toContain('cli_auth_credentials_store="file"');
      expect(harness.child.kill).toHaveBeenCalledOnce();
    }
    for (const capability of capabilities) yield* capability.refresh("if-stale", permits);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);

it.effect("a failed managed usage probe never retries with the ambient account", () =>
  Effect.gen(function* () {
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(() => {
      throw new Error("managed account unavailable");
    });
    const permits = yield* Semaphore.make(1);
    const capability = yield* makeCodexAccountUsage(
      { instanceId: ProviderInstanceId.make("personal"), displayName: "Personal", enabled: true },
      {
        cwd: process.cwd(),
        homePath: process.cwd() + "/provider-homes/personal",
        processEnvironment: { F5_PROFILE_ISOLATED: "1" },
      },
    );
    yield* capability.refresh("force", permits);
    for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
    const snapshot = yield* capability.getSnapshot;
    expect(snapshot.sections.every((section) => section.snapshot === null)).toBe(true);
    expect(snapshot.sections.every((section) => section.errorCode !== null)).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.lastCall![2].env.CODEX_HOME).toContain("/provider-homes/personal");
  }).pipe(Effect.scoped),
);
