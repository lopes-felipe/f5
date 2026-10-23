import { createHash, randomUUID } from "node:crypto";
import type { ProviderIntegrationKind } from "@t3tools/contracts";
import { stableMcpConfigKey } from "../provider/mcpReconcile";
import {
  spawnRegisteredProcess,
  type IntegrationProcessIdentity,
  type RegisterIntegrationProcess,
  type RegisteredProcess,
} from "../provider/registeredIntegrationProcess";
import type { McpToolResult } from "./previewMcpTools";

/**
 * F5-owned MCP proxy for provider-native integrations (Codex Chrome, later Sky).
 *
 * Codex skips MCP approvals in Full access, so the veto lives here: Codex talks to an
 * HTTP server F5 serves, and F5 forwards each admitted call to the real stdio server,
 * which it spawns lazily in its own process group, registered with desktop main so the
 * emergency shortcut and disconnect stop it without this server.
 */
export const INTEGRATION_PROTOCOL_VERSION = "2024-11-05";
const DRAIN_KILL_MS = 10_000;
const TEARDOWN_KILL_MS = 3_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** Matches native control: an idle child is stopped, which releases the browser. */
const IDLE_STOP_MS = 60_000;
const MAX_TOOL_PAGES = 32;
/** One JSON-RPC line; a child that streams more without a newline is killed. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** Above the browser runtime's own longest operation; Codex bounds the call with it. */
export const INTEGRATION_TOOL_TIMEOUT_SEC = 120;

export interface IntegrationTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly annotations?: unknown;
}

/** Order-insensitive inventory digest over `{name, inputSchema}`; descriptions may change. */
export function toolInventorySha256(tools: ReadonlyArray<IntegrationTool>): string {
  const canonical = [...tools]
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(stableMcpConfigKey(canonical)).digest("hex");
}

/** Newline-delimited JSON-RPC over a registered child's stdio. */
class StdioRpc {
  private nextId = 1;
  /** Bytes of the current, unterminated line; each chunk is scanned once. */
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(
    private readonly child: RegisteredProcess,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onOverflow: () => void,
    private readonly maxLineBytes: number,
  ) {
    child.stdout.on("data", (chunk: string | Buffer) =>
      this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    child.stdout.on("end", () => {
      this.closed = true;
      this.failAll(new Error("The integration process exited."));
    });
  }
  /** Stdout ended: the child is exiting even if its `exit` event hasn't arrived yet. */
  closed = false;
  private overflowed = false;
  private receive(chunk: Buffer): void {
    if (this.overflowed) return;
    let rest = chunk;
    for (let index = rest.indexOf(0x0a); index >= 0; index = rest.indexOf(0x0a)) {
      const line =
        this.partial.length === 0
          ? rest.subarray(0, index)
          : Buffer.concat([...this.partial, rest.subarray(0, index)]);
      this.partial = [];
      this.partialBytes = 0;
      rest = rest.subarray(index + 1);
      if (line.length > this.maxLineBytes) return this.overflow();
      this.handleLine(line.toString("utf8").trim());
    }
    if (rest.length === 0) return;
    this.partial.push(rest);
    this.partialBytes += rest.length;
    if (this.partialBytes > this.maxLineBytes) this.overflow();
  }
  private overflow(): void {
    this.overflowed = true;
    this.partial = [];
    this.partialBytes = 0;
    this.failAll(new Error("The integration sent an oversized message."));
    this.onOverflow();
  }
  private handleLine(line: string): void {
    if (!line) return;
    let message: {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { message?: unknown };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (message.id === undefined) this.onNotification(message.method, message.params);
      // F5 offers no client capabilities (sampling, roots, elicitation): answer at once
      // so a child waiting on one fails instead of hanging until the drain kills it.
      else
        this.child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "F5 doesn't support this request." },
          })}\n`,
        );
      return;
    }
    // Late or unknown ids (a dropped generation's response) are ignored.
    const waiter = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiter) return;
    this.pending.delete(message.id as number);
    if (message.error)
      waiter.reject(new Error(String(message.error.message ?? "Integration error.")));
    else waiter.resolve(message.result);
  }
  request(
    method: string,
    params: unknown,
    options: { onId?: (id: number) => void; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    options.onId?.(id);
    return new Promise((resolve, reject) => {
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error("The integration didn't respond in time."));
            }, options.timeoutMs);
      const done = () => timer && clearTimeout(timer);
      this.pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`,
    );
  }
  failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

export type IntegrationCallState =
  | "admitting"
  | "admitted"
  | "forwarded"
  | "settled"
  | "cancelled"
  | "orphaned";
interface TrackedCall {
  readonly callId: string;
  readonly generation: string;
  state: IntegrationCallState;
  requestId?: number;
}

export type IntegrationProxyState = "pending" | "connected" | "failed" | "unavailable";

export interface IntegrationProxyDeps {
  readonly integration: ProviderIntegrationKind;
  readonly threadId: string;
  readonly generation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** The record's allow-list; only verified tools in it are advertised. */
  readonly allowedTools: ReadonlyArray<string>;
  /** The record's inventory digest; without it no call is ever forwarded. */
  readonly toolInventorySha256: string | undefined;
  /**
   * The record's allow-listed tool definitions, advertised before consent so listing
   * never starts the unsandboxed child. Verification later requires the live ones match.
   */
  readonly advertisedTools?: ReadonlyArray<IntegrationTool>;
  readonly identity: IntegrationProcessIdentity;
  readonly register: RegisterIntegrationProcess;
  readonly exited?: (launchToken: string) => void;
  readonly policyEnabled: () => Promise<boolean>;
  readonly currentGeneration: () => string | undefined;
  readonly paused: () => boolean;
  /** One dialog per session generation; the grant lives in memory only. */
  readonly consent: () => Promise<boolean>;
  /** Integration-specific admission (for example: registrations unchanged). */
  readonly check?: () => Promise<string | undefined>;
  /** Re-verifies the installation right before each spawn (signatures, versions). */
  readonly beforeSpawn?: () => Promise<string | undefined>;
  /**
   * Held from the first forwarded call for the child's whole life: code a call started
   * can outlive it. Released when the child exits; main keeps ownership until it has seen
   * every process in the group gone. Acquisition is idempotent per holder.
   */
  readonly acquireLease: () => Promise<void>;
  readonly releaseLease: () => void;
  readonly stateChanged?: (state: IntegrationProxyState, detail?: string) => void;
  /** Live certification and the spike record what the integration listed. */
  readonly inventoryObserved?: (sha256: string, tools: ReadonlyArray<IntegrationTool>) => void;
  /** Runs once when the session is disposed (subscriptions, bookkeeping). */
  readonly disposed?: () => void;
  readonly spawn?: typeof spawnRegisteredProcess;
  readonly drainKillMs?: number;
  readonly teardownKillMs?: number;
  /** An idle child is stopped after this long, releasing the browser. */
  readonly idleStopMs?: number;
  /** Per-call deadline; a call past it is cancelled and drained like an interrupt. */
  readonly callTimeoutMs?: number;
  readonly maxLineBytes?: number;
}

const errorResult = (text: string): McpToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});
const INTERRUPTED = "Computer control was interrupted. Ask the user to resume.";

export class IntegrationProxySession {
  private child: RegisteredProcess | undefined;
  private rpc: StdioRpc | undefined;
  private ready: Promise<ReadonlyArray<IntegrationTool>> | undefined;
  /** The child `ready` was verified on; undefined while waiting for a dying one. */
  private readyChild: RegisteredProcess | undefined;
  /** MCP allows one `initialize` per connection; re-verification only re-lists. */
  private initializedChild: RegisteredProcess | undefined;
  private readyAttempts = 0;
  private readonly calls = new Map<string, TrackedCall>();
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private consented = false;
  private leaseHeld = false;
  constructor(private readonly deps: IntegrationProxyDeps) {}

  get inFlight(): ReadonlyArray<{ callId: string; state: IntegrationCallState }> {
    return [...this.calls.values()].map(({ callId, state }) => ({ callId, state }));
  }

  private setState(state: IntegrationProxyState, detail?: string): void {
    this.deps.stateChanged?.(state, detail);
  }

  private start(): RegisteredProcess {
    const child = (this.deps.spawn ?? spawnRegisteredProcess)({
      command: this.deps.command,
      args: this.deps.args,
      env: this.deps.env,
      ...(this.deps.cwd ? { cwd: this.deps.cwd } : {}),
      identity: this.deps.identity,
      register: this.deps.register,
      ...(this.deps.exited ? { exited: this.deps.exited } : {}),
    });
    this.child = child;
    this.rpc = new StdioRpc(
      child,
      (method) => {
        // A changed inventory must be verified again before any further call.
        if (method === "notifications/tools/list_changed" && this.readyChild === child)
          this.ready = undefined;
      },
      () => child.kill("SIGKILL"),
      this.deps.maxLineBytes ?? MAX_LINE_BYTES,
    );
    child.once("exit", () => this.childExited(child));
    this.childExit = new Promise((resolve) => child.once("exit", () => resolve()));
    return child;
  }
  private childExit: Promise<void> = Promise.resolve();

  private childExited(child: RegisteredProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.rpc?.failAll(new Error("The integration process exited."));
    this.rpc = undefined;
    // An attempt already waiting for the next child keeps going.
    if (this.readyChild === child) this.ready = undefined;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.clearIdle();
    // Main observed the exit too; whatever was in flight can no longer act. Calls still
    // in admission continue and start a new child.
    // Deleting the current entry while iterating a Map is safe.
    for (const call of this.calls.values()) {
      if (call.state === "admitting") continue;
      call.state = "orphaned";
      this.calls.delete(call.callId);
    }
    this.releaseLease();
    if (!this.disposed) this.setState("pending");
  }

  private releaseLease(): void {
    if (!this.leaseHeld) return;
    this.leaseHeld = false;
    this.deps.releaseLease();
  }
  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
  /** Nothing in flight: stop an idle child later, or release a lease no child uses. */
  private idle(): void {
    if (this.calls.size > 0) return;
    if (!this.child) return this.releaseLease();
    // Armed with or without a lease: a child spawned for a call that was then refused
    // (disallowed tool, changed inventory, busy browser) must not live on unused.
    if (this.idleTimer) return;
    const child = this.child;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.child === child && this.calls.size === 0) this.terminate(child);
    }, this.deps.idleStopMs ?? IDLE_STOP_MS);
  }
  /** SIGTERM now, SIGKILL after the teardown grace. The lease is released on exit. */
  private terminate(child: RegisteredProcess): void {
    const kill = setTimeout(
      () => child.kill("SIGKILL"),
      this.deps.teardownKillMs ?? TEARDOWN_KILL_MS,
    );
    child.once("exit", () => clearTimeout(kill));
    if (!child.kill("SIGTERM")) clearTimeout(kill);
  }

  /** Lazily spawns, initializes and verifies the paged inventory against the record. */
  private verifiedTools(): Promise<ReadonlyArray<IntegrationTool>> {
    // A killed or closed child is exiting even before its `exit` event: its verification
    // no longer counts. Callers meanwhile share one attempt for the next child.
    const dying = this.child !== undefined && (this.child.killed || this.rpc?.closed === true);
    if (this.ready && !(dying && this.readyChild === this.child)) return this.ready;
    this.readyChild = dying ? undefined : this.child;
    const attemptNumber = ++this.readyAttempts;
    const attempt = (async () => {
      if (this.disposed) throw new Error("The integration session ended.");
      // Wait for the dying child rather than reusing it, so two never overlap.
      if (dying) await this.childExit;
      if (this.disposed) throw new Error("The integration session ended.");
      let child = this.child;
      if (!child) {
        // The installation is checked again now, not only when the session started.
        const changed = await this.deps.beforeSpawn?.();
        if (changed) throw new Error(changed);
        if (this.disposed) throw new Error("The integration session ended.");
        child = this.child ?? this.start();
      }
      await child.registered;
      if (this.readyAttempts === attemptNumber) this.readyChild = child;
      const rpc = this.rpc!;
      if (this.initializedChild !== child) {
        await rpc.request(
          "initialize",
          {
            protocolVersion: INTEGRATION_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "F5", version: "0.0.0" },
          },
          { timeoutMs: HANDSHAKE_TIMEOUT_MS },
        );
        rpc.notify("notifications/initialized");
        this.initializedChild = child;
      }
      const tools: IntegrationTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_TOOL_PAGES) throw new Error("The integration's tool list never ended.");
        const result = (await rpc.request("tools/list", cursor ? { cursor } : {}, {
          timeoutMs: HANDSHAKE_TIMEOUT_MS,
        })) as {
          tools?: unknown;
          nextCursor?: unknown;
        };
        if (!Array.isArray(result?.tools))
          throw new Error("The integration's tool list is malformed.");
        for (const tool of result.tools as IntegrationTool[]) {
          if (typeof tool?.name !== "string")
            throw new Error("The integration's tool list is malformed.");
          tools.push(tool);
        }
        if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
      this.deps.inventoryObserved?.(toolInventorySha256(tools), tools);
      if (
        !this.deps.toolInventorySha256 ||
        toolInventorySha256(tools) !== this.deps.toolInventorySha256
      )
        throw new Error("The integration's tools changed. Update F5.");
      const allowed = new Set(this.deps.allowedTools);
      const live = tools.filter((tool) => allowed.has(tool.name));
      // What Codex was shown before consent must be exactly what runs.
      for (const advertised of this.deps.advertisedTools ?? []) {
        const match = live.find((tool) => tool.name === advertised.name);
        if (
          !match ||
          stableMcpConfigKey(match.inputSchema) !== stableMcpConfigKey(advertised.inputSchema)
        )
          throw new Error("The integration's tools changed. Update F5.");
      }
      this.setState("connected");
      return live;
    })();
    this.ready = attempt;
    attempt.catch((error: unknown) => {
      if (this.ready === attempt) this.ready = undefined;
      this.setState("failed", error instanceof Error ? error.message : String(error));
    });
    return attempt;
  }

  /**
   * Never spawns: Codex lists tools at session start, before the user has consented, so
   * only the record's advertised definitions are returned. Without them nothing is listed.
   */
  async listTools(): Promise<ReadonlyArray<IntegrationTool>> {
    if (this.disposed) return [];
    const allowed = new Set(this.deps.allowedTools);
    return (this.deps.advertisedTools ?? []).filter((tool) => allowed.has(tool.name));
  }

  /** Spawns and verifies now. Only live certification harnesses call this directly. */
  verifyInventory(): Promise<ReadonlyArray<IntegrationTool>> {
    return this.verifiedTools();
  }

  /**
   * Live policy, generation, pause, consent, integration checks, then the inventory. The
   * call is tracked from the start, so a cancel during any of these waits is seen after it.
   */
  private async admit(
    name: string,
    call: TrackedCall,
  ): Promise<string | { readonly verified: Promise<ReadonlyArray<IntegrationTool>> }> {
    const cancelled = () => (call.state === "admitting" ? undefined : INTERRUPTED);
    if (this.disposed) return "The integration session ended.";
    if (!(await this.deps.policyEnabled())) return "This integration is turned off in F5 settings.";
    if (cancelled()) return INTERRUPTED;
    if (this.deps.currentGeneration() !== this.deps.generation)
      return "This integration is unavailable for this session.";
    if (this.deps.paused()) return "Computer control is paused. Ask the user to resume.";
    if (!this.consented) {
      if (!(await this.deps.consent()))
        return "The user didn't allow this integration for this session.";
      this.consented = true;
      if (this.deps.paused() || this.deps.currentGeneration() !== this.deps.generation)
        return "Computer control is paused. Ask the user to resume.";
      if (cancelled()) return INTERRUPTED;
    }
    const failed = await this.deps.check?.();
    if (failed) return failed;
    if (cancelled()) return INTERRUPTED;
    let tools: ReadonlyArray<IntegrationTool>;
    const verified = this.verifiedTools();
    try {
      tools = await verified;
    } catch (error) {
      // A pause stops the child under verification; report the interrupt, not the exit.
      return (
        cancelled() ??
        (error instanceof Error ? error.message : "The integration could not be verified.")
      );
    }
    if (cancelled()) return INTERRUPTED;
    if (!tools.some((tool) => tool.name === name)) return `The tool "${name}" isn't allowed in F5.`;
    return { verified };
  }

  /** Everything an await could have changed since admission; checked with no await after. */
  private stale(
    call: TrackedCall,
    verified: Promise<ReadonlyArray<IntegrationTool>>,
  ): string | undefined {
    if (this.disposed) return "The integration session ended.";
    if (call.state !== "admitted" || this.deps.paused()) return INTERRUPTED;
    if (this.deps.currentGeneration() !== call.generation)
      return "This integration is unavailable for this session.";
    if (this.ready !== verified || !this.rpc || this.rpc.closed || this.child?.killed)
      return "The integration's tools changed while the call was waiting. Try again.";
    return undefined;
  }

  async callTool(
    name: string,
    args: unknown,
    requestedId: string = randomUUID(),
  ): Promise<McpToolResult> {
    const callId = this.calls.has(requestedId) ? `${requestedId}#${randomUUID()}` : requestedId;
    const call: TrackedCall = { callId, generation: this.deps.generation, state: "admitting" };
    this.calls.set(callId, call);
    this.clearIdle();
    const admitted = await this.admit(name, call).catch((error: unknown) =>
      error instanceof Error ? error.message : "The integration could not be verified.",
    );
    if (typeof admitted === "string") {
      this.settle(call, call.state === "admitting" ? "settled" : call.state);
      return errorResult(admitted);
    }
    call.state = "admitted";
    try {
      await this.deps.acquireLease();
      this.leaseHeld = true;
    } catch (error) {
      this.settle(call, "cancelled");
      return errorResult(
        error instanceof Error ? error.message : "Browser control is busy. Try again.",
      );
    }
    // Policy, pause, generation, cancellation and inventory are rechecked after every wait.
    const enabled = await this.deps.policyEnabled().catch(() => false);
    const stale = enabled ? this.stale(call, admitted.verified) : undefined;
    if (!enabled || stale) {
      this.settle(call, "cancelled");
      // Turned off: nothing an earlier call started may keep running either.
      if (!enabled) this.cancel();
      return errorResult(stale ?? "This integration is turned off in F5 settings.");
    }
    call.state = "forwarded";
    const response = this.rpc!.request(
      "tools/call",
      { name, arguments: args },
      {
        onId: (id) => {
          call.requestId = id;
        },
      },
    ).then(
      (result) => {
        if (call.state !== "forwarded" || this.deps.currentGeneration() !== call.generation) {
          this.settle(call, call.state === "forwarded" ? "orphaned" : call.state);
          return errorResult("The call was interrupted; its result was discarded.");
        }
        this.settle(call, "settled");
        return result as McpToolResult;
      },
      (error: unknown) => {
        this.settle(call, call.state === "forwarded" ? "settled" : call.state);
        return errorResult(error instanceof Error ? error.message : "The integration call failed.");
      },
    );
    // Past the deadline the call is cancelled and drained; the child keeps the lease
    // until it answers or exits.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<McpToolResult>((resolve) => {
      deadline = setTimeout(
        () => {
          this.cancelCall(callId);
          resolve(errorResult("The integration call took too long and was stopped."));
        },
        this.deps.callTimeoutMs ?? INTEGRATION_TOOL_TIMEOUT_SEC * 1000,
      );
    });
    try {
      return await Promise.race([response, timedOut]);
    } finally {
      clearTimeout(deadline);
    }
  }

  private settle(call: TrackedCall, state: IntegrationCallState): void {
    call.state = state;
    this.calls.delete(call.callId);
    if (this.drainTimer && ![...this.calls.values()].some((entry) => entry.state === "cancelled")) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.idle();
  }

  private cancelTracked(call: TrackedCall): boolean {
    if (call.state === "admitting") {
      // Not yet forwarded: admission sees it after its current wait and stops there.
      call.state = "cancelled";
      return false;
    }
    if (call.state !== "forwarded" && call.state !== "admitted") return false;
    call.state = "cancelled";
    if (call.requestId !== undefined)
      this.rpc?.notify("notifications/cancelled", {
        requestId: call.requestId,
        reason: "Interrupted by F5",
      });
    return true;
  }
  private startDrain(): void {
    if (this.drainTimer || !this.child) return;
    const child = this.child;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      child.kill("SIGKILL");
    }, this.deps.drainKillMs ?? DRAIN_KILL_MS);
  }

  /** The MCP client cancelled one call (`notifications/cancelled`) or it timed out. */
  cancelCall(callId: string): void {
    const call = this.calls.get(callId);
    if (call && this.cancelTracked(call)) this.startDrain();
  }

  /**
   * Pause, interrupt or turn end. Calls are cancelled and the child is stopped too, since
   * code an earlier call started (timers, listeners) can still be driving the browser.
   * The lease is released once the child has exited.
   */
  cancel(): void {
    for (const call of this.calls.values()) this.cancelTracked(call);
    this.clearIdle();
    if (this.child) this.terminate(this.child);
  }

  /** Session dispose, credential revocation or shutdown: SIGTERM, then SIGKILL after 3 s. */
  dispose(): Promise<void> {
    if (!this.disposed) this.deps.disposed?.();
    this.disposed = true;
    for (const call of this.calls.values()) this.cancelTracked(call);
    this.clearIdle();
    const child = this.child;
    if (!child) {
      this.releaseLease();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      this.terminate(child);
      if (child.exitCode !== null || child.signalCode) resolve();
    });
  }
}
