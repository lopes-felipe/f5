import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChromeProcessRegistration } from "@t3tools/contracts";
import { ChromeLeaseAuthority } from "./ChromeLeaseAuthority";
import {
  ChromeProcessSupervisor,
  defaultChromeProcessIo,
  parseProcessListing,
  type ChromeProcessIo,
  type ChromeProcessRow,
} from "./ChromeProcessSupervisor";

const BACKEND = 50;
const registration = (
  patch: Partial<ChromeProcessRegistration> = {},
): ChromeProcessRegistration => ({
  profileId: "p",
  backendIncarnation: "i",
  threadId: "t",
  sessionGeneration: "g",
  launchToken: "token",
  integration: "claude-chrome",
  pid: 100,
  pgid: 100,
  startTime: 1_000,
  ...patch,
});

function fakeIo() {
  let now = 0;
  const processes = new Map<number, Omit<ChromeProcessRow, "pid">>([
    [BACKEND, { ppid: 1, pgid: BACKEND, startTime: 0, zombie: false }],
    [100, { ppid: BACKEND, pgid: 100, startTime: 1_000, zombie: false }],
  ]);
  const timers: Array<{ at: number; run: () => void; id: number }> = [];
  let nextId = 0;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const state = { listing: true, ignoreSignals: false, termKillsLeaderOnly: false };
  const io: ChromeProcessIo = {
    snapshot: async () =>
      state.listing ? [...processes].map(([pid, row]) => ({ pid, ...row })) : null,
    killGroup: (pgid, signal) => {
      signals.push([pgid, signal]);
      if (state.ignoreSignals) return;
      if (signal === "SIGTERM" && state.termKillsLeaderOnly) return void processes.delete(pgid);
      for (const [pid, row] of processes) if (row.pgid === pgid) processes.delete(pid);
    },
    setTimeout: (run, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => now,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.run();
      await flush();
    }
    now = end;
    await flush();
  };
  return { io, processes, signals, advance, state };
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("process listing", () => {
  it("keeps a row with an unreadable start time; only unreadable IDs make the listing unknown", () => {
    expect(parseProcessListing("  100 50 100 S garbage\n  7 1 7 S\n")).toEqual([
      { pid: 100, ppid: 50, pgid: 100, zombie: false, startTime: undefined },
      { pid: 7, ppid: 1, pgid: 7, zombie: false, startTime: undefined },
    ]);
    expect(
      parseProcessListing("  100 50 100 Ss Wed Oct 22 17:29:15 2026\n  ?? 1 7 S\n"),
    ).toBeNull();
  });

  it("reads lstart as UTC whatever the local zone, and refuses partial listings", () => {
    expect(
      parseProcessListing(
        "  100    50   100 Ss   Wed Oct 22 17:29:15 2026\n  101   100   100 Z    Thu Oct  2 03:04:05 2026\n",
      ),
    ).toEqual([
      {
        pid: 100,
        ppid: 50,
        pgid: 100,
        zombie: false,
        startTime: Date.UTC(2026, 9, 22, 17, 29, 15),
      },
      { pid: 101, ppid: 100, pgid: 100, zombie: true, startTime: Date.UTC(2026, 9, 2, 3, 4, 5) },
    ]);
    expect(parseProcessListing("")).toBeNull();
  });

  const psRuns = spawnSync("/bin/ps", ["-o", "pid=", "-p", String(process.pid)]).status === 0;
  // The F5 agent sandbox blocks `ps`; desktop main is not sandboxed.
  it.skipIf(!psRuns)("verifies a real detached child's start time and ancestry", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      const startTime = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const rows = await defaultChromeProcessIo.snapshot();
      const row = rows?.find((entry) => entry.pid === child.pid);
      expect(row).toMatchObject({ ppid: process.pid, pgid: child.pid, zombie: false });
      expect(Math.abs(row!.startTime! - startTime)).toBeLessThan(2_000);
      const supervisor = new ChromeProcessSupervisor();
      await supervisor.register(
        registration({ pid: child.pid!, pgid: child.pid!, startTime }),
        process.pid,
      );
      supervisor.stop(() => true, "emergency");
      await new Promise((resolve) => child.once("exit", resolve));
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("ChromeProcessSupervisor", () => {
  it("refuses unverifiable registrations", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    await expect(supervisor.register(registration({ pgid: 7 }), BACKEND)).rejects.toThrow(
      "process group",
    );
    await expect(supervisor.register(registration({ startTime: 99_000 }), BACKEND)).rejects.toThrow(
      "verified",
    );
    await expect(supervisor.register(registration({ pid: 5, pgid: 5 }), BACKEND)).rejects.toThrow(
      "verified",
    );
    h.state.listing = false;
    await expect(supervisor.register(registration(), BACKEND)).rejects.toThrow("verified");
    h.state.listing = true;
    await supervisor.register(registration(), BACKEND);
    await expect(supervisor.register(registration(), BACKEND)).rejects.toThrow("Duplicate");
  });

  it("refuses a group the registering backend did not start", async () => {
    const h = fakeIo();
    // A browser or terminal leading its own group, outside the backend's descendants.
    h.processes.set(200, { ppid: 1, pgid: 200, startTime: 1_000, zombie: false });
    h.processes.set(300, { ppid: 999, pgid: 300, startTime: 1_000, zombie: false });
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    for (const pid of [200, 300])
      await expect(
        supervisor.register(registration({ pid, pgid: pid, launchToken: String(pid) }), BACKEND),
      ).rejects.toThrow("verified");
    // A grandchild (through a wrapper) is still the backend's.
    h.processes.set(60, { ppid: BACKEND, pgid: BACKEND, startTime: 0, zombie: false });
    h.processes.set(400, { ppid: 60, pgid: 400, startTime: 1_000, zombie: false });
    await supervisor.register(registration({ pid: 400, pgid: 400 }), BACKEND);
  });

  /** Snapshots taken now but answered only when released, like a slow `ps`. */
  const deferSnapshots = (h: ReturnType<typeof fakeIo>) => {
    const held: Array<() => void> = [];
    const state = { defer: false };
    const io: ChromeProcessIo = {
      ...h.io,
      snapshot: async () => {
        const rows = await h.io.snapshot();
        if (!state.defer) return rows;
        return new Promise((resolve) => held.push(() => resolve(rows)));
      },
    };
    const release = async () => {
      for (const resolve of held.splice(0)) resolve();
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { io, state, release };
  };

  it("stops a process whose registration was being verified when ⌃⌘Esc was pressed", async () => {
    const h = fakeIo();
    const slow = deferSnapshots(h);
    const supervisor = new ChromeProcessSupervisor({ io: slow.io });
    slow.state.defer = true;
    const registering = supervisor.register(registration(), BACKEND);
    const outcome = registering.then(
      () => "accepted",
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setImmediate(resolve));
    supervisor.stop(() => true, "emergency");
    slow.state.defer = false;
    await slow.release();
    expect(await outcome).toContain("stopped");
    // Main signals the verified group itself and keeps the generation stopped.
    await h.advance(0);
    expect(h.signals).toContainEqual([100, "SIGTERM"]);
    expect(supervisor.invalidated("p", "t", "g")).toBe(true);
  });

  it("never judges a registration by a listing taken before it was registered", async () => {
    const h = fakeIo();
    const slow = deferSnapshots(h);
    const exited = vi.fn();
    const supervisor = new ChromeProcessSupervisor({ io: slow.io, exited });
    await supervisor.register(registration(), BACKEND);
    // The idle poll starts `ps` before the second child exists.
    slow.state.defer = true;
    await h.advance(2_000);
    slow.state.defer = false;
    h.processes.set(200, { ppid: BACKEND, pgid: 200, startTime: 1_000, zombie: false });
    await supervisor.register(registration({ pid: 200, pgid: 200, launchToken: "b" }), BACKEND);
    await slow.release();
    expect(exited).not.toHaveBeenCalled();
    expect(supervisor.registrations().map((entry) => entry.launchToken)).toEqual(["token", "b"]);
  });

  it("lets the host veto a registration", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({
      io: h.io,
      registered: () => {
        throw new Error("no kill chord");
      },
    });
    await expect(supervisor.register(registration(), BACKEND)).rejects.toThrow("no kill chord");
    expect(supervisor.registrations()).toEqual([]);
  });

  it("emergency stop signals SIGTERM at once and SIGKILL after one second", async () => {
    const h = fakeIo();
    h.state.ignoreSignals = true;
    const exited = vi.fn();
    const supervisor = new ChromeProcessSupervisor({ io: h.io, exited });
    await supervisor.register(registration(), BACKEND);
    supervisor.stop(() => true, "emergency");
    await h.advance(0);
    expect(h.signals).toEqual([[100, "SIGTERM"]]);
    h.state.ignoreSignals = false;
    await h.advance(1_000);
    expect(h.signals).toEqual([
      [100, "SIGTERM"],
      [100, "SIGKILL"],
    ]);
    await h.advance(500);
    expect(exited).toHaveBeenCalledTimes(1);
    expect(supervisor.alive(() => true)).toBe(false);
  });

  it("keeps ownership while a descendant survives its exited leader", async () => {
    const h = fakeIo();
    h.state.termKillsLeaderOnly = true;
    h.processes.set(101, { ppid: 100, pgid: 100, startTime: 1_000, zombie: false });
    const exited = vi.fn();
    const supervisor = new ChromeProcessSupervisor({ io: h.io, exited });
    await supervisor.register(registration(), BACKEND);
    supervisor.stop(() => true, "emergency");
    await h.advance(500);
    expect(h.processes.has(100)).toBe(false);
    expect(exited).not.toHaveBeenCalled();
    expect(supervisor.alive(() => true)).toBe(true);
    // SIGKILL still reaches the surviving member through the group.
    await h.advance(1_000);
    expect(h.signals).toContainEqual([100, "SIGKILL"]);
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable listing as unknown: no signal, no release, then recovery", async () => {
    const h = fakeIo();
    const exited = vi.fn();
    const supervisor = new ChromeProcessSupervisor({ io: h.io, exited });
    await supervisor.register(registration(), BACKEND);
    h.state.listing = false;
    supervisor.stop(() => true, "emergency");
    await h.advance(5_000);
    expect(h.signals).toEqual([]);
    expect(exited).not.toHaveBeenCalled();
    expect(supervisor.recoveryRequired()).toBe(true);
  });

  it("gives shutdown a grace period that an urgent stop replaces", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    await supervisor.register(registration(), BACKEND);
    supervisor.stop(() => true, "shutdown");
    await h.advance(1_000);
    expect(h.signals).toEqual([]);
    supervisor.stop(() => true, "emergency");
    await h.advance(0);
    expect(h.signals).toEqual([[100, "SIGTERM"]]);
  });

  it("never signals a reused PID", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    await supervisor.register(registration(), BACKEND);
    h.processes.set(100, { ppid: 1, pgid: 100, startTime: 50_000, zombie: false });
    supervisor.stop(() => true, "emergency");
    await h.advance(2_000);
    expect(h.signals).toEqual([]);
    expect(supervisor.alive(() => true)).toBe(false);
  });

  it("refuses a stopped generation until the user resumes the thread", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    await supervisor.register(registration(), BACKEND);
    expect(supervisor.stop(() => true, "emergency").map((entry) => entry.threadId)).toEqual(["t"]);
    await h.advance(1_500);
    expect(supervisor.invalidated("p", "t", "g")).toBe(true);
    h.processes.set(100, { ppid: BACKEND, pgid: 100, startTime: 9_000, zombie: false });
    const next = registration({ launchToken: "next", startTime: 9_000 });
    await expect(supervisor.register(next, BACKEND)).rejects.toThrow("Resume");
    supervisor.resumed("p", "t");
    await supervisor.register(next, BACKEND);
  });

  it("persists recovery when the exit is never observed and clears it once the group is gone", async () => {
    dir = mkdtempSync(join(tmpdir(), "f5-chrome-supervisor-"));
    const statePath = join(dir, "chrome-recovery.json");
    const h = fakeIo();
    h.state.ignoreSignals = true;
    const recoveryChanged = vi.fn();
    const supervisor = new ChromeProcessSupervisor({ io: h.io, statePath, recoveryChanged });
    await supervisor.register(registration(), BACKEND);
    supervisor.stop(() => true, "emergency");
    await h.advance(5_000);
    expect(supervisor.recoveryRequired()).toBe(true);
    expect(recoveryChanged).toHaveBeenLastCalledWith(true);
    await expect(
      supervisor.register(registration({ launchToken: "next" }), BACKEND),
    ).rejects.toThrow("not exited");

    // A desktop restart cannot assume control ended, nor clear it on an unreadable listing.
    const restarted = new ChromeProcessSupervisor({ io: h.io, statePath });
    expect(restarted.recoveryRequired()).toBe(true);
    h.state.listing = false;
    await h.advance(500);
    expect(restarted.recoveryRequired()).toBe(true);
    h.state.listing = true;
    await h.advance(500);
    expect(restarted.recoveryRequired()).toBe(true);
    // Main keeps stopping it itself, with the start time re-checked each time.
    expect(h.signals.filter(([pgid]) => pgid === 100).length).toBeGreaterThan(2);
    h.processes.delete(100);
    await h.advance(500);
    expect(restarted.recoveryRequired()).toBe(false);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ recovery: [], live: [] });
  });

  it("finds a crashed run's live groups, stops them and blocks Chrome until they are gone", async () => {
    dir = mkdtempSync(join(tmpdir(), "f5-chrome-supervisor-"));
    const statePath = join(dir, "chrome-recovery.json");
    const h = fakeIo();
    const crashed = new ChromeProcessSupervisor({ io: h.io, statePath });
    await crashed.register(registration(), BACKEND);
    // No stop ever runs: the desktop crashed with the group alive.
    const next = new ChromeProcessSupervisor({ io: h.io, statePath });
    expect(next.recoveryRequired()).toBe(true);
    await h.advance(250);
    expect(h.signals).toEqual([[100, "SIGTERM"]]);
    await h.advance(250);
    expect(next.recoveryRequired()).toBe(false);
  });

  it("never signals a crashed run's group whose PID now belongs to another process", async () => {
    dir = mkdtempSync(join(tmpdir(), "f5-chrome-supervisor-"));
    const statePath = join(dir, "chrome-recovery.json");
    const h = fakeIo();
    await new ChromeProcessSupervisor({ io: h.io, statePath }).register(registration(), BACKEND);
    h.processes.set(100, { ppid: 1, pgid: 100, startTime: 70_000, zombie: false });
    const next = new ChromeProcessSupervisor({ io: h.io, statePath });
    await h.advance(1_000);
    expect(h.signals).toEqual([]);
    expect(next.recoveryRequired()).toBe(false);
  });

  it("shutdown waits for a group that ignores SIGTERM to be killed", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    await supervisor.register(registration(), BACKEND);
    h.state.ignoreSignals = true;
    let settled = false;
    const done = supervisor
      .stopAndWait(() => true, "shutdown")
      .then(() => {
        settled = true;
      });
    await h.advance(2_500);
    expect(h.signals).toEqual([[100, "SIGTERM"]]);
    expect(settled).toBe(false);
    h.state.ignoreSignals = false;
    await h.advance(1_000);
    await done;
    expect(h.signals).toContainEqual([100, "SIGKILL"]);
    expect(supervisor.alive(() => true)).toBe(false);
  });

  it("shutdown resolves once an unkillable group is persisted for recovery", async () => {
    dir = mkdtempSync(join(tmpdir(), "f5-chrome-supervisor-"));
    const statePath = join(dir, "chrome-recovery.json");
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io, statePath });
    await supervisor.register(registration(), BACKEND);
    h.state.ignoreSignals = true;
    const done = supervisor.stopAndWait(() => true, "shutdown");
    await h.advance(5_000);
    await done;
    expect(supervisor.recoveryRequired()).toBe(true);
    expect(JSON.parse(readFileSync(statePath, "utf8")).recovery).toHaveLength(1);
  });

  it("keeps a group alive when its leader's start time is unreadable", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    await supervisor.register(registration(), BACKEND);
    h.processes.set(100, { ppid: BACKEND, pgid: 100, startTime: undefined, zombie: false });
    h.state.ignoreSignals = true;
    supervisor.stop(() => true, "emergency");
    await h.advance(0);
    // Still signalled as alive, never released as if it were gone.
    expect(h.signals).toEqual([[100, "SIGTERM"]]);
    expect(supervisor.alive(() => true)).toBe(true);
  });
});

describe("ChromeLeaseAuthority with a supervisor", () => {
  const holder = {
    profileId: "p",
    threadId: "t",
    sessionGeneration: "g",
    provider: "claude" as const,
  };

  it("releases only after the registered group exits", async () => {
    const h = fakeIo();
    let lease: ChromeLeaseAuthority | undefined;
    const supervisor = new ChromeProcessSupervisor({
      io: h.io,
      exited: () => lease?.processExited(),
    });
    const changed = vi.fn();
    lease = new ChromeLeaseAuthority(changed, supervisor);
    lease.acquire(holder, null);
    await supervisor.register(registration(), BACKEND);
    lease.release(holder);
    expect(lease.current()).toEqual(holder);
    expect(() => lease.validate(holder)).toThrow();
    // A different profile stays busy while the group drains.
    expect(() => lease.acquire({ ...holder, profileId: "q" }, null)).toThrow();
    await h.advance(3_500);
    expect(lease.current()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it("interrupt invalidates the generation immediately", async () => {
    const h = fakeIo();
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    const lease = new ChromeLeaseAuthority(() => {}, supervisor);
    lease.acquire(holder, null);
    await supervisor.register(registration(), BACKEND);
    expect(lease.interrupt("emergency")).toEqual(holder);
    expect(() => lease.validate(holder)).toThrow();
    await h.advance(0);
    expect(h.signals[0]).toEqual([100, "SIGTERM"]);
  });

  it("refuses new Chrome and native control while recovery is required", async () => {
    const h = fakeIo();
    h.state.ignoreSignals = true;
    const supervisor = new ChromeProcessSupervisor({ io: h.io });
    const lease = new ChromeLeaseAuthority(() => {}, supervisor);
    await supervisor.register(registration(), BACKEND);
    supervisor.stop(() => true, "emergency");
    await h.advance(5_000);
    expect(() => lease.acquire(holder, null)).toThrow("hasn't stopped yet");
    expect(() => lease.assertNativeAvailable("p")).toThrow("hasn't stopped yet");
  });
});
