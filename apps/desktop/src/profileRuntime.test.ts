import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ProfileId } from "@t3tools/contracts";
import { ChildProcess } from "node:child_process";
import {
  profilePartition,
  profilePreviewPartition,
  profileWindowArguments,
  singleProfileOpen,
  ensureProfileConnection,
  ensureProfileBackend,
  isProfileBackendRunning,
  waitForProfileBackend,
  BACKEND_HEALTHY_RESET_MS,
  MAX_BACKEND_RESTART_ATTEMPTS,
  monitorBackendHealth,
  planBackendRestart,
} from "./profileRuntime";
import { buildDesktopBackendEnv } from "./backendEnv";

describe("profile window isolation", () => {
  const profile = { id: Schema.decodeUnknownSync(ProfileId)("a".repeat(32)), isDefault: false };
  it("preserves Default storage and separates non-default browsing and previews", () => {
    expect(profilePartition({ ...profile, isDefault: true })).toBeUndefined();
    expect(profilePreviewPartition({ ...profile, isDefault: true })).toBe("persist:f5-preview");
    expect(profilePartition(profile)).toBe(`persist:f5-profile-${profile.id}`);
    expect(profilePreviewPartition(profile)).not.toBe(profilePartition(profile));
  });
  it("passes only immutable identity, never credentials, in renderer arguments", () => {
    expect(profileWindowArguments(profile.id)).toEqual([`--f5-profile-id=${profile.id}`]);
    expect(
      buildDesktopBackendEnv(
        {},
        {
          backendPort: 4567,
          stateDir: "state",
          stateDirSource: "explicit-state",
          authToken: "owned",
          profileSlug: "work",
        },
      ).F5_PROFILE,
    ).toBe("work");
  });
});

describe("profile backend recovery", () => {
  const child = () =>
    Object.assign(new ChildProcess(), {
      pid: 123,
      exitCode: null,
      signalCode: null,
      killed: false,
    });
  const runtime = () => ({
    backendProcess: null as ChildProcess | null,
    stopped: false,
    restartAttempt: 6,
    restartTimer: null as ReturnType<typeof setTimeout> | null,
  });

  it("recovers a missing backend even when the profile is still marked running", async () => {
    const state = runtime();
    const calls: string[] = [];
    await ensureProfileBackend(state, {
      stop: async () => {
        calls.push("stop");
      },
      prepare: async () => {
        calls.push("prepare");
      },
      start: () => {
        calls.push("start");
        state.backendProcess = child();
      },
      ready: async () => {
        expect(isProfileBackendRunning(state)).toBe(true);
        calls.push("ready");
      },
    });
    expect(calls).toEqual(["prepare", "start", "ready"]);
    expect(state.stopped).toBe(false);
    expect(state.restartAttempt).toBe(0);
  });

  it.each(["stopped", "exited", "signalled", "killed"] as const)(
    "waits for a %s backend to exit before starting its replacement",
    async (failure) => {
      const state = { ...runtime(), backendProcess: child() as ChildProcess | null };
      const old = state.backendProcess!;
      if (failure === "stopped") state.stopped = true;
      if (failure === "exited") Object.assign(old, { exitCode: 1 });
      if (failure === "signalled") Object.assign(old, { signalCode: "SIGTERM" });
      if (failure === "killed") Object.assign(old, { killed: true });
      const calls: string[] = [];
      await ensureProfileBackend(state, {
        stop: async () => {
          await Promise.resolve();
          calls.push("stop");
          state.backendProcess = null;
        },
        prepare: async () => {
          calls.push("prepare");
        },
        start: () => {
          expect(state.backendProcess).toBeNull();
          calls.push("start");
          state.backendProcess = child();
        },
        ready: async () => {
          calls.push("ready");
        },
      });
      expect(calls).toEqual(["stop", "prepare", "start", "ready"]);
    },
  );

  it("checks readiness without restarting a live backend", async () => {
    const state = { ...runtime(), backendProcess: child() };
    const operations = { stop: vi.fn(), prepare: vi.fn(), start: vi.fn(), ready: vi.fn() };
    await ensureProfileBackend(state, operations);
    expect(operations.ready).toHaveBeenCalledOnce();
    expect(operations.stop).not.toHaveBeenCalled();
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(operations.start).not.toHaveBeenCalled();
  });

  it("cancels a scheduled restart and leaves the profile stopped if preparation fails", async () => {
    vi.useFakeTimers();
    try {
      const restart = vi.fn();
      const state = runtime();
      state.restartTimer = setTimeout(() => {
        restart();
      }, 100);
      const start = vi.fn();
      await expect(
        ensureProfileBackend(state, {
          stop: vi.fn(),
          prepare: async () => {
            throw new Error("shutting down");
          },
          start,
          ready: vi.fn(),
        }),
      ).rejects.toThrow("shutting down");
      await vi.runAllTimersAsync();
      expect(restart).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(state.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for startup and stops waiting if the backend exits", async () => {
    vi.useFakeTimers();
    try {
      const ready = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const waiting = waitForProfileBackend(() => true, ready);
      await vi.advanceTimersByTimeAsync(100);
      await waiting;
      expect(ready).toHaveBeenCalledTimes(2);
      await expect(waitForProfileBackend(() => false, ready)).rejects.toThrow("Backend stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds readiness waiting for a backend that never listens", async () => {
    vi.useFakeTimers();
    try {
      const waiting = expect(
        waitForProfileBackend(
          () => true,
          async () => false,
          200,
        ),
      ).rejects.toThrow("startup timed out");
      await vi.advanceTimersByTimeAsync(200);
      await waiting;
    } finally {
      vi.useRealTimers();
    }
  });
});

it("coalesces concurrent opens and permits reopening after completion", async () => {
  let calls = 0;
  let release!: () => void;
  const open = singleProfileOpen(async () => {
    calls++;
    await new Promise<void>((r) => {
      release = r;
    });
    return true;
  });
  const first = open("work");
  const second = open("work");
  expect(first).toBe(second);
  await Promise.resolve();
  expect(calls).toBe(1);
  release();
  await first;
  const reopened = open("work");
  await Promise.resolve();
  expect(calls).toBe(2);
  release();
  await reopened;
});

it("reopens a stopped profile without stranding either retained window", async () => {
  const runtime = { backendPort: 0, backendAuthToken: "", backendWsUrl: "" };
  const reserve = vi.fn(async () => 4555);
  const mint = vi.fn(() => "owned-token");
  const url = (port: number, token: string) => `ws://127.0.0.1:${port}/?token=${token}`;
  await ensureProfileConnection(runtime, reserve, mint, url);
  const retainedWindows = ["thread-a", "thread-b"].map((thread) => ({
    thread,
    preloadUrl: runtime.backendWsUrl,
  }));
  // Stopping the process retains runtime identity; reopening must reuse both windows' immutable URLs.
  await ensureProfileConnection(runtime, reserve, mint, url);
  expect(retainedWindows.every((window) => window.preloadUrl === runtime.backendWsUrl)).toBe(true);
  expect(retainedWindows.map((window) => window.thread)).toEqual(["thread-a", "thread-b"]);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(mint).toHaveBeenCalledTimes(1);
});

describe("backend restart budget", () => {
  it("reports a startup timeout once and reports recovery when that generation becomes ready", async () => {
    vi.useFakeTimers();
    let ready = false;
    const onReady = vi.fn(),
      onStartupTimeout = vi.fn();
    const cancel = monitorBackendHealth({
      isCurrent: () => true,
      checkReady: async () => ready,
      onReady,
      onStartupTimeout,
      onSustainedHealth: () => {},
      startupTimeoutMs: 2_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onStartupTimeout).toHaveBeenCalledOnce();
      expect(onReady).not.toHaveBeenCalled();
      ready = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      cancel();
      vi.useRealTimers();
    }
  });
  const crash = (state: { restartAttempt: number }) => planBackendRestart(state);

  it("stops a rapid crash loop after six restarts with exponential backoff", () => {
    const state = { restartAttempt: 0 };
    const plans = Array.from({ length: MAX_BACKEND_RESTART_ATTEMPTS + 1 }, () => crash(state));
    expect(plans.slice(0, -1).map((plan) => (plan.kind === "restart" ? plan.delayMs : -1))).toEqual(
      [500, 1000, 2000, 4000, 8000, 10_000],
    );
    expect(plans.at(-1)).toEqual({ kind: "stop" });
  });

  it("keeps recovering from widely spaced crashes after sustained health", async () => {
    vi.useFakeTimers();
    try {
      const state = { restartAttempt: 0 };
      for (let crashIndex = 0; crashIndex < MAX_BACKEND_RESTART_ATTEMPTS * 3; crashIndex += 1) {
        expect(crash(state).kind).toBe("restart");
        monitorBackendHealth({
          isCurrent: () => true,
          checkReady: async () => true,
          onSustainedHealth: () => {
            state.restartAttempt = 0;
          },
        });
        await vi.advanceTimersByTimeAsync(BACKEND_HEALTHY_RESET_MS + 1);
        expect(state.restartAttempt).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not forgive crashes before health is confirmed for the full window", async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      const onSustainedHealth = vi.fn();
      monitorBackendHealth({
        isCurrent: () => true,
        checkReady: async () => ready,
        onSustainedHealth,
      });
      await vi.advanceTimersByTimeAsync(BACKEND_HEALTHY_RESET_MS * 2);
      expect(onSustainedHealth).not.toHaveBeenCalled();
      ready = true;
      await vi.advanceTimersByTimeAsync(BACKEND_HEALTHY_RESET_MS - 2_000);
      expect(onSustainedHealth).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onSustainedHealth).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a stale or cancelled generation reset a newer process's count", async () => {
    vi.useFakeTimers();
    try {
      const state = { restartAttempt: 0, generation: 1 };
      const monitorFor = (generation: number) =>
        monitorBackendHealth({
          isCurrent: () => state.generation === generation,
          checkReady: async () => true,
          onSustainedHealth: () => {
            state.restartAttempt = 0;
          },
        });
      monitorFor(1);
      await vi.advanceTimersByTimeAsync(10);
      // Generation 1 crashes and generation 2 starts crashing before it is healthy.
      crash(state);
      state.generation = 2;
      crash(state);
      await vi.advanceTimersByTimeAsync(BACKEND_HEALTHY_RESET_MS * 2);
      expect(state.restartAttempt).toBe(2);

      const cancel = monitorFor(2);
      await vi.advanceTimersByTimeAsync(BACKEND_HEALTHY_RESET_MS / 2);
      cancel();
      await vi.advanceTimersByTimeAsync(BACKEND_HEALTHY_RESET_MS * 2);
      expect(state.restartAttempt).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a readiness answer that arrives after cancellation", async () => {
    vi.useFakeTimers();
    try {
      let resolveCheck: ((ready: boolean) => void) | undefined;
      let checks = 0;
      const onSustainedHealth = vi.fn();
      const cancel = monitorBackendHealth({
        isCurrent: () => true,
        checkReady: () => {
          checks += 1;
          return checks === 1
            ? Promise.resolve(true)
            : new Promise((resolve) => (resolveCheck = resolve));
        },
        onSustainedHealth,
      });
      await vi.advanceTimersByTimeAsync(BACKEND_HEALTHY_RESET_MS + 1);
      expect(resolveCheck).toBeDefined();
      cancel();
      resolveCheck?.(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(onSustainedHealth).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
