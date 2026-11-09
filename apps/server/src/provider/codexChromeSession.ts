import { randomUUID } from "node:crypto";
import type { AgentCapabilityState } from "@t3tools/contracts";
import {
  CHROME_OWN_CALL_RUNNING_MESSAGE,
  CHROME_OWN_STOPPING_MESSAGE,
} from "@t3tools/shared/computerControl";
import {
  CODEX_CHROME_DRAIN_TOOL,
  CODEX_CHROME_IDLE_MS,
} from "@t3tools/shared/providerIntegrationCertification";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import {
  codexChromeInstallationUnchanged,
  codexChromeRegistrationsUnchanged,
  inspectCodexChrome,
  type CodexChromeInstallation,
} from "../computer/codexNativeIntegrations";
import { toolInventorySha256, type IntegrationTool } from "../mcp/IntegrationProxyCatalog";
import { CodexControlHandoff, waitForControl, handoffError } from "../computer/CodexControlHandoff";
import { computerRemainingBudget, computerWithinDeadline } from "../computer/computerDeadline";

export { CODEX_CHROME_IDLE_MS };
/** How long a turn waits for its runtime to be supervised before stopping it for the turn. */
export const CODEX_CHROME_RESTART_WAIT_MS = 20_000;
/** Lease and adoption replies from desktop main. */
const HOST_TIMEOUT_MS = 5_000;

export const CODEX_CHROME_STOPPED_IDLE =
  "Stopped while idle. Chrome control restarts with your next message.";
export const CODEX_CHROME_STOPPED_PAUSED =
  "Paused. Chrome control restarts with your next message after you resume.";
export const CODEX_CHROME_STOPPED_OFF = "Turned off for this thread.";
export const CODEX_CHROME_STOPPED_RELEASED =
  "Released while idle so another thread could use Chrome. Chrome control restarts with your next message.";
export const CODEX_CHROME_STOPPED_INTERRUPTED =
  "Stopped with the interrupted turn. Chrome control restarts with your next message.";
export const CODEX_CHROME_START_TIMED_OUT =
  "Chrome control didn't start in time, so it's off for this message. It restarts with your next message.";
export const CODEX_CHROME_INVENTORY_CHANGED =
  "The ChatGPT browser runtime's tools changed since F5 certified them. Update F5.";

/** What the session needs from the Codex app-server it runs under. */
export interface CodexChromeCodex {
  /** The session's `codex app-server` process, `node_repl`'s parent. */
  readonly pid: () => number | undefined;
  /** `node_repl`'s row from `mcpServerStatus/list`, or undefined when it can't be listed. */
  readonly listServer: () => Promise<unknown>;
  /** `config/mcpServer/reload`, which starts a new `node_repl`. */
  readonly reload: () => Promise<void>;
  /** `mcpServer/tool/call` on `node_repl`, outside the model's turn. */
  readonly callTool: (
    tool: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Codex's thread id: the `session_id` its turn metadata names. */
  readonly providerThreadId: () => string | undefined;
}

/** The broker surface the session uses. */
export type CodexChromeBroker = Pick<
  ComputerAutomationBrokerRuntime,
  | "host"
  | "pause"
  | "generation"
  | "chromeRecoveryRequired"
  | "adoptIntegrationProcess"
  | "stopIntegrationProcess"
  | "reportChromeCalls"
  | "onChromeDisabled"
  | "acquireChromeLease"
  | "registerChromeReleaser"
  | "registerCodexHandoff"
  | "waitForChromeRelease"
  | "prepareCodexBrowser"
>;

export interface CodexChromeSessionDeps {
  readonly threadId: string;
  readonly generation: string;
  readonly installation: CodexChromeInstallation;
  readonly userHome: string;
  readonly broker: CodexChromeBroker;
  readonly codex: CodexChromeCodex;
  readonly policyEnabled: () => Promise<boolean>;
  readonly stateChanged: (state: AgentCapabilityState, detail?: string) => void;
  readonly inspect?: typeof inspectCodexChrome;
  readonly registrationsUnchanged?: (installation: CodexChromeInstallation) => Promise<boolean>;
  /** Overrides `CODEX_CHROME_RESTART_WAIT_MS` (tests). */
  readonly startWaitMs?: number;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Older provider threads cannot acquire new dynamic tools on resume. */
  readonly supportsBrowserResume?: () => boolean;
  readonly waitForMcpIdle?: (deadline: number, check: () => Promise<void>) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Tools from a `mcpServerStatus/list` row, whichever schema key Codex used. */
export function listedTools(row: unknown): IntegrationTool[] | undefined {
  const tools = record(record(row)?.tools);
  if (!tools) return undefined;
  const listed: IntegrationTool[] = [];
  for (const [key, value] of Object.entries(tools)) {
    const tool = record(value);
    if (!tool) return undefined;
    listed.push({
      name: typeof tool.name === "string" ? tool.name : key,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema ?? tool.input_schema,
    });
  }
  return listed;
}

/**
 * Codex Chrome in session admission. Codex starts ChatGPT's `node_repl` itself, because
 * ChatGPT's Chrome host serves only a runtime whose parent is a signed Codex, and Codex asks
 * no approval for its calls in Full access. So F5 controls the runtime, not single calls:
 * consent was given before the session's MCP config was built, desktop main adopts the
 * process Codex started and alone signals it, the inventory Codex lists must match the
 * record, and the Chrome lease is held for the runtime's life. Pause, ⌃⌘Esc (via pause),
 * turning the integration off, a new session generation and `CODEX_CHROME_IDLE_MS` after
 * a turn ends stop the process; the next turn reloads Codex's MCP config, which starts a
 * new one, and adoption runs again. A runtime that isn't supervised when a turn starts is
 * stopped rather than left reachable.
 */
export class CodexChromeSession {
  private readonly handoff = new CodexControlHandoff();
  private parked = false;
  /** Until the host tool has worked in this backend, retain next-message recovery. */
  private browserResumeProven = false;
  private unavailableDetail?: string;
  private disabled = false;
  private phase: "starting" | "ready" | "stopped" | "unavailable" | "disposed" = "starting";
  /** Bumped by every stop, so an adoption that finishes after one is undone. */
  private epoch = 0;
  /** Set before main is asked to adopt, so a stop reaches a runtime main adopts late. */
  private launchToken: string | undefined;
  private leaseHeld = false;
  private idleTimer: unknown;
  /** Between `beforeTurn` and the turn's end: the runtime is never idle-stopped then. */
  private turnActive = false;
  private adoption: Promise<void> | undefined;
  private readoption: Promise<void> | undefined;
  /** Resolves `beforeTurn`'s wait once the pending start settles. */
  private settleStart: (() => void) | undefined;
  private drained = new Set<string>();
  /** The model's `node_repl` calls Codex reported started and not yet completed. */
  private readonly calls = new Set<string>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: CodexChromeSessionDeps) {
    this.unsubscribe.push(
      deps.broker.pause.subscribe((threadId, paused) => {
        if (paused && threadId === deps.threadId) this.stop("pending", CODEX_CHROME_STOPPED_PAUSED);
      }),
      deps.broker.onChromeDisabled((threadId, generation) => {
        if (threadId === deps.threadId && generation === deps.generation) {
          this.disabled = true;
          this.stop("off", CODEX_CHROME_STOPPED_OFF);
        }
      }),
      // Another thread needs Chrome (or the user pressed Release): give way only while idle.
      deps.broker.registerChromeReleaser(deps.threadId, deps.generation, {
        idle: () => this.idle,
        release: () => {
          if (!this.idle) return false;
          this.stop("pending", CODEX_CHROME_STOPPED_RELEASED, "release");
          return true;
        },
      }),
      deps.broker.registerCodexHandoff(deps.threadId, deps.generation, {
        native: (deadline, check) =>
          this.handoff.run("native", () => this.parkForNative(deadline, check)),
        browser: (deadline, check) =>
          this.handoff.run("browser", () => this.resumeBrowser(deadline, check)),
        status: () =>
          this.disabled
            ? {
                state: "off",
                nextAction: "Enable Chrome control for this thread before resuming it.",
              }
            : this.phase === "unavailable"
              ? {
                  state: "unavailable",
                  nextAction: this.unavailableDetail ?? "Start a new Chrome session.",
                }
              : {
                  state: this.handoff.transition
                    ? "switching-to-" + this.handoff.transition
                    : this.parked
                      ? "parked-for-native"
                      : this.phase,
                  ...(this.parked
                    ? {
                        nextAction:
                          deps.supportsBrowserResume?.() === false
                            ? "Chrome restarts on the next message; same-turn browser_resume requires a new provider thread."
                            : "Call browser_resume to return to Chrome; browser variables and handles must be recreated.",
                      }
                    : {}),
                },
      }),
    );
    deps.stateChanged("pending");
  }

  /** The runtime currently supervised by main, if any. */
  get adopted(): string | undefined {
    return this.launchToken;
  }
  get state(): typeof this.phase {
    return this.phase;
  }

  /** `mcpServer/startupStatus/updated` for `node_repl`. */
  startupStatus(status: string, error?: string): void {
    const ready = status === "ready";
    const failed = status === "failed" || status === "cancelled";
    if (this.phase === "stopped" || this.phase === "unavailable" || this.phase === "disposed") {
      // A runtime a restart started after its stop: never leave it running unsupervised.
      if (ready) void this.reap();
      return;
    }
    if (this.phase === "ready") {
      // Codex restarted it (an MCP reload F5 didn't start) or repeated itself: main returns
      // the supervised runtime unchanged, or adopts and verifies the new one.
      if (ready) this.readoption ??= this.readopt().finally(() => (this.readoption = undefined));
      else if (failed)
        this.stop(
          "pending",
          error?.trim() ||
            "Codex stopped the ChatGPT browser runtime. It restarts with your next message.",
        );
      return;
    }
    if (ready) this.adoption ??= this.adopt().finally(() => this.settleStart?.());
    else if (failed)
      this.fail(error?.trim() || "Codex couldn't start the ChatGPT browser runtime.");
  }

  /** A model call to `node_repl` started or finished: the runtime isn't idle. */
  toolCall(itemId: string, running: boolean): void {
    this.clearIdle();
    if (running) this.calls.add(itemId);
    else this.calls.delete(itemId);
    this.reportCalls();
  }

  /** A ready runtime between turns with no call running: safe to stop for another thread. */
  private get idle(): boolean {
    return this.phase === "ready" && !this.turnActive && !this.callRunning;
  }

  /** Whether a model call to `node_repl` is running; read before interrupting its turn. */
  get callRunning(): boolean {
    return this.calls.size > 0;
  }

  /**
   * Before each turn: a runtime stopped while idle or paused is started again (when its
   * gates allow it) and adopted before the model can reach it, within a bounded wait. One
   * that isn't supervised by then is stopped for this turn; the next one starts it again.
   */
  async beforeTurn(
    deadline = performance.now() + (this.deps.startWaitMs ?? CODEX_CHROME_RESTART_WAIT_MS),
    beforeReload?: () => Promise<void>,
  ): Promise<void> {
    this.clearIdle();
    this.turnActive = true;
    if (this.phase === "disposed" || this.phase === "unavailable") return;
    const wasDisabled = this.disabled;
    const refusal = await this.gate();
    if (refusal) {
      this.stop(refusal.state, refusal.detail);
      return;
    }
    if (wasDisabled) this.parked = false;
    if (this.parked && this.browserResumeProven && this.deps.supportsBrowserResume?.() !== false)
      return;
    this.parked = false;
    if (this.phase === "starting") {
      // The first turn can start before Codex reports the runtime; wait for its adoption.
      await this.bounded(this.adoption ?? this.startSettled(), deadline);
      if (this.phase === "starting") this.startTimedOut();
      return;
    }
    if (this.phase !== "stopped") return;
    this.phase = "starting";
    this.adoption = undefined;
    this.deps.stateChanged("pending");
    // Codex reports the new runtime's startup; adoption starts from that notification.
    const settled = this.startSettled();
    await beforeReload?.();
    try {
      await computerWithinDeadline(deadline, () => this.deps.codex.reload());
    } catch (error) {
      this.stop("pending", `Codex couldn't restart the ChatGPT browser runtime: ${message(error)}`);
      return;
    }
    await this.bounded(settled, deadline);
    if (this.phase === "starting") this.startTimedOut();
  }

  private async checkHandoff(check: () => Promise<void>): Promise<void> {
    await check();
    if (this.phase === "disposed" || this.phase === "unavailable")
      throw handoffError("Chrome control is unavailable for this session.");
    const refusal = await this.gate();
    if (refusal) throw handoffError(refusal.detail);
  }

  private async parkForNative(deadline: number, check: () => Promise<void>): Promise<void> {
    // Turning Chrome off or a failed browser preflight must never disable native apps.
    const live = async () => {
      await check();
      if (
        this.phase === "disposed" ||
        this.deps.broker.generation(this.deps.threadId) !== this.deps.generation
      )
        throw handoffError("This Chrome session ended.");
    };
    await waitForControl(
      () => this.phase !== "starting" && !this.readoption && !this.callRunning,
      deadline,
      live,
      () => (this.callRunning ? CHROME_OWN_CALL_RUNNING_MESSAGE : CHROME_OWN_STOPPING_MESSAGE),
    );
    if (this.phase === "ready" || this.launchToken || this.leaseHeld) {
      this.parked = true;
      this.stop("pending", "Chrome is paused while this thread controls another app.", "release");
    }
    await this.deps.broker.waitForChromeRelease(
      this.deps.threadId,
      this.deps.generation,
      deadline,
      live,
    );
  }

  private async resumeBrowser(deadline: number, check: () => Promise<void>): Promise<void> {
    const live = () => this.checkHandoff(check);
    await live();
    if (this.phase === "ready") {
      this.browserResumeProven = true;
      return;
    }
    try {
      await this.deps.waitForMcpIdle?.(deadline, live);
      await this.deps.broker.prepareCodexBrowser(
        this.deps.threadId,
        this.deps.generation,
        deadline,
        live,
      );
      // prepareCodexBrowser owns cleanup until its reservation has succeeded.
      this.leaseHeld = true;
      await live();
      this.parked = false;
      await this.beforeTurn(deadline, async () => {
        await this.deps.waitForMcpIdle?.(deadline, live);
        await live();
      });
      computerRemainingBudget(deadline);
      await live();
      if (this.state !== "ready")
        throw handoffError("Chrome did not become ready; retry browser_resume.");
      this.browserResumeProven = true;
    } catch (error) {
      this.browserResumeProven = false;
      this.parked = true;
      if (this.phase === "disposed") this.release();
      else
        this.stop(
          "pending",
          "Chrome could not restart. Retry Chrome control or send another message.",
        );
      throw error;
    }
  }

  /** `beforeTurn` ran but no turn started: nothing will end it. */
  turnAborted(): void {
    this.turnActive = false;
    this.armIdle();
  }

  /**
   * The turn ended or was interrupted: tell the runtime through its own hook so the
   * browser session for that turn is released, then start the idle stop.
   */
  turnEnded(turnId: string): void {
    this.turnActive = false;
    this.calls.clear();
    this.reportCalls();
    if (this.phase === "ready" && !this.drained.has(turnId)) {
      this.drained.add(turnId);
      if (this.drained.size > 64) this.drained = new Set([turnId]);
      const sessionId = this.deps.codex.providerThreadId();
      if (sessionId)
        void this.deps.codex
          .callTool(
            CODEX_CHROME_DRAIN_TOOL,
            { hook_event_name: "Stop", session_id: sessionId, turn_id: turnId },
            {},
          )
          .catch(() => undefined);
    }
    this.armIdle();
  }

  /**
   * The user interrupted a turn. Codex ends the turn at once, but `node_repl` keeps
   * running a call in flight, still driving Chrome, until `turn_ended` returns (29 s in
   * certification). So a turn interrupted during a call (`callRunning`, read before the
   * interrupt) stops the runtime instead, dropping the REPL's state; the next turn
   * starts it again. A completion not yet reported only costs an unneeded restart.
   */
  turnInterrupted(turnId: string | undefined, callRunning: boolean): void {
    if (callRunning && this.phase === "ready") {
      this.turnActive = false;
      if (turnId) this.drained.add(turnId);
      this.stop("pending", CODEX_CHROME_STOPPED_INTERRUPTED);
      return;
    }
    if (turnId) this.turnEnded(turnId);
  }

  dispose(): void {
    if (this.phase === "disposed") return;
    this.epoch += 1;
    this.phase = "disposed";
    this.clearIdle();
    this.release();
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private async adopt(): Promise<void> {
    const epoch = this.epoch;
    const { deps } = this;
    const parentPid = deps.codex.pid();
    if (!parentPid) return this.fail("Codex's process isn't running.");
    const launchToken = randomUUID();
    // Every stop from here on names this token, so it reaches the runtime even if main
    // adopts it after this request gave up.
    this.launchToken = launchToken;
    let registration: { readonly launchToken: string };
    try {
      registration = await this.requestAdoption(parentPid, launchToken);
    } catch (error) {
      // Main stops what it refuses, but a timeout or a lost reply says nothing: stop this
      // token in case main still adopts it, and sweep whatever Codex started.
      if (this.launchToken === launchToken) {
        deps.broker.stopIntegrationProcess(launchToken);
        this.launchToken = undefined;
      }
      void this.reap();
      if (this.epoch === epoch) this.fail(message(error));
      return;
    }
    // Supervised from here on: every exit path below releases through main.
    if (this.launchToken === launchToken) this.launchToken = registration.launchToken;
    if (this.epoch !== epoch) return this.release();
    const refusal = await this.verify();
    if (this.epoch !== epoch) return this.release();
    if (refusal) return this.fail(refusal);
    const gate = await this.gate();
    if (this.epoch !== epoch) return this.release();
    if (gate) return this.stop(gate.state, gate.detail);
    // Reported first, so the lease main announces on acquiring never reads as unknown.
    deps.broker.reportChromeCalls(deps.threadId, deps.generation, this.callRunning);
    try {
      await deps.broker.acquireChromeLease(this.holder(), HOST_TIMEOUT_MS);
      this.leaseHeld = true;
      this.reportCalls();
    } catch (error) {
      deps.broker.reportChromeCalls(deps.threadId, deps.generation, undefined);
      if (this.epoch !== epoch) return;
      return this.stop("pending", `Chrome is busy: ${message(error)}`);
    }
    if (this.epoch !== epoch) return this.release();
    this.phase = "ready";
    deps.stateChanged("connected");
    this.armIdle();
  }

  /**
   * Codex reported `node_repl` ready while it was supervised. Main answers with the
   * supervised registration when it's the same process, which changes nothing; a new
   * process (the old one went with Codex's restart) is verified before the session keeps
   * it, under the lease it already holds.
   */
  private async readopt(): Promise<void> {
    const epoch = this.epoch;
    const { deps } = this;
    const parentPid = deps.codex.pid();
    if (!parentPid) return this.fail("Codex's process isn't running.");
    const previous = this.launchToken;
    const launchToken = randomUUID();
    let registration: { readonly launchToken: string };
    try {
      registration = await this.requestAdoption(parentPid, launchToken);
    } catch (error) {
      deps.broker.stopIntegrationProcess(launchToken);
      void this.reap();
      if (this.epoch === epoch) this.fail(message(error));
      return;
    }
    if (registration.launchToken === previous) return;
    if (this.epoch !== epoch) return deps.broker.stopIntegrationProcess(registration.launchToken);
    if (previous) deps.broker.stopIntegrationProcess(previous);
    this.launchToken = registration.launchToken;
    const refusal = await this.verify();
    if (this.epoch !== epoch) return;
    if (refusal) return this.fail(refusal);
    const gate = await this.gate();
    if (this.epoch !== epoch) return;
    if (gate) return this.stop(gate.state, gate.detail);
  }

  /** Adopts a runtime only to have main stop it; main kills what it refuses. */
  private async reap(): Promise<void> {
    const parentPid = this.deps.codex.pid();
    if (!parentPid) return;
    try {
      const registration = await this.requestAdoption(parentPid, randomUUID());
      this.deps.broker.stopIntegrationProcess(registration.launchToken);
    } catch {
      // Refused, so main stopped it, or nothing is running.
    }
  }

  private requestAdoption(parentPid: number, launchToken: string) {
    const { deps } = this;
    return deps.broker.adoptIntegrationProcess({
      threadId: deps.threadId,
      sessionGeneration: deps.generation,
      launchToken,
      integration: "codex-chrome",
      parentPid,
      executable: deps.installation.nodeRepl,
    });
  }

  /** No supervised runtime when the turn starts: stop whatever Codex has running. */
  private startTimedOut(): void {
    this.stop("pending", CODEX_CHROME_START_TIMED_OUT);
    void this.reap();
  }

  /** Static checks: recovery, the installation, the registrations and the inventory. */
  private async verify(): Promise<string | undefined> {
    const { deps } = this;
    const { installation } = deps;
    if (deps.broker.chromeRecoveryRequired())
      return "Browser control from an earlier session hasn't stopped yet.";
    const current = await (deps.inspect ?? inspectCodexChrome)({
      userHome: deps.userHome,
      record: installation.record,
    });
    if (!current.available) return current.reason;
    if (!codexChromeInstallationUnchanged(installation, current))
      return "The ChatGPT app changed since this session started. Start a new session to use Chrome.";
    const unchanged = await (
      deps.registrationsUnchanged ??
      ((verified) => codexChromeRegistrationsUnchanged(verified, deps.userHome))
    )(installation);
    if (!unchanged)
      return "The ChatGPT Chrome helper's setup changed. Start a new session to use Chrome.";
    let tools: IntegrationTool[] | undefined;
    try {
      tools = listedTools(await deps.codex.listServer());
    } catch {
      tools = undefined;
    }
    if (!tools) return "Codex didn't list the ChatGPT browser runtime's tools.";
    const expected = [...installation.record.identity.allowedTools, CODEX_CHROME_DRAIN_TOOL].sort();
    const names = tools.map((tool) => tool.name).sort();
    if (
      JSON.stringify(names) !== JSON.stringify(expected) ||
      toolInventorySha256(tools) !== installation.record.toolInventorySha256
    )
      return CODEX_CHROME_INVENTORY_CHANGED;
    return undefined;
  }

  /** Live gates: pause, session generation and the thread's policy. */
  private async gate(): Promise<{ state: AgentCapabilityState; detail: string } | undefined> {
    const { deps } = this;
    if (deps.broker.pause.has(deps.threadId))
      return { state: "pending", detail: CODEX_CHROME_STOPPED_PAUSED };
    if (deps.broker.generation(deps.threadId) !== deps.generation)
      return { state: "unavailable", detail: "This session ended." };
    const enabled = await deps.policyEnabled().catch(() => false);
    this.disabled = !enabled;
    if (!enabled) return { state: "off", detail: CODEX_CHROME_STOPPED_OFF };
    return undefined;
  }

  /** Stops the runtime; the next turn may start it again. */
  private stop(
    state: AgentCapabilityState,
    detail: string,
    reason?: "release" | "unresponsive",
  ): void {
    if (this.phase === "disposed" || this.phase === "unavailable") return;
    this.epoch += 1;
    this.clearIdle();
    this.calls.clear();
    this.release(reason);
    this.phase = "stopped";
    this.deps.stateChanged(state, detail);
  }

  /** Stops the runtime for the rest of this session. */
  private fail(reason: string): void {
    if (this.phase === "disposed") return;
    this.unavailableDetail = reason;
    this.epoch += 1;
    this.clearIdle();
    this.release();
    this.phase = "unavailable";
    this.deps.stateChanged("unavailable", reason);
  }

  private release(reason?: "release" | "unresponsive"): void {
    this.settleStart?.();
    const { broker } = this.deps;
    if (this.launchToken) broker.stopIntegrationProcess(this.launchToken, reason);
    this.launchToken = undefined;
    // Main keeps the lease until the stopped group is gone: idle until then, and the broker
    // drops the report when the lease ends.
    if (this.leaseHeld) {
      broker.reportChromeCalls(this.deps.threadId, this.deps.generation, false);
      broker.host.send({
        type: "chromeLeaseRelease",
        requestId: randomUUID(),
        holder: this.holder(),
      });
    }
    this.leaseHeld = false;
  }

  /** The banner shows whether Chrome is in use, not only that its lease is held. */
  private reportCalls(): void {
    if (!this.leaseHeld) return;
    this.deps.broker.reportChromeCalls(this.deps.threadId, this.deps.generation, this.callRunning);
  }

  private holder() {
    return {
      profileId: this.deps.broker.host.profileId,
      threadId: this.deps.threadId,
      sessionGeneration: this.deps.generation,
      provider: "codex" as const,
    };
  }

  /** Starts the idle stop, only between turns: a turn can go long before its first call. */
  private armIdle(): void {
    this.clearIdle();
    if (this.phase !== "ready" || this.turnActive) return;
    const set = this.deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.idleTimer = set(() => {
      this.idleTimer = undefined;
      // Nothing is running a call, so the runtime gets the graceful stop.
      this.stop("pending", CODEX_CHROME_STOPPED_IDLE, "release");
    }, CODEX_CHROME_IDLE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer === undefined) return;
    (this.deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(
      this.idleTimer,
    );
    this.idleTimer = undefined;
  }

  /** Settles when the pending start finishes (adopted, stopped, failed or disposed). */
  private startSettled(): Promise<void> {
    this.settleStart?.();
    return new Promise((resolve) => {
      this.settleStart = () => {
        this.settleStart = undefined;
        resolve();
      };
    });
  }

  private async bounded(work: Promise<void> | undefined, deadline: number): Promise<void> {
    if (!work) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
