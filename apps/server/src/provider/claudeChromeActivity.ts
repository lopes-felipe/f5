import { CLAUDE_CHROME_IDLE_MS } from "@t3tools/shared/providerIntegrationCertification";

export { CLAUDE_CHROME_IDLE_MS };
export const CLAUDE_CHROME_STOPPED_IDLE =
  "Stopped while idle to free Chrome. Chrome control restarts with your next message.";
export const CLAUDE_CHROME_RELEASED =
  "Released while idle so another thread could use Chrome. Chrome control restarts with your next message.";

export interface ClaudeChromeActivityDeps {
  /** Whether a Claude in Chrome call is running, for the banner and for preemption. */
  readonly reportCalls: (running: boolean) => void;
  /** Stops the session, which releases the lease once main sees the CLI exit. */
  readonly stop: (reason: string) => void;
  readonly idleMs?: number;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/**
 * Tracks a Chrome-enabled Claude session's turns and Chrome calls. The Chrome lease lives
 * as long as the CLI, so between turns, with no call running, the session is idle: it is
 * stopped after `CLAUDE_CHROME_IDLE_MS`, or at once when another thread needs Chrome.
 */
export class ClaudeChromeActivity {
  private readonly calls = new Set<string>();
  private turnActive = false;
  private disposed = false;
  private timer: unknown;

  constructor(private readonly deps: ClaudeChromeActivityDeps) {
    deps.reportCalls(false);
    this.arm();
  }

  /** Between turns, no Chrome call running, and not yet stopped. */
  get idle(): boolean {
    return !this.disposed && !this.turnActive && this.calls.size === 0;
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

  /** Another thread needs Chrome, or the user released it: stop only while idle. */
  release(): boolean {
    if (!this.idle) return false;
    this.finish(CLAUDE_CHROME_RELEASED);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private finish(reason: string): void {
    this.dispose();
    this.deps.stop(reason);
  }

  private arm(): void {
    this.clear();
    if (!this.idle) return;
    const set = this.deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.timer = set(() => {
      this.timer = undefined;
      if (this.idle) this.finish(CLAUDE_CHROME_STOPPED_IDLE);
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
