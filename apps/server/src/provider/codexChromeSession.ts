import { randomUUID } from "node:crypto";
import type { AgentCapabilityState } from "@t3tools/contracts";
import { CODEX_CHROME_DRAIN_TOOL } from "@t3tools/shared/providerIntegrationCertification";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import {
  codexChromeInstallationUnchanged,
  codexChromeRegistrationsUnchanged,
  inspectCodexChrome,
  type CodexChromeInstallation,
} from "../computer/codexNativeIntegrations";
import { toolInventorySha256, type IntegrationTool } from "../mcp/IntegrationProxyCatalog";

/** Codex's `node_repl` is stopped after this long without a turn or a call. */
export const CODEX_CHROME_IDLE_MS = 60_000;
/** How long the next turn waits for a stopped runtime to restart before going ahead. */
export const CODEX_CHROME_RESTART_WAIT_MS = 20_000;
/** Lease and adoption replies from desktop main. */
const HOST_TIMEOUT_MS = 5_000;

export const CODEX_CHROME_STOPPED_IDLE =
  "Stopped while idle. Chrome control restarts with your next message.";
export const CODEX_CHROME_STOPPED_PAUSED =
  "Paused. Chrome control restarts with your next message after you resume.";
export const CODEX_CHROME_STOPPED_OFF = "Turned off for this thread.";
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
 * turning the integration off, a new session generation and 60 s idle stop the process;
 * the next turn reloads Codex's MCP config, which starts a new one, and adoption runs again.
 */
export class CodexChromeSession {
  private phase: "starting" | "ready" | "stopped" | "unavailable" | "disposed" = "starting";
  /** Bumped by every stop, so an adoption that finishes after one is undone. */
  private epoch = 0;
  private launchToken: string | undefined;
  private leaseHeld = false;
  private idleTimer: unknown;
  private adoption: Promise<void> | undefined;
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
    if (status === "ready" && (this.phase === "stopped" || this.phase === "unavailable")) {
      // A runtime a restart started after its stop: never leave it running unsupervised.
      void this.reap();
      return;
    }
    if (this.phase === "ready" && (status === "ready" || status === "failed")) {
      // Codex replaced the runtime (an MCP reload F5 didn't start): the adopted process
      // and its lease are gone with it, so the new one is adopted and verified afresh.
      this.epoch += 1;
      this.clearIdle();
      this.release();
      this.phase = "starting";
      this.adoption = undefined;
      this.deps.stateChanged("pending");
    }
    if (this.phase !== "starting") return;
    if (status === "ready") this.adoption ??= this.adopt().finally(() => this.settleStart?.());
    else if (status === "failed" || status === "cancelled")
      this.fail(error?.trim() || "Codex couldn't start the ChatGPT browser runtime.");
  }

  /** A model call to `node_repl` started or finished: the runtime isn't idle. */
  toolActivity(): void {
    this.clearIdle();
  }

  /**
   * Before each turn: a runtime stopped while idle or paused is started again (when its
   * gates allow it) and adopted before the model can reach it, within a bounded wait.
   */
  async beforeTurn(): Promise<void> {
    this.clearIdle();
    if (this.phase === "starting") {
      // The first turn can start before Codex reports the runtime; wait for its adoption.
      await this.bounded(this.adoption ?? this.startSettled());
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
  }

  /**
   * The turn ended or was interrupted: tell the runtime through its own hook so the
   * browser session for that turn is released, then start the idle stop.
   */
  turnEnded(turnId: string): void {
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
    try {
      await deps.broker.adoptIntegrationProcess({
        threadId: deps.threadId,
        sessionGeneration: deps.generation,
        launchToken,
        integration: "codex-chrome",
        parentPid,
        executable: deps.installation.nodeRepl,
      });
    } catch (error) {
      // Main stopped every candidate it could verify; nothing runs unsupervised.
      if (this.epoch === epoch) this.fail(message(error));
      return;
    }
    // Supervised from here on: every exit path below releases through main.
    this.launchToken = launchToken;
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

  /** Adopts a runtime only to have main stop it; main kills what it can't adopt. */
  private async reap(): Promise<void> {
    const { deps } = this;
    const parentPid = deps.codex.pid();
    if (!parentPid) return;
    const launchToken = randomUUID();
    try {
      await deps.broker.adoptIntegrationProcess({
        threadId: deps.threadId,
        sessionGeneration: deps.generation,
        launchToken,
        integration: "codex-chrome",
        parentPid,
        executable: deps.installation.nodeRepl,
      });
    } catch {
      return;
    }
    deps.broker.stopIntegrationProcess(launchToken);
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
  private stop(state: AgentCapabilityState, detail: string): void {
    if (this.phase === "disposed" || this.phase === "unavailable") return;
    this.epoch += 1;
    this.clearIdle();
    this.release();
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

  private release(): void {
    this.settleStart?.();
    const { broker } = this.deps;
    if (this.launchToken) broker.stopIntegrationProcess(this.launchToken);
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

  private armIdle(): void {
    this.clearIdle();
    if (this.phase !== "ready") return;
    const set = this.deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.idleTimer = set(() => {
      this.idleTimer = undefined;
      this.stop("pending", CODEX_CHROME_STOPPED_IDLE);
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
        timer = setTimeout(resolve, CODEX_CHROME_RESTART_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
