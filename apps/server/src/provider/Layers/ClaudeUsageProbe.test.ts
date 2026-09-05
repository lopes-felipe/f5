import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import * as NodePath from "@effect/platform-node/NodePath";
import { ClaudeSettings } from "@t3tools/contracts";
import { Effect, Schema, Fiber } from "effect";
import { makeClaudeInstanceProbes } from "../Drivers/ClaudeProbeCache.ts";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { probeClaudeAccountUsage, withClaudeProbeQuery } from "./ClaudeProvider.ts";
import { FakeClaudeCodeProcess, respondToInitializeRequest } from "./ClaudeSdk.testUtils.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const run = <A, E>(effect: Effect.Effect<A, E, import("effect").Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodePath.layer)));

describe("Claude account probe", () => {
  it("uses real SDK initialization and get_usage without writing a prompt; aborts once", async () => {
    const messages: string[] = [];
    const abort = vi.fn();
    const onCapabilities = vi.fn(async () => {});
    let child: FakeClaudeCodeProcess | undefined;
    const createQuery: typeof query = (input) => {
      expect(input.options?.cwd).toBe(process.cwd());
      expect(input.options?.persistSession).toBe(false);
      expect(input.options?.allowedTools).toEqual([]);
      expect(input.options?.env?.F5_USAGE_TEST).toBe("instance");
      input.options?.abortController?.signal.addEventListener("abort", abort);
      return query({
        ...input,
        options: {
          ...input.options,
          spawnClaudeCodeProcess: (spawnOptions) => {
            child = new FakeClaudeCodeProcess((message, process) => {
              messages.push(message.type as string);
              if (respondToInitializeRequest(message, process)) return;
              if (message.type === "control_request") {
                expect((message.request as { subtype: string }).subtype).toBe("get_usage");
                process.emitJson({
                  type: "control_response",
                  response: {
                    subtype: "success",
                    request_id: message.request_id,
                    response: {
                      subscription_type: "pro",
                      rate_limits_available: true,
                      rate_limits: { five_hour: { utilization: 42 } },
                    },
                  },
                });
              }
            });
            child.stdin.on("finish", () => child?.kill("SIGTERM"));
            spawnOptions.signal.addEventListener("abort", () => child?.kill("SIGTERM"), {
              once: true,
            });
            return child;
          },
        },
      });
    };
    const value = await run(
      probeClaudeAccountUsage(
        settings,
        { ...process.env, F5_USAGE_TEST: "instance" },
        { createQuery, cwd: process.cwd(), onCapabilities },
      ),
    );
    expect(value.windows[0]?.utilization).toBe(42);
    expect(onCapabilities).toHaveBeenCalledOnce();
    expect(messages).not.toContain("user");
    expect(abort).toHaveBeenCalledOnce();
    await expect.poll(() => child?.killed).toBe(true);
  });
  it.each([
    ["absent", "unsupported"],
    ["unsupported", "unsupported"],
    ["type-error", "temporary-failure"],
    ["malformed", "invalid-response"],
    ["authentication", "authentication-required"],
    ["init-unsupported", "temporary-failure"],
    ["spawn", "process-unavailable"],
  ])("classifies %s narrowly and aborts exactly once", async (scenario, code) => {
    const abort = vi.fn();
    const createQuery: typeof query = (input) => {
      input.options?.abortController?.signal.addEventListener("abort", abort);
      if (scenario === "spawn") throw new Error("spawn ENOENT");
      return {
        initializationResult: async () => {
          if (scenario === "init-unsupported") throw new Error("unsupported");
          return { commands: [] };
        },
        ...(scenario === "absent"
          ? {}
          : {
              usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
                if (scenario === "unsupported") throw new Error("unknown request");
                if (scenario === "type-error") throw new TypeError("bad SDK data");
                if (scenario === "authentication")
                  throw new Error("401 unauthorized secret-should-not-leak");
                return {};
              },
            }),
      } as unknown as Query;
    };
    await expect(
      run(probeClaudeAccountUsage(settings, process.env, { createQuery })),
    ).rejects.toMatchObject({ code });
    expect(abort).toHaveBeenCalledOnce();
  });
  it("aborts on interruption", async () => {
    const aborted = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const createQuery: typeof query = (input) => {
      input.options?.abortController?.signal.addEventListener("abort", aborted);
      started();
      return {} as Query;
    };
    const fiber = Effect.runFork(
      withClaudeProbeQuery(settings, process.env, () => new Promise<never>(() => {}), {
        createQuery,
      }).pipe(Effect.provide(NodePath.layer)),
    );
    await ready;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(aborted).toHaveBeenCalledOnce();
  });
});

it("reuses usage initialization for capabilities waiting behind it, without another process", async () => {
  let finishInit!: (value: unknown) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const createQuery = vi.fn<typeof query>(() => {
    started();
    return {
      initializationResult: () =>
        new Promise((resolve) => {
          finishInit = resolve;
        }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: false,
      }),
    } as unknown as Query;
  });
  const probes = await run(
    makeClaudeInstanceProbes(settings, process.env, { cwd: process.cwd(), createQuery }),
  );
  const usage = Effect.runPromise(probes.usage);
  await ready;
  const capabilities = Effect.runPromise(probes.capabilities);
  finishInit({ commands: [], account: { subscriptionType: "max" } });
  await usage;
  expect((await capabilities)?.subscriptionType).toBe("max");
  expect(createQuery).toHaveBeenCalledOnce();
  await Effect.runPromise(probes.capabilities);
  expect(createQuery).toHaveBeenCalledOnce();
});

it("ordinary capabilities checks never request usage", async () => {
  const usage = vi.fn();
  const createQuery: typeof query = () =>
    ({
      initializationResult: async () => ({ commands: [] }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
    }) as unknown as Query;
  const probes = await run(
    makeClaudeInstanceProbes(settings, process.env, { cwd: process.cwd(), createQuery }),
  );
  await Effect.runPromise(probes.capabilities);
  expect(usage).not.toHaveBeenCalled();
});

effectIt.effect("timeout aborts a prompt-free query exactly once", () =>
  Effect.gen(function* () {
    const abort = vi.fn();
    const createQuery: typeof query = (input) => {
      input.options?.abortController?.signal.addEventListener("abort", abort);
      return {} as Query;
    };
    const fiber = yield* withClaudeProbeQuery(
      settings,
      process.env,
      () => new Promise<never>(() => {}),
      { createQuery },
    ).pipe(Effect.provide(NodePath.layer), Effect.result, Effect.forkChild);
    yield* TestClock.adjust("8 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "timeout" } });
    expect(abort).toHaveBeenCalledOnce();
  }),
);

it.skipIf(process.platform !== "win32")(
  "captures synchronous relative Windows shim resolution as unavailable",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "f5-usage-shim-"));
    const file = join(cwd, "claude.cmd");
    writeFileSync(file, "@echo off\n");
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const createQuery = vi.fn<typeof query>();
    try {
      await expect(
        run(
          probeClaudeAccountUsage(
            { ...settings, binaryPath: ".\\claude.cmd", homePath: cwd },
            process.env,
            { cwd, createQuery },
          ),
        ),
      ).rejects.toMatchObject({ code: "process-unavailable" });
      expect(createQuery).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      abort.mockRestore();
      unlinkSync(file);
      rmdirSync(cwd);
    }
  },
);
