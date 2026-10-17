import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Deferred, Effect, Exit, Fiber, Layer, PubSub, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerConfig } from "../../config.ts";
import type { ProcessRunOptions, ProcessRunResult } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { withProviderThreadAccess } from "../providerThreadAccess.ts";
import type { ProviderInstallTarget } from "../providerInstallChannel.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  failureRetryDelayMs,
  hasAdvisoryStateChanged,
  makeProviderUpdateAdvisor,
  nextProviderUpdateCheckDelay,
} from "./ProviderUpdateAdvisorLive.ts";

const id = ProviderInstanceId.make("codex");
const otherId = ProviderInstanceId.make("codex-shared");
const driver = ProviderDriverKind.make("codex");
const source = { kind: "npm", pkg: "@openai/codex", tag: "latest" } as const;
const target: ProviderInstallTarget = {
  channel: "npm",
  executablePath: "/nvm/bin/codex",
  realPath: "/nvm/lib/node_modules/@openai/codex/bin/codex.js",
  updateEnvironment: { HOME: "/real-home", PATH: "/base/bin", F5_PROFILE_ISOLATED: "1" },
  installKey: "npm:/nvm:@openai/codex",
  latestSource: source,
  sourceKey: JSON.stringify(source),
  guidance: "Use npm.",
  npm: { prefix: "/nvm", pkg: "@openai/codex", npmPath: "/nvm/bin/npm" },
};
const processSuccess = {
  code: 0,
  stdout: "installed",
  stderr: "",
  signal: null,
  timedOut: false,
} satisfies ProcessRunResult;
const infra = ServerConfig.layerTest(process.cwd(), { prefix: "provider-update-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

function makeHarness(
  options: {
    target?: ProviderInstallTarget;
    shared?: boolean;
    enabled?: boolean;
    platform?: NodeJS.Platform;
    isolated?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const ids = options.shared ? [id, otherId] : [id];
    const state = {
      targets: new Map(ids.map((key) => [key, options.target ?? target])),
      beforeSnapshotRead: Effect.void as Effect.Effect<void>,
      beforeHttp: Effect.void as Effect.Effect<void>,
      beforeStop: Effect.void as Effect.Effect<void, Error>,
      targetReads: 0,
      httpCalls: 0,
      httpStatus: 200,
      latest: "1.1.0",
      retryAfter: "120",
      registry: "https://registry.npmjs.org/",
      scopedRegistries: {} as Record<string, string>,
      registryCalls: [] as string[],
      beforeSessionRead: Effect.void as Effect.Effect<void>,
      sessionReads: 0,
      version: "1.1.0",
      stale: false,
      probeFailure: false,
      refreshed: [] as ProviderInstanceId[],
      stopped: [] as string[],
      sessions: [] as ProviderSession[],
      executions: [] as { command: string; args: readonly string[]; options: ProcessRunOptions }[],
      run: async (_opts: ProcessRunOptions): Promise<ProcessRunResult> => processSuccess,
      instances: [] as ProviderInstance[],
      snapshots: ids.map(
        (instanceId): ServerProvider => ({
          instanceId,
          driver,
          enabled: true,
          installed: true,
          version: "codex-cli 1.0.0",
          checkedAt: "2026-01-01T00:00:00.000Z",
          probeOutcome: "success",
          status: "ready",
          auth: { status: "unknown" },
          models: [],
          skills: [],
          slashCommands: [],
        }),
      ),
    };
    state.instances = ids.map((instanceId) => ({
      instanceId,
      driverKind: driver,
      displayName: "Codex",
      enabled: true,
      continuationIdentity: { driverKind: driver, continuationKey: String(instanceId) },
      snapshot: {} as ProviderInstance["snapshot"],
      adapter: {} as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
      resolveInstallTarget: () => {
        state.targetReads++;
        return state.targets.get(instanceId) ?? null;
      },
    }));
    const http = HttpClient.make((request) =>
      Effect.suspend(() => state.beforeHttp).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.httpCalls++;
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ version: state.latest }), {
                status: state.httpStatus,
                headers: { "Retry-After": state.retryAfter },
              }),
            );
          }),
        ),
      ),
    );
    const instanceRegistry = {
      listInstances: Effect.sync(() => state.instances),
      getInstance: (instanceId: ProviderInstanceId) =>
        Effect.sync(() => state.instances.find((instance) => instance.instanceId === instanceId)),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    };
    const registry = {
      getProviders: Effect.suspend(() => state.beforeSnapshotRead).pipe(
        Effect.map(() => state.snapshots),
      ),
      streamChanges: Stream.empty,
      refresh: () => Effect.sync(() => state.snapshots),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        Effect.sync(() => {
          state.refreshed.push(instanceId);
          state.snapshots = state.snapshots.map((snapshot) =>
            snapshot.instanceId !== instanceId || state.stale
              ? snapshot
              : {
                  ...snapshot,
                  version: state.version,
                  checkedAt: new Date().toISOString(),
                  probeOutcome: state.probeFailure ? "transient_failure" : "success",
                },
          );
          return state.snapshots;
        }),
    };
    const providerService = {
      listSessions: () =>
        Effect.suspend(() => state.beforeSessionRead).pipe(
          Effect.map(() => {
            state.sessionReads++;
            return state.sessions;
          }),
        ),
      stopSession: ({ threadId }: { threadId: string }) =>
        Effect.suspend(() => state.beforeStop).pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.stopped.push(threadId);
            }),
          ),
        ),
    } as unknown as ProviderServiceShape;
    const advisor = yield* makeProviderUpdateAdvisor({
      platform: options.platform ?? "linux",
      runProcess: async (command, args, opts) => {
        if (args[0] === "config") {
          state.registryCalls.push(args[2]!);
          return {
            ...processSuccess,
            stdout:
              args[2] === "registry"
                ? state.registry
                : (state.scopedRegistries[args[2]!] ?? "undefined"),
          };
        }
        state.executions.push({ command, args, options: opts });
        return state.run(opts);
      },
    }).pipe(
      Effect.provideService(ProviderInstanceRegistry, instanceRegistry),
      Effect.provideService(ProviderRegistry, registry),
      Effect.provideService(ProviderService, providerService),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(
        ServerConfig,
        options.isolated
          ? { ...config, profile: { ...config.profile!, isDefault: false } }
          : config,
      ),
    );
    const advisory = (instanceId: ProviderInstanceId = id) =>
      advisor.getAdvisoryFor({
        instanceId,
        driver,
        currentVersion:
          state.snapshots.find((snapshot) => snapshot.instanceId === instanceId)?.version ?? null,
      });
    return { advisor, state, settings, advisory };
  }).pipe(
    Effect.provide(
      Layer.merge(
        infra,
        ServerSettingsService.layerTest({ enableProviderUpdateChecks: options.enabled ?? false }),
      ),
    ),
  );
}

function session(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    threadId: ThreadId.makeUnsafe("idle-session"),
    provider: "codex",
    providerInstanceId: id,
    status: "ready",
    runtimeMode: "full-access",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
function gate() {
  let release!: (value: ProcessRunResult) => void;
  let started!: () => void;
  const pending = new Promise<ProcessRunResult>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    release,
    ready,
    run: async () => {
      started();
      return pending;
    },
  };
}

describe("provider update advisor", () => {
  it.effect("validates the package scope before the global npm registry", () =>
    Effect.gen(function* () {
      const { advisor, state, advisory } = yield* makeHarness({ shared: true });
      state.scopedRegistries["@openai:registry"] = "https://private.example/";
      state.registryCalls = [];
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      expect(state.registryCalls).toEqual(["@openai:registry"]);
      expect((yield* advisory()).blockedReason).toBe("custom_registry");
      expect((yield* advisory(otherId)).canRunUpdate).toBe(false);
      expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain("can't update");
      expect(state.executions).toHaveLength(0);
      // An explicit public scope wins over a private default, just as npm does.
      state.scopedRegistries["@openai:registry"] = "https://registry.npmjs.org/";
      state.registry = "https://private.example/";
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      expect((yield* advisory()).canRunUpdate).toBe(true);
    }),
  );
  it.effect("publishes snapshot changes without target I/O or waiting for release checks", () =>
    Effect.gen(function* () {
      const { advisor, state, advisory } = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeHttp = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const checking = yield* advisor
        .refreshAdvisories({ mode: "explicit" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const reads = state.targetReads;
      const registryCalls = state.registryCalls.length;
      state.snapshots = state.snapshots.map((snapshot) => ({ ...snapshot, version: "1.0.1" }));
      yield* advisor.noteRegistryChanged;
      expect((yield* advisory()).currentVersion).toBe("1.0.1");
      expect(state.targetReads).toBe(reads);
      expect(state.registryCalls).toHaveLength(registryCalls);
      // Rebuilding an instance also reconciles independently of the network lookup.
      state.instances = state.instances.map((instance) => ({ ...instance }));
      yield* advisor.noteRegistryChanged;
      yield* Effect.yieldNow;
      expect(state.targetReads).toBeGreaterThan(reads);
      expect(state.registryCalls).toHaveLength(registryCalls);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(checking);
    }),
  );
  for (const channel of ["remote", "self-update"] as const)
    it.effect(`does not advertise an unknown ${channel} update`, () =>
      Effect.gen(function* () {
        const { advisor, advisory } = yield* makeHarness({
          target: { ...target, channel, latestSource: null, sourceKey: null },
        });
        yield* advisor.refreshAdvisories({ mode: "explicit" });
        expect((yield* advisory()).status).toBe("unknown");
        expect((yield* advisory()).updateAvailable).toBe(false);
        expect((yield* advisory()).canRunUpdate).toBe(false);
      }),
    );
  it.effect("rejects a cached success from during installation when the final refresh fails", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      state.run = async () => {
        state.snapshots = state.snapshots.map((snapshot) => ({
          ...snapshot,
          version: "1.1.0",
          checkedAt: new Date().toISOString(),
        }));
        state.stale = true;
        return processSuccess;
      };
      expect((yield* advisor.runUpdate(id)).outcome).toBe("unverified");
      expect(state.refreshed).toEqual([id]);
    }),
  );
  it.effect("rechecks a formerly idle session under the turn submission lock", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      state.sessions = [session()];
      const listedIdle = yield* Deferred.make<void>();
      state.beforeSessionRead = Effect.suspend(() =>
        state.sessionReads === 1
          ? Deferred.succeed(listedIdle, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const caller = yield* withProviderThreadAccess(
        "idle-session",
        Effect.gen(function* () {
          const updating = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
          yield* Deferred.await(listedIdle);
          state.sessions = [session({ status: "running" })];
          return updating;
        }),
      );
      expect((yield* Fiber.join(caller).pipe(Effect.flip)).message).toContain("active work");
      expect(state.stopped).toEqual([]);
      expect(state.executions).toEqual([]);
    }),
  );
  it.effect(
    "reports idle-session stop failure without claiming the installer failed to start",
    () =>
      Effect.gen(function* () {
        const { advisor, state } = yield* makeHarness();
        state.sessions = [session()];
        state.version = "1.0.0";
        state.beforeStop = Effect.fail(new Error("stop unavailable"));
        expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain(
          "Could not stop an idle Codex session",
        );
        expect(state.executions).toEqual([]);
        state.beforeStop = Effect.void;
        state.version = "1.1.0";
        expect((yield* advisor.runUpdate(id)).outcome).toBe("updated");
      }),
  );
  it.effect("releases the installation claim after a defect before the worker starts", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      state.beforeSessionRead = Effect.die("admission defect");
      expect(Exit.isFailure(yield* advisor.runUpdate(id).pipe(Effect.exit))).toBe(true);
      state.beforeSessionRead = Effect.void;
      expect((yield* advisor.runUpdate(id)).outcome).toBe("updated");
      expect(state.executions).toHaveLength(1);
    }),
  );

  it("retains retry policy and schedules the earliest eligible source", () => {
    expect(failureRetryDelayMs({ _tag: "network", cause: "offline" }, 0)).toBe(1_800_000);
    expect(failureRetryDelayMs({ _tag: "parse", cause: "bad" }, 0)).toBe(21_600_000);
    expect(failureRetryDelayMs({ _tag: "not_found" }, 0)).toBe(86_400_000);
    expect(failureRetryDelayMs({ _tag: "rate_limited" }, 20)).toBe(86_400_000);
    expect(
      nextProviderUpdateCheckDelay(
        [
          { nextEligibleAt: 4000, consecutiveFailures: 0 },
          { nextEligibleAt: 9000, consecutiveFailures: 0 },
        ],
        1000,
      ),
    ).toBe(3000);
  });
  it.effect(
    "coalesces source lookups, resolves each target once per pass, and shares physical installs",
    () =>
      Effect.gen(function* () {
        const { advisor, state, advisory } = yield* makeHarness({ shared: true });
        const before = state.targetReads;
        yield* Effect.all(
          [
            advisor.refreshAdvisories({ mode: "explicit" }),
            advisor.refreshAdvisories({ mode: "explicit" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(state.httpCalls).toBe(1);
        expect(state.targetReads - before).toBe(4);
        const oldReads = state.targetReads;
        const first = yield* advisory();
        expect(first.status).toBe("behind_latest");
        expect(first.sharedWith).toEqual([otherId]);
        expect((yield* advisory(otherId)).sharedWith).toEqual([id]);
        expect(state.targetReads).toBe(oldReads);
        expect(first.updateCommand?.args).toContain("@openai/codex@1.1.0");
        expect(hasAdvisoryStateChanged(first, { ...first, message: "changed" })).toBe(true);
        expect(
          hasAdvisoryStateChanged(first, {
            ...first,
            activeUpdate: { startedAt: new Date().toISOString(), targetVersion: "1.1.0" },
          }),
        ).toBe(true);
      }),
  );
  it.effect("keeps bundled Claude visible without networking", () =>
    Effect.gen(function* () {
      const { advisory, state } = yield* makeHarness({
        target: { ...target, channel: "bundled", installKey: "bundled" },
      });
      expect((yield* advisory()).status).toBe("bundled");
      expect((yield* advisory()).message).toBe("Bundled with F5.");
      expect(state.httpCalls).toBe(0);
    }),
  );
  it.effect("provides manual guidance for an unmanaged installation", () =>
    Effect.gen(function* () {
      const { advisor, advisory } = yield* makeHarness({
        target: { ...target, channel: "unmanaged", guidance: "Use devbox to update." },
      });
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      expect((yield* advisory()).status).toBe("manual");
      expect((yield* advisory()).message).toBe("Use devbox to update.");
      expect((yield* advisory()).updateCommand).toBeNull();
    }),
  );
  it.effect("does not automate custom registries", () =>
    Effect.gen(function* () {
      const { advisor, state, advisory } = yield* makeHarness();
      state.registry = "https://private.example/";
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      expect((yield* advisory()).blockedReason).toBe("custom_registry");
      expect((yield* advisory()).canRunUpdate).toBe(false);
      expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain("can't update");
      expect(state.executions).toHaveLength(0);
    }),
  );
  it.effect("keeps previous success on failure and bypasses backoff only for explicit checks", () =>
    Effect.gen(function* () {
      const { advisor, state, advisory } = yield* makeHarness();
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
      try {
        state.httpStatus = 503;
        yield* advisor.refreshAdvisories({ mode: "explicit" });
        const failed = yield* advisory();
        expect(failed.status).toBe("check_failed");
        expect(failed.latestVersion).toBe("1.1.0");
        expect(failed.failedAt).toBeTruthy();
        expect(failed.updateAvailable).toBe(true);
        expect(failed.canRunUpdate).toBe(false);
        yield* advisor.refreshAdvisories();
        expect(state.httpCalls).toBe(2);
        state.httpStatus = 200;
        yield* advisor.refreshAdvisories({ mode: "explicit" });
        expect(state.httpCalls).toBe(3);
        expect((yield* advisory()).status).toBe("behind_latest");
      } finally {
        clock.mockRestore();
      }
    }),
  );
  it.effect("coalesces concurrent failures while allowing a later explicit retry", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      state.httpStatus = 503;
      yield* Effect.all(
        [
          advisor.refreshAdvisories({ mode: "explicit" }),
          advisor.refreshAdvisories({ mode: "explicit" }),
        ],
        { concurrency: "unbounded" },
      );
      expect(state.httpCalls).toBe(1);
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      expect(state.httpCalls).toBe(2);
    }),
  );

  it.effect("explicit checks work with scheduling off but honor Retry-After", () =>
    Effect.gen(function* () {
      const { advisor, state, advisory } = yield* makeHarness();
      state.httpStatus = 429;
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      expect(state.httpCalls).toBe(1);
      expect((yield* advisory()).retryAt).toBeTruthy();
      expect((yield* advisory()).status).toBe("check_failed");
    }),
  );
  it.effect("turning checks off retains known results", () =>
    Effect.gen(function* () {
      const { advisor, advisory, state, settings } = yield* makeHarness({ enabled: true });
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      yield* Effect.yieldNow;
      yield* advisor.refreshAdvisories();
      expect((yield* advisory()).latestVersion).toBe("1.1.0");
      expect(state.httpCalls).toBe(1);
    }),
  );
  it.effect("the scheduler retries a network failure before the success interval", () =>
    Effect.gen(function* () {
      const { state } = yield* makeHarness({
        enabled: true,
        target: { ...target, channel: "self-update", selfUpdateArgs: ["update"] },
      });
      state.httpStatus = 503;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      expect(state.httpCalls).toBe(1);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_800_100);
      try {
        yield* TestClock.adjust("30 minutes");
        expect(state.httpCalls).toBe(2);
      } finally {
        clock.mockRestore();
      }
    }),
  );
  it.effect(
    "updates, stops idle sessions first, refreshes all sharing instances, and clears progress",
    () =>
      Effect.gen(function* () {
        const { advisor, state, advisory } = yield* makeHarness({ shared: true });
        state.sessions = [session()];
        state.run = async (opts) => {
          expect(state.stopped).toEqual(["idle-session"]);
          expect(opts.stdin).toBe("");
          expect(opts.env.F5_PROFILE_ISOLATED).toBeUndefined();
          expect(opts.env.HOME).toBe("/real-home");
          expect(opts.env.PATH).toBe("/nvm/bin:/base/bin");
          expect(opts.env.NPM_CONFIG_PREFIX).toBe("/nvm");
          expect(opts.outputMode).toBe("tail");
          expect(opts.timeoutMs).toBe(600_000);
          return processSuccess;
        };
        const result = yield* advisor.runUpdate(id);
        expect(result.outcome).toBe("updated");
        expect(state.refreshed).toEqual([id, otherId]);
        expect((yield* advisory()).activeUpdate).toBeNull();
        expect(state.executions).toHaveLength(1);
      }),
  );
  for (const [name, version, outcome] of [
    ["unchanged", "1.0.0", "unchanged"],
    ["unexpected npm version", "1.2.0", "unexpected_version"],
  ] as const)
    it.effect(`reports ${name}`, () =>
      Effect.gen(function* () {
        const { advisor, state } = yield* makeHarness();
        state.version = version;
        expect((yield* advisor.runUpdate(id)).outcome).toBe(outcome);
      }),
    );
  it.effect("accepts a newer Homebrew version than the advisory", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness({
        target: {
          ...target,
          channel: "homebrew",
          brew: { executable: "/brew", ref: "custom/tap/codex", cask: false },
        },
      });
      state.version = "1.2.0";
      expect((yield* advisor.runUpdate(id)).outcome).toBe("updated");
    }),
  );
  for (const failure of ["stale", "probeFailure"] as const)
    it.effect(`does not verify ${failure} snapshots`, () =>
      Effect.gen(function* () {
        const { advisor, state } = yield* makeHarness();
        state[failure] = true;
        expect((yield* advisor.runUpdate(id)).outcome).toBe("unverified");
      }),
    );
  it.effect("returns failure tails and still refreshes after nonzero exit or timeout", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      state.run = async () => ({
        ...processSuccess,
        code: 1,
        stderr: "failure marker",
        stderrTruncated: true,
        timedOut: true,
      });
      const result = yield* advisor.runUpdate(id);
      expect(result.outcome).toBe("failed");
      expect(result.output).toContain("failure marker");
      expect(result.outputTruncated).toBe(true);
      expect(result.timedOut).toBe(true);
      expect(state.refreshed).toEqual([id]);
    }),
  );
  it.effect("handles a rejected spawn without losing the lock or refresh", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      state.run = async () => {
        throw new Error("spawn ENOENT");
      };
      const result = yield* advisor.runUpdate(id);
      expect(result.outcome).toBe("failed");
      expect(result.exitCode).toBeNull();
      expect(state.refreshed).toEqual([id]);
    }),
  );
  it.effect("duplicate clicks join one worker and progress survives caller interruption", () =>
    Effect.gen(function* () {
      const { advisor, state, advisory } = yield* makeHarness({ shared: true });
      const pending = gate();
      state.run = pending.run;
      const caller = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.ready);
      expect((yield* advisory()).activeUpdate?.targetVersion).toBe("1.1.0");
      yield* Fiber.interrupt(caller);
      expect(state.executions[0]?.options.signal?.aborted).toBe(false);
      const joined = yield* advisor.runUpdate(otherId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      pending.release(processSuccess);
      expect((yield* Fiber.join(joined)).outcome).toBe("updated");
      expect(state.executions).toHaveLength(1);
    }),
  );
  it.effect("keeps progress visible while an installer temporarily removes its executable", () =>
    Effect.gen(function* () {
      const { advisor, state, advisory } = yield* makeHarness();
      const pending = gate();
      state.run = pending.run;
      const running = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.ready);
      state.targets.delete(id);
      yield* advisor.noteRegistryChanged;
      expect((yield* advisory()).activeUpdate?.targetVersion).toBe("1.1.0");
      expect((yield* advisory()).status).toBe("behind_latest");
      pending.release(processSuccess);
      yield* Fiber.join(running);
    }),
  );

  it.effect("excludes another installation and refreshes a rebuilt instance by ID", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness({ shared: true });
      state.targets.set(otherId, { ...target, installKey: "npm:/other:@openai/codex" });
      const pending = gate();
      state.run = pending.run;
      const running = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.ready);
      expect((yield* advisor.runUpdate(otherId).pipe(Effect.flip)).message).toContain(
        "Another provider update",
      );
      state.instances = state.instances.map((instance) => ({ ...instance }));
      pending.release(processSuccess);
      yield* Fiber.join(running);
      expect(state.refreshed).toEqual([id]);
    }),
  );
  for (const work of [
    session({ status: "running" }),
    session({ status: "connecting" }),
    session({ activeTurnId: "turn" as ProviderSession["activeTurnId"] }),
  ])
    it.effect(`refuses active work (${work.status}, ${work.activeTurnId ?? "no turn"})`, () =>
      Effect.gen(function* () {
        const { advisor, state } = yield* makeHarness({ shared: true });
        state.sessions = [{ ...work, providerInstanceId: otherId }];
        expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain("active work");
        expect(state.executions).toHaveLength(0);
        state.sessions = [];
        expect((yield* advisor.runUpdate(id)).outcome).toBe("updated");
      }),
    );
  for (const channel of ["bundled", "unmanaged", "remote"] as const)
    it.effect(`refuses ${channel} installations`, () =>
      Effect.gen(function* () {
        const { advisor, state } = yield* makeHarness({ target: { ...target, channel } });
        expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain("can't update");
        expect(state.executions).toHaveLength(0);
      }),
    );
  it.effect("refuses Windows execution", () =>
    Effect.gen(function* () {
      const { advisor } = yield* makeHarness({ platform: "win32" });
      expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain("can't update");
    }),
  );
  it.effect("requires the Default profile", () =>
    Effect.gen(function* () {
      const { advisor } = yield* makeHarness({ isolated: true });
      expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain("Default profile");
    }),
  );
  it.effect("keeps an owner when the caller is interrupted between claim and worker fork", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      const claimed = yield* Deferred.make<void>();
      const continueAdmission = yield* Deferred.make<void>();
      let reads = 0;
      state.beforeSnapshotRead = Effect.suspend(() =>
        ++reads === 3
          ? Deferred.succeed(claimed, undefined).pipe(
              Effect.andThen(Deferred.await(continueAdmission)),
            )
          : Effect.void,
      );
      const pending = gate();
      state.run = pending.run;
      const caller = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
      yield* Deferred.await(claimed);
      const interruption = yield* Fiber.interrupt(caller).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(continueAdmission, undefined);
      yield* Fiber.join(interruption);
      yield* Effect.promise(() => pending.ready);
      const joined = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      pending.release(processSuccess);
      expect((yield* Fiber.join(joined)).outcome).toBe("updated");
      expect(state.executions).toHaveLength(1);
    }),
  );

  it.effect("refreshes metadata older than 60 seconds before pinning an npm update", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      yield* advisor.refreshAdvisories({ mode: "explicit" });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      try {
        state.latest = "1.2.0";
        state.version = "1.2.0";
        expect((yield* advisor.runUpdate(id)).outcome).toBe("updated");
        expect(state.httpCalls).toBe(2);
        expect(state.executions[0]?.args).toContain("@openai/codex@1.2.0");
      } finally {
        clock.mockRestore();
      }
    }),
  );

  it.effect("rejects disabled and already-current providers", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness();
      state.snapshots = state.snapshots.map((snapshot) => ({ ...snapshot, enabled: false }));
      expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toContain(
        "Enable and install",
      );
      state.snapshots = state.snapshots.map((snapshot) => ({
        ...snapshot,
        enabled: true,
        version: "1.1.0",
      }));
      expect((yield* advisor.runUpdate(id).pipe(Effect.flip)).message).toBe("Already up to date.");
      expect(state.executions).toHaveLength(0);
    }),
  );

  it.effect(
    "releases admission when the caller is interrupted before it claims the installation",
    () =>
      Effect.gen(function* () {
        const { advisor, state } = yield* makeHarness();
        const caller = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
        yield* Fiber.interrupt(caller);
        expect((yield* advisor.runUpdate(id)).outcome).toBe("updated");
        expect(state.executions).toHaveLength(1);
      }),
  );

  it.effect("skips an affected instance deleted during the update", () =>
    Effect.gen(function* () {
      const { advisor, state } = yield* makeHarness({ shared: true });
      state.run = async () => {
        state.instances = state.instances.filter((instance) => instance.instanceId !== otherId);
        return processSuccess;
      };
      yield* advisor.runUpdate(id);
      expect(state.refreshed).toEqual([id]);
    }),
  );

  it.effect("aborts on layer shutdown and waits for process settlement before scope close", () =>
    Effect.gen(function* () {
      const childScope = yield* Scope.make();
      const { advisor, state } = yield* makeHarness().pipe(
        Effect.provideService(Scope.Scope, childScope),
      );
      let aborted = false,
        settled = false;
      const pending = gate();
      state.run = async (opts) => {
        opts.signal!.addEventListener("abort", () => {
          aborted = true;
          pending.release({ ...processSuccess, code: null, aborted: true });
        });
        const result = await pending.run();
        settled = true;
        return result;
      };
      const caller = yield* advisor.runUpdate(id).pipe(Effect.forkChild);
      yield* Effect.promise(() => pending.ready);
      yield* Scope.close(childScope, Exit.void);
      expect((yield* Fiber.join(caller).pipe(Effect.flip)).message).toContain("shutdown");
      expect(aborted).toBe(true);
      expect(settled).toBe(true);
      expect(state.refreshed).toEqual([id]);
    }),
  );
});
