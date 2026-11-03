import type { DesktopKeepAwakeState, DesktopKeepAwakeBlockedReason } from "@t3tools/contracts";
import type { Preferences } from "./preferences";
import type { MacPower } from "./macPower";
import type { LidMarker, LidOwnership } from "./lidOwnership";

export const AGENT_POLL_MS = 10_000;
export const COOLDOWN_MS = 300_000;
export const MAINTENANCE_MS = 30_000;
export interface KeepAwakeDependencies {
  platform: string;
  now(): number;
  blocker: {
    start(type: "prevent-app-suspension"): number;
    stop(id: number): void;
    isStarted(id: number): boolean;
  };
  pollDemand(): Promise<number>;
  power: MacPower;
  ownership: Omit<LidOwnership, "runWrite">;
  environment: { isOnBattery(): boolean; thermalState(): string; hasExternalDisplay(): boolean };
  save(preferences: Preferences): Promise<void>;
  broadcast(state: DesktopKeepAwakeState): void;
  log(error: unknown): void;
}
export class KeepAwakeController {
  private epoch = 0;
  private disposed = false;
  private blockerId: number | null = null;
  private busy = 0;
  private cooldown: number | null = null;
  private marker: LidMarker | null = null;
  private permission: DesktopKeepAwakeState["lid"]["permission"] = "unknown";
  private hardware = false;
  private resetVerified = false;
  private installed = false;
  private sleepDisabled: 0 | 1 | null = null;
  private batteryHold = false;
  private batteryUnknown = false;
  private thermalHold = false;
  private external = false;
  private suppressed = false;
  private failure: DesktopKeepAwakeBlockedReason | null = null;
  private blockerFailed = false;
  private pending = 0;
  private revision = 0;
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private displayTimer: ReturnType<typeof setTimeout> | undefined;
  private displayDone = false;
  private lastMaintenance = -Infinity;
  private permissionOperation = false;
  private snapshot: DesktopKeepAwakeState | undefined;
  private startupRecovery = false;
  private invalidMarker = false;
  private readFailed = false;
  private setupFailed = false;
  private maintenanceQueued = false;
  private previousLidDemand = false;
  constructor(
    private prefs: Preferences,
    private readonly d: KeepAwakeDependencies,
  ) {}
  private activeDemand() {
    return (
      !this.disposed &&
      (this.prefs.mode === "always" ||
        (this.prefs.mode === "agents" &&
          (this.busy > 0 || (this.cooldown !== null && this.d.now() < this.cooldown))))
    );
  }
  private lidDemand() {
    return (
      this.activeDemand() && this.prefs.closedLid && this.d.platform === "darwin" && this.hardware
    );
  }
  getState = (): DesktopKeepAwakeState => {
    const lidReason =
      this.failure === "stale-override"
        ? this.failure
        : this.failure === "reset-failed"
          ? this.failure
          : this.external
            ? "external-override"
            : this.suppressed
              ? "external-change"
              : this.thermalHold
                ? "thermal"
                : this.batteryUnknown
                  ? "battery-unknown"
                  : this.batteryHold
                    ? "battery-low"
                    : this.prefs.closedLid && this.permission === "missing"
                      ? "permission-missing"
                      : (this.failure ??
                        (this.readFailed
                          ? "command-failed"
                          : this.blockerFailed
                            ? "blocker-failed"
                            : null));
    const reason =
      this.failure === "stale-override" || this.failure === "reset-failed"
        ? this.failure
        : this.lidDemand() || this.marker
          ? lidReason
          : this.blockerFailed
            ? "blocker-failed"
            : null;
    return {
      revision: this.revision,
      ...this.prefs,
      active: this.blockerId !== null && this.d.blocker.isStarted(this.blockerId),
      busyThreadCount: this.prefs.mode === "agents" ? this.busy : 0,
      cooldownUntil: this.prefs.mode === "agents" ? this.cooldown : null,
      lid: {
        supported: this.d.platform === "darwin" && this.hardware,
        permission: this.permission,
        ruleInstalledByF5: this.installed,
        engaged: this.marker !== null,
        sleepDisabled: this.sleepDisabled,
        pending: this.pending > 0,
        blockedReason: reason,
      },
    };
  };
  private publish() {
    const next = this.getState();
    if (
      JSON.stringify({ ...next, revision: 0 }) ===
      JSON.stringify(this.snapshot && { ...this.snapshot, revision: 0 })
    )
      return;
    this.revision++;
    this.snapshot = this.getState();
    this.d.broadcast(this.snapshot);
  }
  private idle() {
    const wanted = this.activeDemand();
    if (wanted && (this.blockerId === null || !this.d.blocker.isStarted(this.blockerId))) {
      try {
        this.blockerId = this.d.blocker.start("prevent-app-suspension");
        this.blockerFailed = !this.d.blocker.isStarted(this.blockerId);
      } catch (error) {
        this.blockerFailed = true;
        this.d.log(error);
      }
    } else if (!wanted && this.blockerId !== null) {
      if (this.d.blocker.isStarted(this.blockerId)) this.d.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }
  private enqueue(operation: () => Promise<void>) {
    this.pending++;
    this.publish();
    this.queue = this.queue
      .then(operation)
      .catch((error) => {
        this.d.log(error);
        this.failure = this.marker && !this.resetVerified ? "reset-failed" : "command-failed";
      })
      .finally(() => {
        this.pending--;
        this.publish();
      });
    return this.queue;
  }
  private async clearOwnership() {
    const marker = this.marker;
    if (marker) await this.d.ownership.killWatchdog(marker);
    await this.d.ownership.remove();
    this.marker = null;
    this.failure = null;
    this.resetVerified = false;
    this.displayDone = false;
  }
  private async reset(stale = false) {
    const result = await this.d.power.setSleepDisabled(0);
    this.sleepDisabled = result === "ok" ? 0 : await this.d.power.readSleepDisabled();
    if (result === "ok") {
      this.resetVerified = true;
      await this.clearOwnership();
      return true;
    }
    this.failure = stale ? "stale-override" : "reset-failed";
    return false;
  }
  private async guards() {
    const thermal = this.d.environment.thermalState();
    if (thermal === "serious" || thermal === "critical") this.thermalHold = true;
    else if (thermal === "nominal" || thermal === "fair") this.thermalHold = false;
    if (!this.d.environment.isOnBattery()) {
      this.batteryHold = false;
      this.batteryUnknown = false;
    } else {
      const percent = await this.d.power.readBatteryPercent();
      this.batteryUnknown = percent === null;
      if (percent !== null) {
        if (percent < 20) this.batteryHold = true;
        else if (percent >= 25) this.batteryHold = false;
      }
    }
  }
  private async refreshPermission() {
    this.permission = (await this.d.power.sudoRuleAvailable()) ? "available" : "missing";
    this.installed = await this.d.power.ruleInstalledByF5();
  }
  async start() {
    await this.enqueue(async () => {
      if (this.d.platform !== "darwin") return;
      this.hardware = (await this.d.power.lidHardware()) !== "absent";
      this.installed = await this.d.power.ruleInstalledByF5();
      try {
        this.marker = await this.d.ownership.read();
      } catch (error) {
        this.invalidMarker = true;
        this.failure = "stale-override";
        this.d.log(error);
      }
      this.startupRecovery = true;
      try {
        await this.recoverStartup();
      } finally {
        if (this.prefs.closedLid) await this.refreshPermission();
      }
    });
    if (!this.disposed) {
      await this.tick();
      await this.queue;
    }
  }
  private async recoverStartup(): Promise<boolean> {
    if (!this.startupRecovery) return true;
    let fenced = false;
    try {
      if (this.invalidMarker) {
        this.marker = await this.d.ownership.read();
        this.invalidMarker = false;
      }
      if (this.marker) {
        // This is a write fence, including privileged descendants whose shell
        // has exited. Never reset or engage while an old reset can still finish.
        await this.d.ownership.killWatchdog(this.marker);
        fenced = true;
        this.sleepDisabled = await this.d.power.readSleepDisabled();
        if (this.sleepDisabled === 0) await this.clearOwnership();
        else if (!(await this.reset(true))) return false;
      } else {
        this.sleepDisabled = await this.d.power.readSleepDisabled();
        this.external = this.sleepDisabled === 1;
        if (this.failure === "stale-override") this.failure = null;
      }
      this.startupRecovery = false;
      return true;
    } catch (error) {
      this.failure = "stale-override";
      this.d.log(error);
      return false;
    } finally {
      // A fenced but failed reset needs a watchdog for this process's lifetime.
      if (this.marker && this.startupRecovery && !this.invalidMarker && fenced) {
        try {
          if (!(await this.d.ownership.watchdogAlive(this.marker)))
            this.marker = await this.d.ownership.armWatchdog({
              ...this.marker,
              ownerPid: process.pid,
              ownerStart: (await this.d.ownership.newMarker()).ownerStart,
            });
        } catch (error) {
          this.d.log(error);
        }
      }
    }
  }
  private async reconcileLid() {
    if (this.d.platform !== "darwin") return;
    if (!(await this.recoverStartup())) return;
    if (!this.lidDemand() && !this.marker) {
      this.thermalHold = false;
      this.batteryHold = false;
      this.batteryUnknown = false;
      this.external = false;
      this.readFailed = false;
      return;
    }
    await this.guards();
    this.sleepDisabled = await this.d.power.readSleepDisabled();
    this.readFailed = this.sleepDisabled === null;
    if (this.marker && this.sleepDisabled === 0) {
      const unresolved =
        this.resetVerified || this.failure === "reset-failed" || this.failure === "stale-override";
      await this.clearOwnership();
      this.suppressed = !unresolved && this.lidDemand();
    }
    this.external = !this.marker && this.sleepDisabled === 1;
    const desired =
      this.lidDemand() &&
      this.permission !== "missing" &&
      !this.batteryHold &&
      !this.batteryUnknown &&
      !this.thermalHold &&
      !this.suppressed &&
      !this.external &&
      !this.failure;
    if (this.marker) {
      if (!desired || this.sleepDisabled === null)
        await this.reset(this.failure === "stale-override");
      this.scheduleDisplay();
      return;
    }
    if (!desired) return;
    if (this.sleepDisabled !== 0) {
      return;
    }
    const epoch = this.epoch;
    try {
      this.marker = await this.d.ownership.newMarker();
      await this.d.ownership.write(this.marker);
      this.marker = await this.d.ownership.armWatchdog(this.marker);
    } catch (error) {
      await this.clearOwnership();
      this.failure = "command-failed";
      this.d.log(error);
      return;
    }
    if (this.disposed || epoch !== this.epoch || !this.lidDemand()) {
      await this.clearOwnership();
      return;
    }
    // pmset has no compare-and-swap: another power utility can race the read
    // above and this write. Coexistence checks cannot eliminate that OS race.
    const result = await this.d.power.setSleepDisabled(1);
    this.sleepDisabled = result === "ok" ? 1 : await this.d.power.readSleepDisabled();
    if (result !== "ok") {
      if (result === "denied") {
        await this.refreshPermission();
        // The actual command denial is authoritative over sudo's list probe.
        this.permission = "missing";
      }
      if (this.sleepDisabled === 0) await this.clearOwnership();
      else await this.reset();
      if (!this.marker) this.failure = result === "denied" ? null : "command-failed";
    } else if (epoch !== this.epoch || !this.lidDemand()) await this.reset();
    this.scheduleDisplay();
  }
  private scheduleDisplay() {
    if (
      this.displayTimer ||
      this.displayDone ||
      !this.marker ||
      this.disposed ||
      this.d.environment.hasExternalDisplay()
    )
      return;
    this.displayTimer = setTimeout(() => {
      this.displayTimer = undefined;
      if (this.disposed || !this.marker || this.d.environment.hasExternalDisplay()) return;
      const epoch = this.epoch;
      void this.d.power
        .readLidClosed()
        .then(async (closed) => {
          if (
            this.disposed ||
            epoch !== this.epoch ||
            !this.marker ||
            this.d.environment.hasExternalDisplay()
          )
            return;
          if (closed) {
            this.displayDone = true;
            await this.d.power.displaySleepNow();
          } else this.scheduleDisplay();
        })
        .catch(this.d.log);
    }, 5000);
  }
  userActive() {
    this.displayDone = false;
    this.scheduleDisplay();
  }
  powerChanged() {
    if (!this.disposed) void this.enqueue(() => this.reconcileLid());
  }
  private async tick() {
    if (this.disposed) return;
    const epoch = this.epoch;
    if (this.prefs.mode === "agents") {
      const count = await this.d.pollDemand().catch(() => 0);
      if (epoch === this.epoch && !this.disposed) {
        this.busy = count;
        if (count > 0) this.cooldown = this.d.now() + COOLDOWN_MS;
      }
    }
    if (this.disposed) return;
    if (!this.activeDemand()) this.suppressed = false;
    this.idle();
    const lidDemand = this.lidDemand();
    const released = this.previousLidDemand && !lidDemand;
    this.previousLidDemand = lidDemand;
    if (
      (lidDemand || this.marker || this.startupRecovery) &&
      (released || this.d.now() - this.lastMaintenance >= MAINTENANCE_MS) &&
      !this.maintenanceQueued
    ) {
      this.lastMaintenance = this.d.now();
      this.maintenanceQueued = true;
      void this.enqueue(() => this.reconcileLid()).finally(() => {
        this.maintenanceQueued = false;
      });
    }
    this.publish();
    if (!this.disposed)
      this.timer = setTimeout(() => {
        void this.tick();
      }, AGENT_POLL_MS);
  }
  async setPreferences(input: Partial<Preferences>) {
    if (this.disposed) throw new Error("Keep awake is closed");
    this.epoch++;
    const previousMode = this.prefs.mode;
    this.prefs = { ...this.prefs, ...input };
    this.suppressed = false;
    this.blockerFailed = false;
    if (!this.marker) this.failure = null;
    if (previousMode !== this.prefs.mode) {
      this.busy = 0;
      this.cooldown = null;
    }
    this.idle();
    this.publish();
    const saved = this.d.save(this.prefs).then(
      () => null,
      (error: unknown) => error,
    );
    await this.enqueue(async () => {
      if (input.closedLid === true && this.d.platform === "darwin") await this.refreshPermission();
      await this.reconcileLid();
    });
    const saveError = await saved;
    if (saveError !== null) {
      this.d.log(saveError);
      throw new Error("Keep awake changed, but preferences could not be saved.");
    }
    return this.getState();
  }
  async changePermission(install: boolean) {
    if (this.disposed || this.permissionOperation || this.d.platform !== "darwin")
      throw new Error("Permission operation unavailable");
    this.permissionOperation = true;
    this.epoch++;
    try {
      await this.enqueue(async () => {
        if (!install && this.marker && !(await this.reset())) return;
        if (this.disposed) return;
        const result = await (install ? this.d.power.installRule() : this.d.power.removeRule());
        if (result === "failed") {
          this.setupFailed = true;
          this.failure = "command-failed";
        } else if (result === "ok" && this.setupFailed) {
          this.setupFailed = false;
          if (this.failure === "command-failed") this.failure = null;
        }
        await this.refreshPermission();
        if (!this.disposed && install) await this.reconcileLid();
      });
    } finally {
      this.permissionOperation = false;
    }
    return this.getState();
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.displayTimer);
    // Check recovery immediately, including when the serialized queue is stuck in
    // a command. Never extend the quit deadline to wait for a command reply.
    const recovery = this.ensureWatchdog();
    const final = this.enqueue(async () => {
      if (this.marker) await this.reset();
    });
    let cap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([final, recovery]),
      new Promise<void>((resolve) => {
        cap = setTimeout(resolve, 4000);
      }),
    ]);
    clearTimeout(cap);
    this.idle();
    this.publish();
  }
  private async ensureWatchdog() {
    const marker = this.marker;
    if (marker?.watchdogPid === 0) return; // The in-flight arm owns commitment and cleanup.
    if (
      marker &&
      !(await this.d.ownership.watchdogAlive(marker)) &&
      this.marker?.gen === marker.gen
    ) {
      try {
        const armed = await this.d.ownership.armWatchdog(marker);
        // Reset may have completed while the watchdog was arming.
        if (this.marker?.gen === marker.gen) this.marker = armed;
        else {
          await this.d.ownership.remove();
          await this.d.ownership.killWatchdog(armed);
        }
      } catch (error) {
        this.d.log(error);
      }
    }
  }
}
