import { CLAUDE_CHROME_IDLE_MS } from "@t3tools/shared/providerIntegrationCertification";

export { CLAUDE_CHROME_IDLE_MS };
export const CLAUDE_CHROME_STOPPED_IDLE =
  "Stopped while idle to free Chrome. Chrome control restarts with your next message.";
export const CLAUDE_CHROME_RELEASED =
  "Released while idle so another thread could use Chrome. Chrome control restarts with your next message.";

/** Tools whose work runs later inside the CLI: a session that used one is never idle. */
export const CLAUDE_SCHEDULING_TOOLS: ReadonlySet<string> = new Set([
  "ScheduleWakeup",
  "CronCreate",
]);

/**
 * Work a Claude session runs outside a turn that stopping its CLI would kill: a native
 * operation such as `/compact`, background agents the CLI reported, tasks (shells,
 * monitors, subagents) not yet terminal, and wake-ups or cron jobs it scheduled.
 */
export function claudeSessionBackgroundBusy(state: {
  readonly nativeControl?: unknown;
  readonly lifecycle: { readonly backgroundTasks: ReadonlySet<string> };
  readonly taskStates: ReadonlyMap<string, unknown>;
  readonly chromeScheduledWork?: boolean | undefined;
}): boolean {
  return (
    state.nativeControl !== undefined ||
    state.lifecycle.backgroundTasks.size > 0 ||
    state.taskStates.size > 0 ||
    state.chromeScheduledWork === true
  );
}

export interface ClaudeChromeActivityDeps {
  /** Whether a Claude in Chrome call is running, for the banner and for preemption. */
  readonly reportCalls: (running: boolean) => void;
  /**
   * Stops the session, which releases the lease once main sees the CLI exit. Answers
   * whether the stop went ahead: the session re-checks under its lock and may refuse.
   */
  readonly stop: (reason: string) => boolean | Promise<boolean>;
  /**
   * Work the CLI runs outside a turn (compaction, background tasks, scheduled wake-ups).
   * Stopping the session would kill it, so the session isn't idle while this is true.
   */
  readonly busy?: () => boolean;
  readonly idleMs?: number;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/**
 * Tracks a Chrome-enabled Claude session's turns, Chrome calls and background work. The
 * Chrome lease lives as long as the CLI, so between turns, with no call or background work
 * running, the session is idle: it is stopped after `CLAUDE_CHROME_IDLE_MS`, or at once
 * when another thread needs Chrome.
 */
export class ClaudeChromeActivity {
  private readonly calls = new Set<string>();
  private turnActive = false;
  private disposed = false;
  /** A stop is in flight; it either ends the session or is refused and tracking resumes. */
  private stopping = false;
  private timer: unknown;

  constructor(private readonly deps: ClaudeChromeActivityDeps) {
    deps.reportCalls(false);
    this.arm();
  }

  /** Between turns, no Chrome call or background work running, and not stopping. */
  get idle(): boolean {
    return this.quiet && !(this.deps.busy?.() ?? false);
  }

  /** Idle as far as turns and Chrome calls go; background work is checked separately. */
  private get quiet(): boolean {
    return !this.disposed && !this.stopping && !this.turnActive && this.calls.size === 0;
  }

  turnStarted(): void {
    this.turnActive = true;
    this.clear();
  }

  /** The turn completed, failed or was interrupted: its calls ended with it. */
  turnEnded(): void {
    this.turnActive = false;
    if (this.calls.size > 0) {
      this.calls.clear();
      if (!this.disposed) this.deps.reportCalls(false);
    }
    this.arm();
  }

  callStarted(toolUseId: string): void {
    if (this.disposed) return;
    this.clear();
    const first = this.calls.size === 0;
    this.calls.add(toolUseId);
    if (first) this.deps.reportCalls(true);
  }

  callEnded(toolUseId: string): void {
    if (!this.calls.delete(toolUseId)) return;
    if (this.calls.size === 0 && !this.disposed) this.deps.reportCalls(false);
    this.arm();
  }

  /**
   * Another thread needs Chrome, or the user released it: stop only while idle. Answers
   * whether the session stopped; `false` at once when it is busy.
   */
  release(): boolean | Promise<boolean> {
    if (!this.idle) return false;
    return this.finish(CLAUDE_CHROME_RELEASED);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /** Tracking stops only once the session accepted the stop; a refusal resumes it. */
  private async finish(reason: string): Promise<boolean> {
    this.stopping = true;
    this.clear();
    let accepted = false;
    try {
      accepted = await this.deps.stop(reason);
    } catch {
      accepted = false;
    }
    this.stopping = false;
    if (accepted) this.dispose();
    else this.arm();
    return accepted;
  }

  private arm(): void {
    this.clear();
    if (!this.quiet) return;
    const set = this.deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.timer = set(() => {
      this.timer = undefined;
      if (this.idle) void this.finish(CLAUDE_CHROME_STOPPED_IDLE);
      // Background work has no end event here: look again after another idle window.
      else this.arm();
    }, this.deps.idleMs ?? CLAUDE_CHROME_IDLE_MS);
  }

  private clear(): void {
    if (this.timer === undefined) return;
    const clear =
      this.deps.clearTimeout ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clear(this.timer);
    this.timer = undefined;
  }
}
