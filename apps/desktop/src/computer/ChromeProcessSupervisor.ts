import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChromeProcessRegistration } from "@t3tools/contracts";

export interface ChromeProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Epoch milliseconds, one-second resolution; undefined when its column was unreadable. */
  readonly startTime: number | undefined;
  /** Zombies can no longer act. */
  readonly zombie: boolean;
}
export interface ChromeProcessIo {
  /** Every process on the machine, or null when the listing could not be read. */
  readonly snapshot: () => Promise<ReadonlyArray<ChromeProcessRow> | null>;
  readonly killGroup: (pgid: number, signal: NodeJS.Signals) => void;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*?)\s*$/;
const LSTART = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

function parseStart(text: string): number | undefined {
  const match = LSTART.exec(text);
  const month = match ? MONTHS.indexOf(match[1]!) : -1;
  if (!match || month < 0) return undefined;
  return Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
}

/**
 * Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=` run with `TZ=UTC`. `lstart` carries no
 * zone, so it is read explicitly as UTC rather than through `Date.parse` (local time).
 * A row whose start column is unreadable is kept without a start time: it still counts
 * as a member of its group, so it can only keep a group alive. A row whose IDs are
 * unreadable could belong to any group, so it makes the whole listing unknown.
 */
export function parseProcessListing(stdout: string): ChromeProcessRow[] | null {
  const rows: ChromeProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = PS_ROW.exec(line);
    if (!match) return null;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      zombie: match[4]!.startsWith("Z"),
      startTime: parseStart(match[5]!),
    });
  }
  return rows.length ? rows : null;
}

/** `ps` is read by main (outside the backend sandbox). */
export const defaultChromeProcessIo: ChromeProcessIo = {
  snapshot: () =>
    new Promise((resolve) => {
      execFile(
        "/bin/ps",
        ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="],
        { timeout: 2000, maxBuffer: 16 * 1024 * 1024, env: { LC_ALL: "C", TZ: "UTC" } },
        (error, stdout) => resolve(error ? null : parseProcessListing(stdout)),
      );
    }),
  killGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Already gone.
    }
  },
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
};

type GroupState = "alive" | "gone" | "unknown";
/**
 * Positive evidence only. A group is gone when no non-zombie process remains in it, or when
 * its leader's PID now belongs to a different process: the kernel never reuses a PID while
 * a process group with that ID still exists. Surviving descendants keep the group alive.
 */
function groupState(
  rows: ReadonlyArray<ChromeProcessRow> | null,
  pgid: number,
  observedStart: number,
): GroupState {
  if (!rows) return "unknown";
  const leader = rows.find((row) => row.pid === pgid);
  if (leader?.startTime !== undefined && leader.startTime !== observedStart) return "gone";
  return rows.some((row) => row.pgid === pgid && !row.zombie) ? "alive" : "gone";
}
function descendsFrom(rows: ReadonlyArray<ChromeProcessRow>, pid: number, ancestor: number) {
  let current = rows.find((row) => row.pid === pid);
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (current.ppid === ancestor) return true;
    if (current.ppid <= 1) return false;
    const parent = current.ppid;
    current = rows.find((row) => row.pid === parent);
  }
  return false;
}

interface Entry {
  readonly registration: ChromeProcessRegistration;
  /** Start time main observed at registration; every signal re-checks it. */
  readonly observedStart: number;
  /** Registration order; a listing started before it can't speak for this entry. */
  readonly seq: number;
  exited: boolean;
  timers: unknown[];
  /** `stopAndWait` callers, resolved on exit or on entering recovery. */
  waiters: Array<() => void>;
}
interface PersistedRecovery {
  readonly registration: ChromeProcessRegistration;
  readonly observedStart: number;
  /** Signalled at least once by this run; later signals are SIGKILL. */
  signalled?: boolean;
}
export type ChromeStopReason = "emergency" | "unresponsive" | "shutdown" | "release";

const START_TOLERANCE_MS = 5_000;
const POLL_MS = 250;
const IDLE_POLL_MS = 2_000;
export const CHROME_EXIT_DEADLINE_MS = 5_000;
const generationKey = (profileId: string, threadId: string, generation: string) =>
  `${profileId}\0${threadId}\0${generation}`;

/**
 * Main-owned stop for provider-integration children. Main signals only groups led by a
 * verified descendant of the registering backend, never a process whose start time
 * differs from the one it observed (PID reuse), and never Chrome itself, unrelated native
 * hosts or terminal Claude. A group counts as stopped only on positive evidence that no
 * member remains; an unreadable listing keeps ownership. A group whose exit is not
 * observed in time becomes `recovery-required`, persisted so a desktop restart cannot
 * assume control ended.
 */
export class ChromeProcessSupervisor {
  private readonly entries = new Map<string, Entry>();
  private recovery: PersistedRecovery[] = [];
  /** Generations stopped by the emergency shortcut, refused until the user resumes. */
  private readonly invalidatedGenerations = new Set<string>();
  /** Registrations still being verified, with the stop that reached them meanwhile. */
  private readonly pending = new Map<
    string,
    { readonly registration: ChromeProcessRegistration; stoppedBy?: ChromeStopReason }
  >();
  private registrationSeq = 0;
  private polling: unknown;
  constructor(
    private readonly options: {
      readonly io?: ChromeProcessIo;
      readonly statePath?: string;
      readonly registered?: (registration: ChromeProcessRegistration) => void;
      /** A registered group exited (or was found exited). */
      readonly exited?: (registration: ChromeProcessRegistration) => void;
      readonly recoveryChanged?: (recoveryRequired: boolean) => void;
    } = {},
  ) {
    this.loadRecovery();
  }
  private get io(): ChromeProcessIo {
    return this.options.io ?? defaultChromeProcessIo;
  }

  /** `ancestorPid` is the registering backend's process, which main spawned. */
  async register(registration: ChromeProcessRegistration, ancestorPid: number): Promise<void> {
    if (this.recoveryRequired())
      throw new Error("A previous browser-control process has not exited yet.");
    if (
      this.invalidated(
        registration.profileId,
        registration.threadId,
        registration.sessionGeneration,
      )
    )
      throw new Error("Computer control was stopped for this session. Resume it first.");
    if (registration.pgid !== registration.pid)
      throw new Error("Integration processes must lead their own process group.");
    const token = registration.launchToken;
    if (this.entries.has(token) || this.pending.has(token))
      throw new Error("Duplicate launch token.");
    // A stop that runs while `ps` is read must still reach this process.
    const pending: {
      readonly registration: ChromeProcessRegistration;
      stoppedBy?: ChromeStopReason;
    } = { registration };
    this.pending.set(token, pending);
    let rows: ReadonlyArray<ChromeProcessRow> | null;
    try {
      rows = await this.io.snapshot();
    } finally {
      this.pending.delete(token);
    }
    const leader = rows?.find((row) => row.pid === registration.pid);
    if (
      !rows ||
      !leader ||
      leader.zombie ||
      leader.pgid !== registration.pgid ||
      leader.startTime === undefined ||
      Math.abs(leader.startTime - registration.startTime) > START_TOLERANCE_MS ||
      // Main never signals a group the backend could not have started itself.
      !descendsFrom(rows, registration.pid, ancestorPid)
    )
      throw new Error("The integration process could not be verified.");
    this.entries.set(token, {
      registration,
      observedStart: leader.startTime,
      seq: ++this.registrationSeq,
      exited: false,
      timers: [],
      waiters: [],
    });
    if (pending.stoppedBy) {
      // Verified, so main stops it itself rather than relying on the server to.
      this.persist();
      this.stop((entry) => entry.launchToken === token, pending.stoppedBy);
      throw new Error("Computer control was stopped for this session. Resume it first.");
    }
    if (this.recoveryRequired()) {
      this.entries.delete(token);
      throw new Error("A previous browser-control process has not exited yet.");
    }
    try {
      // The host may veto (for example when the emergency shortcut is unavailable).
      this.options.registered?.(registration);
    } catch (error) {
      this.entries.delete(registration.launchToken);
      throw error;
    }
    // Persisted while alive, so a crashed desktop finds and stops it on the next launch.
    this.persist();
    this.schedulePoll();
  }

  registrations(filter: (registration: ChromeProcessRegistration) => boolean = () => true) {
    return [...this.entries.values()]
      .filter((entry) => !entry.exited && filter(entry.registration))
      .map((entry) => entry.registration);
  }
  alive(filter: (registration: ChromeProcessRegistration) => boolean): boolean {
    return this.registrations(filter).length > 0;
  }
  recoveryRequired(): boolean {
    return this.recovery.length > 0;
  }
  invalidated(profileId: string, threadId: string, generation: string): boolean {
    return this.invalidatedGenerations.has(generationKey(profileId, threadId, generation));
  }
  /** The user resumed the thread: its stopped generations may register again. */
  resumed(profileId: string, threadId: string): void {
    const prefix = `${profileId}\0${threadId}\0`;
    for (const key of this.invalidatedGenerations)
      if (key.startsWith(prefix)) this.invalidatedGenerations.delete(key);
  }

  /**
   * Emergency and unresponsive stops signal SIGTERM now and SIGKILL after 1 s; shutdown
   * and release allow a 2 s grace first. Missing the exit deadline means recovery. An
   * emergency stop also invalidates each affected generation until the user resumes.
   */
  stop(
    filter: (registration: ChromeProcessRegistration) => boolean,
    reason: ChromeStopReason,
  ): ChromeProcessRegistration[] {
    const io = this.io;
    const grace = reason === "shutdown" || reason === "release" ? 2_000 : 0;
    const stopped: ChromeProcessRegistration[] = [];
    for (const pending of this.pending.values()) {
      if (!filter(pending.registration)) continue;
      // Urgent stops win over graceful ones, as for registered entries.
      if (!pending.stoppedBy || !grace) pending.stoppedBy = reason;
      if (reason === "emergency")
        this.invalidatedGenerations.add(
          generationKey(
            pending.registration.profileId,
            pending.registration.threadId,
            pending.registration.sessionGeneration,
          ),
        );
    }
    for (const entry of this.entries.values()) {
      if (entry.exited || !filter(entry.registration)) continue;
      stopped.push(entry.registration);
      if (reason === "emergency")
        this.invalidatedGenerations.add(
          generationKey(
            entry.registration.profileId,
            entry.registration.threadId,
            entry.registration.sessionGeneration,
          ),
        );
      if (entry.timers.length) {
        // An urgent stop replaces a graceful one already in progress.
        if (grace) continue;
        for (const timer of entry.timers) io.clearTimeout(timer);
        entry.timers = [];
      }
      const term = () => void this.signal(entry, "SIGTERM");
      if (grace) entry.timers.push(io.setTimeout(term, grace));
      else term();
      entry.timers.push(io.setTimeout(() => void this.signal(entry, "SIGKILL"), grace + 1_000));
      entry.timers.push(
        io.setTimeout(
          () => {
            if (!entry.exited) this.enterRecovery(entry);
          },
          Math.max(CHROME_EXIT_DEADLINE_MS, grace + 1_000 + POLL_MS * 2),
        ),
      );
    }
    this.reschedulePoll();
    return stopped;
  }

  /**
   * `stop`, then wait until every selected group has exited or been persisted as
   * `recovery-required`. Quitting awaits this so no group outlives F5 untracked.
   */
  async stopAndWait(
    filter: (registration: ChromeProcessRegistration) => boolean,
    reason: ChromeStopReason,
  ): Promise<void> {
    const stopped = this.stop(filter, reason);
    await Promise.all(
      stopped.map((registration) => {
        const entry = this.entries.get(registration.launchToken);
        if (!entry || entry.exited || this.inRecovery(registration.launchToken))
          return Promise.resolve();
        return new Promise<void>((resolve) => entry.waiters.push(resolve));
      }),
    );
  }
  private inRecovery(launchToken: string): boolean {
    return this.recovery.some((persisted) => persisted.registration.launchToken === launchToken);
  }
  private settleWaiters(entry: Entry): void {
    for (const resolve of entry.waiters.splice(0)) resolve();
  }

  /** The backend reports an exit; main confirms it before acting on it. */
  reportedExit(launchToken: string): void {
    const entry = this.entries.get(launchToken);
    if (entry && !entry.exited) void this.check(entry);
  }

  private async signal(entry: Entry, signal: NodeJS.Signals): Promise<void> {
    if (entry.exited) return;
    const state = groupState(
      await this.io.snapshot(),
      entry.registration.pgid,
      entry.observedStart,
    );
    if (state === "gone") return this.markExited(entry);
    // An unreadable listing never authorizes a signal; the deadline enters recovery.
    if (state === "alive") this.io.killGroup(entry.registration.pgid, signal);
  }

  private async check(entry: Entry): Promise<void> {
    const rows = await this.io.snapshot();
    if (groupState(rows, entry.registration.pgid, entry.observedStart) === "gone")
      this.markExited(entry);
  }

  private markExited(entry: Entry): void {
    if (entry.exited) return;
    entry.exited = true;
    for (const timer of entry.timers) this.io.clearTimeout(timer);
    entry.timers = [];
    this.entries.delete(entry.registration.launchToken);
    this.recovery = this.recovery.filter(
      (persisted) => persisted.registration.launchToken !== entry.registration.launchToken,
    );
    this.persist();
    this.settleWaiters(entry);
    this.options.exited?.(entry.registration);
  }

  private enterRecovery(entry: Entry): void {
    if (!this.inRecovery(entry.registration.launchToken)) {
      // Already signalled by its stop; the poll keeps sending SIGKILL until it is gone.
      this.recovery.push({
        registration: entry.registration,
        observedStart: entry.observedStart,
        signalled: true,
      });
      this.persist();
    }
    this.settleWaiters(entry);
  }

  /** Fast while a stop is in progress or recovery is pending, slow otherwise. */
  private pollInterval(): number {
    const stopping = [...this.entries.values()].some((entry) => entry.timers.length > 0);
    return stopping || this.recovery.length ? POLL_MS : IDLE_POLL_MS;
  }
  private schedulePoll(): void {
    if (this.polling !== undefined) return;
    if (!this.entries.size && !this.recovery.length) return;
    this.polling = this.io.setTimeout(() => {
      this.polling = undefined;
      void this.poll();
    }, this.pollInterval());
  }
  private reschedulePoll(): void {
    if (this.polling !== undefined) this.io.clearTimeout(this.polling);
    this.polling = undefined;
    this.schedulePoll();
  }
  private async poll(): Promise<void> {
    // A process registered while `ps` ran may be missing from its rows: that is no
    // evidence of exit, so only entries registered before the listing started are judged.
    const seen = this.registrationSeq;
    const rows = await this.io.snapshot();
    for (const entry of this.entries.values())
      if (
        entry.seq <= seen &&
        groupState(rows, entry.registration.pgid, entry.observedStart) === "gone"
      )
        this.markExited(entry);
    // Recovery entries (including a previous run's orphans) are stopped by main itself:
    // SIGTERM first, then SIGKILL, and only while the start time still matches.
    const remaining = this.recovery.filter((persisted) => {
      const state = groupState(rows, persisted.registration.pgid, persisted.observedStart);
      if (state === "alive") {
        this.io.killGroup(persisted.registration.pgid, persisted.signalled ? "SIGKILL" : "SIGTERM");
        persisted.signalled = true;
      }
      return this.entries.has(persisted.registration.launchToken) || state !== "gone";
    });
    if (remaining.length !== this.recovery.length) {
      this.recovery = remaining;
      this.persist();
    }
    this.schedulePoll();
  }

  /**
   * A previous run's live registrations are orphans: their backend is gone, so nothing
   * else will stop them. They join recovery (blocking Chrome) until the poll has seen
   * them gone.
   */
  private loadRecovery(): void {
    if (!this.options.statePath) return;
    const valid = (persisted: PersistedRecovery) =>
      typeof persisted?.observedStart === "number" &&
      typeof persisted.registration?.pgid === "number" &&
      typeof persisted.registration.launchToken === "string";
    try {
      const parsed = JSON.parse(readFileSync(this.options.statePath, "utf8")) as {
        recovery?: PersistedRecovery[];
        live?: PersistedRecovery[];
      };
      const restored = new Map<string, PersistedRecovery>();
      for (const persisted of [
        ...(Array.isArray(parsed.recovery) ? parsed.recovery : []),
        ...(Array.isArray(parsed.live) ? parsed.live : []),
      ])
        if (valid(persisted))
          restored.set(persisted.registration.launchToken, {
            registration: persisted.registration,
            observedStart: persisted.observedStart,
          });
      this.recovery = [...restored.values()];
    } catch {
      this.recovery = [];
    }
    if (this.recovery.length) {
      this.persist();
      this.schedulePoll();
    }
  }
  private persist(): void {
    if (this.options.statePath) {
      try {
        mkdirSync(dirname(this.options.statePath), { recursive: true });
        const temporary = `${this.options.statePath}.${process.pid}.tmp`;
        writeFileSync(
          temporary,
          JSON.stringify({
            recovery: this.recovery.map(({ registration, observedStart }) => ({
              registration,
              observedStart,
            })),
            live: [...this.entries.values()]
              .filter((entry) => !entry.exited)
              .map(({ registration, observedStart }) => ({ registration, observedStart })),
          }),
        );
        renameSync(temporary, this.options.statePath);
      } catch {
        // In-memory state still refuses ownership for this run.
      }
    }
    this.options.recoveryChanged?.(this.recoveryRequired());
  }
}
