import { randomUUID } from "node:crypto";
import type { AgentCapabilityState } from "@t3tools/contracts";
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
  | "onChromeDisabled"
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
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: CodexChromeSessionDeps) {
    this.unsubscribe.push(
      deps.broker.pause.subscribe((threadId, paused) => {
        if (paused && threadId === deps.threadId) this.stop("pending", CODEX_CHROME_STOPPED_PAUSED);
      }),
      deps.broker.onChromeDisabled((threadId, generation) => {
        if (threadId === deps.threadId && generation === deps.generation)
          this.stop("off", CODEX_CHROME_STOPPED_OFF);
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
  toolActivity(): void {
    this.clearIdle();
  }

  /**
   * Before each turn: a runtime stopped while idle or paused is started again (when its
   * gates allow it) and adopted before the model can reach it, within a bounded wait. One
   * that isn't supervised by then is stopped for this turn; the next one starts it again.
   */
  async beforeTurn(): Promise<void> {
    this.clearIdle();
    this.turnActive = true;
    if (this.phase === "starting") {
      // The first turn can start before Codex reports the runtime; wait for its adoption.
      await this.bounded(this.adoption ?? this.startSettled());
      if (this.phase === "starting") this.startTimedOut();
      return;
    }
    if (this.phase !== "stopped") return;
    const refusal = await this.gate();
    if (refusal) {
      this.deps.stateChanged(refusal.state, refusal.detail);
      return;
    }
    if (this.phase !== "stopped") return;
    this.phase = "starting";
    this.adoption = undefined;
    this.deps.stateChanged("pending");
    // Codex reports the new runtime's startup; adoption starts from that notification.
    const settled = this.startSettled();
    try {
      await this.deps.codex.reload();
    } catch (error) {
      this.fail(`Codex couldn't restart the ChatGPT browser runtime: ${message(error)}`);
      return;
    }
    await this.bounded(settled);
    if (this.phase === "starting") this.startTimedOut();
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
    try {
      await deps.broker.host.correlated(
        { type: "chromeLeaseAcquire", requestId: randomUUID(), holder: this.holder() },
        HOST_TIMEOUT_MS,
        false,
      );
      this.leaseHeld = true;
    } catch (error) {
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
    this.release(reason);
    this.phase = "stopped";
    this.deps.stateChanged(state, detail);
  }

  /** Stops the runtime for the rest of this session. */
  private fail(reason: string): void {
    if (this.phase === "disposed") return;
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
    // Main keeps the lease until the stopped group is gone.
    if (this.leaseHeld)
      broker.host.send({
        type: "chromeLeaseRelease",
        requestId: randomUUID(),
        holder: this.holder(),
      });
    this.leaseHeld = false;
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

  private async bounded(work: Promise<void> | undefined): Promise<void> {
    if (!work) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.startWaitMs ?? CODEX_CHROME_RESTART_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
