import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepAwakeController, type BlockerType, type KeepAwakeDependencies } from "./controller";
import type { Preferences } from "./preferences";
import type { LidMarker } from "./lidOwnership";

function harness(
  input: Omit<Preferences, "keepDisplayOn"> & { keepDisplayOn?: boolean } = {
    mode: "always",
    closedLid: true,
  },
) {
  const prefs: Preferences = { keepDisplayOn: false, ...input };
  let flag: 0 | 1 | null = 0;
  let battery: number | null = 100;
  let onBattery = false;
  let thermal = "nominal";
  let marker: LidMarker | null = null;
  const order: string[] = [];
  const identity: LidMarker = {
    gen: "00000000-0000-4000-8000-000000000000",
    ownerPid: 1,
    ownerStart: "owner",
    watchdogPid: 2,
    watchdogStart: "watchdog",
    engagedAt: 0,
    protocol: 2,
  };
  const started = new Map<number, BlockerType>();
  const blockerLog: string[] = [];
  let nextBlocker = 1;
  const d: KeepAwakeDependencies = {
    platform: "darwin",
    now: Date.now,
    blocker: {
      start: vi.fn((type: BlockerType) => {
        const id = nextBlocker++;
        started.set(id, type);
        blockerLog.push("start:" + type);
        return id;
      }),
      stop: vi.fn((id) => {
        blockerLog.push("stop:" + started.get(id));
        started.delete(id);
      }),
      isStarted: (id) => started.has(id),
    },
    pollDemand: vi.fn(async () => 0),
    power: {
      readSleepDisabled: vi.fn(async () => flag),
      setSleepDisabled: vi.fn(async (value) => {
        order.push("set:" + value);
        flag = value;
        return "ok" as const;
      }),
      sudoRuleAvailable: vi.fn(async () => true),
      readBatteryPercent: vi.fn(async () => battery),
      lidHardware: vi.fn(async () => "present" as const),
      readLidClosed: vi.fn(async () => false),
      displaySleepNow: vi.fn(async () => {}),
      installRule: vi.fn(async () => "ok" as const),
      removeRule: vi.fn(async () => "ok" as const),
      ruleInstalledByF5: vi.fn(async () => false),
    },
    ownership: {
      read: vi.fn(async () => marker),
      newMarker: vi.fn(async () => ({ ...identity })),
      write: vi.fn(async (value) => {
        order.push("marker");
        marker = value;
      }),
      remove: vi.fn(async () => {
        order.push("remove");
        marker = null;
      }),
      armWatchdog: vi.fn(async (value) => {
        order.push("watchdog");
        return value;
      }),
      watchdogAlive: vi.fn(async () => true),
      killWatchdog: vi.fn(async () => {
        order.push("kill");
      }),
    },
    environment: {
      isOnBattery: () => onBattery,
      thermalState: () => thermal,
      hasExternalDisplay: () => false,
    },
    save: vi.fn(async () => {}),
    broadcast: vi.fn(),
    log: vi.fn(),
  };
  const controller = new KeepAwakeController(prefs, d);
  return {
    controller,
    d,
    order,
    identity,
    blockerLog,
    blockers: () => [...started.values()],
    plugIn: () => {
      onBattery = false;
    },
    flag: (value: typeof flag) => {
      flag = value;
    },
    battery: (value: typeof battery) => {
      battery = value;
      onBattery = true;
    },
    thermal: (value: string) => {
      thermal = value;
    },
    marker: (value: LidMarker) => {
      marker = value;
    },
  };
}
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
describe("KeepAwakeController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("arms recovery before writing and releases on Off without probing from getState", async () => {
    const h = harness();
    await h.controller.start();
    expect(h.order.slice(0, 3)).toEqual(["marker", "watchdog", "set:1"]);
    const probes = vi.mocked(h.d.power.sudoRuleAvailable).mock.calls.length;
    const revision = h.controller.getState().revision;
    h.controller.getState();
    expect(h.d.power.sudoRuleAvailable).toHaveBeenCalledTimes(probes);
    await h.controller.setPreferences({ mode: "off" });
    expect(h.controller.getState()).toMatchObject({
      active: false,
      lid: { engaged: false, sleepDisabled: 0 },
    });
    expect(h.controller.getState().revision).toBeGreaterThan(revision);
    await h.controller.dispose();
  });
  it("undoes a late successful engagement after Off", async () => {
    const h = harness({ mode: "off", closedLid: true });
    await h.controller.start();
    let complete!: () => void;
    vi.mocked(h.d.power.setSleepDisabled).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      h.flag(1);
      return "ok";
    });
    const on = h.controller.setPreferences({ mode: "always" });
    await flush();
    const off = h.controller.setPreferences({ mode: "off" });
    complete();
    await Promise.all([on, off]);
    expect(h.controller.getState()).toMatchObject({
      mode: "off",
      active: false,
      lid: { engaged: false, sleepDisabled: 0 },
    });
    await h.controller.dispose();
  });
  it("retains ownership on unknown reset and retries", async () => {
    const h = harness();
    await h.controller.start();
    vi.mocked(h.d.power.setSleepDisabled).mockResolvedValueOnce("unknown");
    await h.controller.setPreferences({ mode: "off" });
    expect(h.controller.getState().lid).toMatchObject({
      engaged: true,
      blockedReason: "reset-failed",
    });
    expect(h.d.ownership.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid.engaged).toBe(false);
    await h.controller.dispose();
  });
  it.each([1, null] as const)("recovers unknown engagement outcome %s", async (outcome) => {
    const h = harness();
    vi.mocked(h.d.power.setSleepDisabled).mockImplementationOnce(async () => {
      h.flag(outcome);
      return "unknown";
    });
    await h.controller.start();
    expect(h.order).toContain("set:0");
    expect(h.controller.getState().lid).toMatchObject({
      engaged: false,
      blockedReason: "command-failed",
    });
    await h.controller.dispose();
  });
  it("keeps a watchdog when both engagement and recovery are unknown", async () => {
    const h = harness();
    vi.mocked(h.d.power.setSleepDisabled).mockImplementation(async () => {
      h.flag(null);
      return "unknown";
    });
    await h.controller.start();
    expect(h.controller.getState().lid).toMatchObject({
      engaged: true,
      blockedReason: "reset-failed",
    });
    expect(h.d.ownership.remove).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("does not write when readback is unknown or an external app owns the flag", async () => {
    const h = harness();
    h.flag(1);
    await h.controller.start();
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    expect(h.controller.getState().lid.blockedReason).toBe("external-override");
    h.flag(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid.engaged).toBe(true);
    h.flag(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid.blockedReason).toBe("external-change");
    expect(h.d.power.setSleepDisabled).toHaveBeenCalledTimes(1);
    await h.controller.dispose();
  });
  it.each(["write", "armWatchdog"] as const)("never flips the flag if %s fails", async (step) => {
    const h = harness();
    vi.mocked(h.d.ownership[step]).mockRejectedValueOnce(new Error("failure"));
    await h.controller.start();
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    expect(h.controller.getState().lid.blockedReason).toBe("command-failed");
    await h.controller.dispose();
  });
  it("recovers an earlier marker before new engagement", async () => {
    const h = harness({ mode: "off", closedLid: false });
    h.flag(1);
    h.marker(h.identity);
    await h.controller.start();
    expect(h.order).toEqual(["kill", "set:0", "kill", "remove"]);
    await h.controller.dispose();
  });
  it("uses battery hysteresis and thermal holds", async () => {
    const h = harness();
    h.battery(19);
    await h.controller.start();
    expect(h.controller.getState().lid.blockedReason).toBe("battery-low");
    h.battery(24);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    h.battery(25);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid.engaged).toBe(true);
    h.thermal("serious");
    h.controller.powerChanged();
    await flush();
    expect(h.controller.getState().lid).toMatchObject({ engaged: false, blockedReason: "thermal" });
    h.thermal("fair");
    h.controller.powerChanged();
    await flush();
    expect(h.controller.getState().lid.engaged).toBe(true);
    await h.controller.dispose();
  });
  it("holds agents awake for five minutes and polls only agents mode", async () => {
    const h = harness({ mode: "agents", closedLid: false });
    vi.mocked(h.d.pollDemand).mockResolvedValueOnce(2);
    await h.controller.start();
    expect(h.controller.getState().active).toBe(true);
    await vi.advanceTimersByTimeAsync(290_000);
    expect(h.controller.getState().active).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.controller.getState().active).toBe(false);
    await h.controller.setPreferences({ mode: "always" });
    const calls = vi.mocked(h.d.pollDemand).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.d.pollDemand).toHaveBeenCalledTimes(calls);
    await h.controller.dispose();
  });
  it("discards stale demand and never overlaps rounds", async () => {
    const h = harness({ mode: "agents", closedLid: false });
    let resolve!: (n: number) => void;
    vi.mocked(h.d.pollDemand).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = h.controller.start();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.d.pollDemand).toHaveBeenCalledTimes(1);
    await h.controller.setPreferences({ mode: "off" });
    resolve(2);
    await start;
    expect(h.controller.getState()).toMatchObject({ active: false, busyThreadCount: 0 });
    await h.controller.dispose();
  });
  it("darkens the internal panel once and rearms on activity", async () => {
    const h = harness();
    vi.mocked(h.d.power.readLidClosed).mockResolvedValue(true);
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.d.power.displaySleepNow).toHaveBeenCalledTimes(1);
    h.controller.userActive();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.d.power.displaySleepNow).toHaveBeenCalledTimes(2);
    await h.controller.dispose();
  });
  it("bounds disposal while reset is hung and re-arms a dead watchdog", async () => {
    const h = harness();
    await h.controller.start();
    vi.mocked(h.d.ownership.watchdogAlive).mockResolvedValue(false);
    vi.mocked(h.d.power.setSleepDisabled).mockImplementation(() => new Promise(() => {}));
    let done = false;
    const dispose = h.controller.dispose().then(() => {
      done = true;
    });
    await flush();
    expect(h.d.ownership.armWatchdog).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await dispose;
    expect(h.controller.getState()).toMatchObject({ active: false, lid: { engaged: true } });
  });
  it("shows stale recovery when startup reset cannot be verified", async () => {
    const h = harness({ mode: "off", closedLid: false });
    h.marker(h.identity);
    h.flag(1);
    vi.mocked(h.d.power.setSleepDisabled).mockResolvedValue("unknown");
    await h.controller.start();
    expect(h.controller.getState().lid).toMatchObject({
      engaged: true,
      blockedReason: "stale-override",
    });
    expect(h.d.ownership.watchdogAlive).toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("blocks unknown battery and unknown global sleep state", async () => {
    const h = harness();
    h.battery(null);
    await h.controller.start();
    expect(h.controller.getState().lid.blockedReason).toBe("battery-unknown");
    h.battery(100);
    h.flag(null);
    h.controller.powerChanged();
    await flush();
    expect(h.controller.getState().lid.blockedReason).toBe("command-failed");
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("marks denied engagement as missing permission", async () => {
    const h = harness();
    vi.mocked(h.d.power.setSleepDisabled).mockResolvedValueOnce("denied");
    await h.controller.start();
    expect(h.controller.getState().lid).toMatchObject({ permission: "missing", engaged: false });
    await h.controller.dispose();
  });
  it("never polls the lid with an external display", async () => {
    const h = harness();
    h.d.environment.hasExternalDisplay = () => true;
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.d.power.readLidClosed).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("refuses permission removal if reset fails", async () => {
    const h = harness();
    await h.controller.start();
    vi.mocked(h.d.power.setSleepDisabled).mockResolvedValueOnce("unknown");
    await h.controller.changePermission(false);
    expect(h.d.power.removeRule).not.toHaveBeenCalled();
    expect(h.controller.getState().lid.blockedReason).toBe("reset-failed");
    await h.controller.dispose();
  });
  it("clears a failed setup when permission installation is retried successfully", async () => {
    const h = harness();
    vi.mocked(h.d.power.sudoRuleAvailable).mockResolvedValue(false);
    await h.controller.start();
    vi.mocked(h.d.power.installRule).mockResolvedValueOnce("failed").mockResolvedValueOnce("ok");
    await h.controller.changePermission(true);
    vi.mocked(h.d.power.sudoRuleAvailable).mockResolvedValue(true);
    await h.controller.changePermission(true);
    expect(h.controller.getState().lid).toMatchObject({ engaged: true, blockedReason: null });
    await h.controller.dispose();
  });
  it("releases the lid immediately when cooldown ends between maintenance rounds", async () => {
    const h = harness({ mode: "agents", closedLid: true });
    vi.mocked(h.d.pollDemand).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(309_999);
    expect(h.controller.getState().lid.engaged).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.controller.getState()).toMatchObject({ active: false, lid: { engaged: false } });
    await h.controller.dispose();
  });
  it("keeps polling agents while an administrator prompt blocks the lid queue", async () => {
    const h = harness({ mode: "agents", closedLid: true });
    await h.controller.start();
    let complete!: () => void;
    vi.mocked(h.d.power.installRule).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return "ok";
    });
    const install = h.controller.changePermission(true);
    await flush();
    vi.mocked(h.d.pollDemand).mockResolvedValue(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.d.pollDemand).toHaveBeenCalledTimes(5);
    expect(h.controller.getState().active).toBe(true);
    complete();
    await install;
    await h.controller.dispose();
  });
  it("reconciles Off despite a persistence failure and reports that failure separately", async () => {
    const h = harness();
    await h.controller.start();
    vi.mocked(h.d.save).mockRejectedValueOnce(new Error("disk full"));
    await expect(h.controller.setPreferences({ mode: "off" })).rejects.toThrow(
      "could not be saved",
    );
    expect(h.controller.getState()).toMatchObject({
      mode: "off",
      active: false,
      lid: { engaged: false },
    });
    await h.controller.dispose();
  });
  it("recovers automatically from a transient state read failure", async () => {
    const h = harness();
    h.flag(null);
    await h.controller.start();
    expect(h.controller.getState().lid.blockedReason).toBe("command-failed");
    h.flag(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid).toMatchObject({ engaged: true, blockedReason: null });
    await h.controller.dispose();
  });
  it("continues permission checks with a corrupt marker and retries recovery after repair", async () => {
    const h = harness();
    vi.mocked(h.d.ownership.read).mockRejectedValue(new Error("corrupt marker"));
    await h.controller.start();
    expect(h.d.power.sudoRuleAvailable).toHaveBeenCalled();
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    expect(h.controller.getState().lid.blockedReason).toBe("stale-override");
    vi.mocked(h.d.ownership.read).mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid.engaged).toBe(true);
    await h.controller.dispose();
  });
  it("never writes or engages until old watchdog descendants have exited", async () => {
    const h = harness();
    h.marker(h.identity);
    h.flag(1);
    vi.mocked(h.d.ownership.killWatchdog).mockRejectedValue(new Error("child still alive"));
    await h.controller.start();
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    expect(h.controller.getState().lid.blockedReason).toBe("stale-override");
    vi.mocked(h.d.ownership.killWatchdog).mockResolvedValue();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid.engaged).toBe(true);
    expect(h.order).toContain("set:1");
    await h.controller.dispose();
  });
  it("recomputes final lid demand after on/off/on during a blocked engagement", async () => {
    const h = harness({ mode: "always", closedLid: false });
    await h.controller.start();
    let complete!: () => void;
    vi.mocked(h.d.power.setSleepDisabled).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      h.flag(1);
      return "ok";
    });
    const on = h.controller.setPreferences({ closedLid: true });
    await flush();
    const off = h.controller.setPreferences({ closedLid: false });
    const again = h.controller.setPreferences({ closedLid: true });
    complete();
    await Promise.all([on, off, again]);
    expect(h.controller.getState().lid).toMatchObject({ engaged: true, permission: "available" });
    expect(h.d.power.sudoRuleAvailable).toHaveBeenCalledTimes(2);
    const revisions = vi.mocked(h.d.broadcast).mock.calls.map(([state]) => state.revision);
    expect(
      revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
    ).toBe(true);
    await h.controller.dispose();
  });
  it("lifts external-change suppression when agent demand restarts", async () => {
    const h = harness({ mode: "agents", closedLid: true });
    vi.mocked(h.d.pollDemand).mockResolvedValueOnce(1);
    await h.controller.start();
    h.flag(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid.blockedReason).toBe("external-change");
    await vi.advanceTimersByTimeAsync(270_000);
    vi.mocked(h.d.pollDemand).mockResolvedValue(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getState().lid).toMatchObject({ engaged: true, blockedReason: null });
    await h.controller.dispose();
  });
  it("does not engage with a rule that cannot reset sleep", async () => {
    const h = harness();
    vi.mocked(h.d.power.sudoRuleAvailable).mockResolvedValue(false);
    await h.controller.start();
    expect(h.controller.getState().lid.permission).toBe("missing");
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("does not arm a second watchdog while engagement is still arming", async () => {
    const h = harness({ mode: "always", closedLid: false });
    await h.controller.start();
    vi.mocked(h.d.ownership.newMarker).mockResolvedValue({
      ...h.identity,
      watchdogPid: 0,
      watchdogStart: "",
    });
    let complete!: () => void;
    vi.mocked(h.d.ownership.armWatchdog).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return h.identity;
    });
    const engage = h.controller.setPreferences({ closedLid: true });
    await flush();
    const dispose = h.controller.dispose();
    await flush();
    expect(h.d.ownership.armWatchdog).toHaveBeenCalledTimes(1);
    complete();
    await Promise.all([engage, dispose]);
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
  });
  it("hides lid-only pause reasons when only idle prevention is requested", async () => {
    const h = harness({ mode: "always", closedLid: false });
    h.battery(15);
    h.flag(1);
    await h.controller.start();
    expect(h.controller.getState()).toMatchObject({ active: true, lid: { blockedReason: null } });
    await h.controller.setPreferences({ mode: "off" });
    expect(h.controller.getState().lid.blockedReason).toBeNull();
    await h.controller.dispose();
  });
  it("keeps the display on when requested and switches blocker type without a gap", async () => {
    const h = harness({ mode: "always", closedLid: false, keepDisplayOn: true });
    await h.controller.start();
    // Idle prevention starts at once; display-on follows the first guard pass.
    expect(h.blockerLog).toEqual([
      "start:prevent-app-suspension",
      "start:prevent-display-sleep",
      "stop:prevent-app-suspension",
    ]);
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    expect(h.controller.getState()).toMatchObject({
      keepDisplayOn: true,
      active: true,
      displayActive: true,
      displayPausedReason: null,
    });
    h.blockerLog.length = 0;
    await h.controller.setPreferences({ keepDisplayOn: false });
    expect(h.blockerLog).toEqual(["start:prevent-app-suspension", "stop:prevent-display-sleep"]);
    expect(h.controller.getState()).toMatchObject({ active: true, displayActive: false });
    await h.controller.setPreferences({ keepDisplayOn: true });
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    await h.controller.setPreferences({ mode: "off" });
    expect(h.blockers()).toEqual([]);
    expect(h.controller.getState()).toMatchObject({ active: false, displayActive: false });
    await h.controller.dispose();
  });
  it("keeps the display on in agents mode only while busy and during cooldown", async () => {
    const h = harness({ mode: "agents", closedLid: false, keepDisplayOn: true });
    await h.controller.start();
    expect(h.blockers()).toEqual([]);
    vi.mocked(h.d.pollDemand).mockResolvedValueOnce(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    await vi.advanceTimersByTimeAsync(290_000);
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.blockers()).toEqual([]);
    await h.controller.dispose();
  });
  it("falls back to idle-only prevention on low or unknown battery and heat", async () => {
    const h = harness({ mode: "always", closedLid: false, keepDisplayOn: true });
    h.battery(19);
    await h.controller.start();
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    expect(h.controller.getState()).toMatchObject({
      active: true,
      displayActive: false,
      displayPausedReason: "battery-low",
      lid: { blockedReason: null },
    });
    h.battery(24);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    // The display blocker is never started, even briefly, while a hold applies.
    expect(h.blockerLog).not.toContain("start:prevent-display-sleep");
    expect(vi.mocked(h.d.broadcast).mock.calls.some(([state]) => state.displayActive)).toBe(false);
    h.battery(25);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    h.thermal("serious");
    h.controller.powerChanged();
    await flush();
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    h.thermal("fair");
    h.controller.powerChanged();
    await flush();
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    h.battery(null);
    h.controller.powerChanged();
    await flush();
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    h.plugIn();
    h.controller.powerChanged();
    await flush();
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("drops the display assertion before darkening a closed internal panel", async () => {
    const h = harness({ mode: "always", closedLid: true, keepDisplayOn: true });
    vi.mocked(h.d.power.readLidClosed).mockResolvedValue(true);
    let atSleep: string[] = [];
    vi.mocked(h.d.power.displaySleepNow).mockImplementation(async () => {
      atSleep = h.blockers();
    });
    await h.controller.start();
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.d.power.displaySleepNow).toHaveBeenCalledTimes(1);
    expect(atSleep).toEqual(["prevent-app-suspension"]);
    expect(h.controller.getState()).toMatchObject({
      displayActive: false,
      displayPausedReason: "panel-off",
      lid: { engaged: true },
    });
    // A session switch while the lid is still closed restores display-on only
    // until the panel is darkened again.
    h.controller.userActive();
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.d.power.displaySleepNow).toHaveBeenCalledTimes(2);
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    await h.controller.dispose();
  });
  it("restores display-on when the lid reopens without a session event", async () => {
    const h = harness({ mode: "always", closedLid: true, keepDisplayOn: true });
    vi.mocked(h.d.power.readLidClosed).mockResolvedValue(true);
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    vi.mocked(h.d.power.readLidClosed).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    expect(h.controller.getState()).toMatchObject({ displayActive: true, lid: { engaged: true } });
    // Closing it again darkens the panel and falls back once more.
    vi.mocked(h.d.power.readLidClosed).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.d.power.displaySleepNow).toHaveBeenCalledTimes(2);
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    await h.controller.dispose();
  });
  it("restores display-on when an external display is attached to a closed lid", async () => {
    const h = harness({ mode: "always", closedLid: true, keepDisplayOn: true });
    vi.mocked(h.d.power.readLidClosed).mockResolvedValue(true);
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    h.d.environment.hasExternalDisplay = () => true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    await h.controller.dispose();
  });
  it("treats battery power as an unknown level outside macOS", async () => {
    const h = harness({ mode: "always", closedLid: false, keepDisplayOn: true });
    h.d.platform = "win32";
    await h.controller.start();
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    h.battery(50);
    h.controller.powerChanged();
    await flush();
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    expect(h.controller.getState()).toMatchObject({
      displayActive: false,
      displayPausedReason: "battery-unknown",
      lid: { supported: false, blockedReason: null },
    });
    expect(h.d.power.readBatteryPercent).not.toHaveBeenCalled();
    h.plugIn();
    h.controller.powerChanged();
    await flush();
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    expect(h.d.power.setSleepDisabled).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("keeps the previous blocker when a display start does not take", async () => {
    const h = harness({ mode: "always", closedLid: false });
    await h.controller.start();
    const original = vi.mocked(h.d.blocker.start).getMockImplementation()!;
    vi.mocked(h.d.blocker.start).mockImplementation((type) =>
      type === "prevent-display-sleep" ? 999 : original(type),
    );
    await h.controller.setPreferences({ keepDisplayOn: true });
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    expect(h.d.blocker.stop).not.toHaveBeenCalled();
    expect(h.controller.getState()).toMatchObject({
      active: true,
      displayActive: false,
      lid: { blockedReason: "blocker-failed" },
    });
    await h.controller.dispose();
  });
  it("keeps the previous blocker when the display blocker cannot start", async () => {
    const h = harness({ mode: "always", closedLid: false });
    await h.controller.start();
    const original = vi.mocked(h.d.blocker.start).getMockImplementation()!;
    vi.mocked(h.d.blocker.start).mockImplementation((type) => {
      if (type === "prevent-display-sleep") throw new Error("denied");
      return original(type);
    });
    await h.controller.setPreferences({ keepDisplayOn: true });
    expect(h.blockers()).toEqual(["prevent-app-suspension"]);
    expect(h.controller.getState()).toMatchObject({
      active: true,
      displayActive: false,
      lid: { blockedReason: "blocker-failed" },
    });
    vi.mocked(h.d.blocker.start).mockImplementation(original);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.blockers()).toEqual(["prevent-display-sleep"]);
    expect(h.controller.getState()).toMatchObject({
      displayActive: true,
      lid: { blockedReason: null },
    });
    await h.controller.dispose();
  });
});
