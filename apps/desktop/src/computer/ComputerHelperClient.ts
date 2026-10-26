import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ComputerAutomationBackendStatus,
  ComputerAutomationRequest,
} from "@t3tools/contracts";
import { ComputerControlError, isComputerMutation } from "@t3tools/shared/computerControl";
import { Schema } from "effect";
import {
  ComputerAutomationBackendStatus as BackendStatusSchema,
  ComputerAutomationError as ErrorSchema,
} from "@t3tools/contracts";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: ComputerControlError) => void;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
}
export interface ComputerHelper {
  status(): ComputerAutomationBackendStatus;
  request(
    request: ComputerAutomationRequest,
    extra: {
      f5Pids: ReadonlyArray<number>;
      f5BundlePath: string;
      overlayWindowIds: ReadonlyArray<number>;
    },
  ): Promise<unknown>;
  control(message: Record<string, unknown>): void;
  /** Suspend one generation (or everything) and wait for the helper's acknowledgement. */
  suspend(executionGeneration?: number): Promise<void>;
  onEvent(callback: (message: Record<string, unknown>) => void): () => void;
  /** Capabilities the running helper advertised in its hello. */
  capabilities?(): ReadonlyArray<string>;
  /** Resolves once every earlier mutation of that generation has finished in the helper. */
  drain?(executionGeneration: number, timeoutMs: number): Promise<void>;
  /** The helper's current physical-input sequence and idle age, read synchronously by it. */
  readiness?(): Promise<{ inputSequence: number; lastUserInputAgeMs: number }>;
}
export class ComputerHelperClient implements ComputerHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: ComputerAutomationBackendStatus = { available: false, reason: "helper-missing" };
  /** Last status the current helper pushed; local failures never overwrite it. */
  private helperState: ComputerAutomationBackendStatus | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(message: Record<string, unknown>) => void>();
  private lastHeartbeat = 0;
  private crashes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly monitorTimer: ReturnType<typeof setInterval>;
  private ready = false;
  private closing = false;
  private terminalFailure = false;
  private failureGeneration = 0;
  private observationRecovery: ChildProcessWithoutNullStreams | undefined;
  private childExited: Promise<void> = Promise.resolve();
  private helperCapabilities: ReadonlyArray<string> = [];
  constructor(
    private readonly root: string,
    private readonly executable: string,
    private readonly now: () => number = Date.now,
  ) {
    let lastTick = this.now();
    this.monitorTimer = setInterval(() => {
      const now = this.now();
      // A late tick means this event loop stalled, not the helper: let queued heartbeats land.
      const stalled = now - lastTick > 500;
      lastTick = now;
      if (!stalled && this.ready && now - this.lastHeartbeat > 750)
        this.fail({ available: false, reason: "monitor-unhealthy" });
    }, 250);
    this.monitorTimer.unref();
  }
  status(): ComputerAutomationBackendStatus {
    return this.state;
  }
  capabilities(): ReadonlyArray<string> {
    return this.ready ? this.helperCapabilities : [];
  }
  start(): void {
    if (this.closing || this.child) return;
    if (!existsSync(this.executable)) {
      this.fail({ available: false, reason: "helper-missing" });
      return;
    }
    const root = realpathSync(this.root);
    const executable = realpathSync(this.executable);
    const inside = relative(root, executable);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      this.fail({
        available: false,
        reason: "helper-missing",
        detail: "Helper is outside the installation directory.",
      });
      return;
    }
    const child = spawn(resolve(executable), [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.childExited = new Promise<void>((done) => child.once("exit", () => done()));
    // Pipe errors are emitted by the streams, independently of ChildProcess
    // errors. In particular, a helper can close stdin just after its hello.
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on("error", () => this.failTransport(child));
    this.ready = false;
    this.terminalFailure = false;
    this.helperState = undefined;
    this.state = {
      available: false,
      reason: "helper-missing",
      detail: "Waiting for helper handshake.",
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      const tooLarge = () => {
        this.fail({
          available: false,
          reason: "helper-crashed",
          detail: "Helper protocol exceeded line limit.",
        });
        child.kill("SIGKILL");
      };
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        if (this.child !== child) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 12 * 1024 * 1024) {
          tooLarge();
          return;
        }
        try {
          this.receive(JSON.parse(line) as Record<string, unknown>);
        } catch {
          this.fail({
            available: false,
            reason: "helper-crashed",
            detail: "Invalid helper response.",
          });
          child.kill("SIGKILL");
          return;
        }
      }
      if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) tooLarge();
    });
    // Drain stderr without persisting raw helper data.
    child.stderr.resume();
    child.on("error", () => {
      if (this.child === child) this.fail({ available: false, reason: "helper-crashed" });
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.fail(this.terminalFailure ? this.state : { available: false, reason: "helper-crashed" });
      if (this.closing) return;
      if (this.terminalFailure) return;
      this.scheduleCrashRestart(child, this.childExited);
    });
    const handshakeTimer = setTimeout(() => {
      if (this.child === child && !this.ready) {
        this.terminalFailure = true;
        this.fail({
          available: false,
          reason: "helper-missing",
          detail: "Helper handshake timed out.",
        });
        child.kill("SIGKILL");
      }
    }, 5000);
    handshakeTimer.unref();
  }
  private receive(message: Record<string, unknown>): void {
    if (message.type === "hello") {
      if (message.protocolVersion !== 1) {
        this.terminalFailure = true;
        this.fail({
          available: false,
          reason: "helper-missing",
          detail: "Helper protocol mismatch.",
        });
        this.child?.kill("SIGKILL");
        return;
      }
      this.ready = true;
      this.helperCapabilities = Array.isArray(message.capabilities)
        ? message.capabilities.filter((entry): entry is string => typeof entry === "string")
        : [];
      this.lastHeartbeat = this.now();
      this.control({ type: "permissions" });
    } else if (message.type === "status") {
      this.state = Schema.decodeUnknownSync(BackendStatusSchema)(message.status);
      this.helperState = this.state;
      if (!this.state.available && ["other-instance", "os-too-old"].includes(this.state.reason))
        this.terminalFailure = true;
    } else if (message.type === "heartbeat") {
      this.lastHeartbeat = this.now();
      if (
        message.monitorHealthy !== true &&
        (this.state.available || this.state.reason === "monitor-unhealthy")
      )
        this.fail({ available: false, reason: "monitor-unhealthy" });
      else if (
        message.monitorHealthy === true &&
        !this.state.available &&
        this.state.reason === "monitor-unhealthy" &&
        this.helperState?.available
      ) {
        // The helper deduplicates status pushes, so a locally detected heartbeat gap never
        // gets an "available" push to clear it. Healthy heartbeats restore the helper's last
        // status; held work stays suspended until the user resumes it.
        this.state = this.helperState;
        for (const listener of this.listeners) listener({ type: "status", status: this.state });
      }
    } else if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      // Decode before removing the entry so protocol failure rejects it via fail().
      const error = message.error
        ? new ComputerControlError(Schema.decodeUnknownSync(ErrorSchema)(message.error))
        : undefined;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (error) pending.reject(error);
      else pending.resolve(message.result);
    }
    for (const listener of this.listeners) listener(message);
  }
  private fail(status: ComputerAutomationBackendStatus): void {
    if (JSON.stringify(this.state) === JSON.stringify(status) && this.pending.size === 0) return;
    const generation = ++this.failureGeneration;
    this.state = status;
    this.control({ type: "suspend" });
    // A synchronous pipe failure may have retired the helper during suspend.
    if (this.failureGeneration !== generation) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new ComputerControlError(
          pending.mutation
            ? { _tag: "OutcomeUnknown" }
            : { _tag: "Unavailable", reason: status.available ? "helper-crashed" : status.reason },
        ),
      );
      this.pending.delete(id);
    }
    for (const listener of this.listeners) listener({ type: "status", status });
  }
  control(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child) return;
    if (!child.stdin.writable || child.stdin.destroyed) {
      this.failTransport(child);
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.failTransport(child);
      });
    } catch {
      this.failTransport(child);
    }
  }
  private failTransport(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    const exited = this.childExited;
    // Detach before fail() sends suspend, so a broken pipe cannot recurse.
    this.child = null;
    this.ready = false;
    this.fail(this.terminalFailure ? this.state : { available: false, reason: "helper-crashed" });
    child.kill("SIGKILL");
    if (this.closing || this.terminalFailure) return;
    this.scheduleCrashRestart(child, exited);
  }
  private scheduleCrashRestart(child: ChildProcessWithoutNullStreams, exited: Promise<void>): void {
    this.crashes = this.crashes.filter((time) => this.now() - time < 60_000);
    if (this.observationRecovery !== child) this.crashes.push(this.now());
    if (this.crashes.length < 3)
      void this.restartAfterExit(exited, 500 * 2 ** (this.crashes.length - 1));
  }
  request(
    request: ComputerAutomationRequest,
    extra: {
      f5Pids: ReadonlyArray<number>;
      f5BundlePath: string;
      overlayWindowIds: ReadonlyArray<number>;
    },
  ): Promise<unknown> {
    if (!this.state.available || !this.ready)
      return Promise.reject(
        new ComputerControlError({
          _tag: "Unavailable",
          reason: this.state.available ? "helper-missing" : this.state.reason,
        }),
      );
    return this.sendRequest(
      request.requestId,
      { type: "request", request, hostAuthorization: extra },
      isComputerMutation(request.op) ? 30_000 : 10_000,
      isComputerMutation(request.op),
    );
  }
  private sendRequest(
    id: string,
    message: Record<string, unknown>,
    timeout: number,
    mutation: boolean,
  ): Promise<unknown> {
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.control({ type: "cancel", requestId: id });
        reject(
          new ComputerControlError(
            mutation
              ? { _tag: "OutcomeUnknown" }
              : { _tag: "Execution", message: "Observation timed out." },
          ),
        );
        // Cancel cannot interrupt PrintWindow/AX calls stuck inside another app.
        // Retire that process; a replacement starts suspended and receives no retries.
        if (!mutation && message.type === "request" && child && this.child === child)
          void this.recoverObservation(child);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, mutation });
      this.control(message);
    });
  }
  private async recoverObservation(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.child !== child || this.observationRecovery === child) return;
    this.observationRecovery = child;
    this.crashes = this.crashes.filter((time) => this.now() - time < 60_000);
    this.crashes.push(this.now());
    if (this.crashes.length >= 3) this.terminalFailure = true;
    this.fail({
      available: false,
      reason: "helper-crashed",
      detail: "Observation worker timed out.",
    });
    await this.suspend();
    if (this.child === child) child.kill("SIGKILL");
  }
  /**
   * Wait until every earlier mutation of one generation has finished. A helper that cannot
   * drain within the bound is retired; its replacement starts only after a confirmed exit.
   */
  async drain(executionGeneration: number, timeoutMs = 5000): Promise<void> {
    const child = this.child;
    if (!child || !this.ready) return;
    const id = randomUUID();
    let result: unknown;
    try {
      // The helper answers within its own 5 s bound; the extra second keeps the two deadlines
      // from racing. Only a helper that stops answering entirely is retired.
      result = await this.sendRequest(
        id,
        { type: "drain", requestId: id, executionGeneration },
        Math.min(5000, timeoutMs) + 1000,
        false,
      );
    } catch {
      if (this.child !== child) return;
      const exited = this.childExited;
      this.child = null;
      this.ready = false;
      this.fail({ available: false, reason: "helper-crashed", detail: "Helper did not drain." });
      child.kill("SIGKILL");
      if (!this.closing && !this.terminalFailure) void this.restartAfterExit(exited);
      throw new ComputerControlError({ _tag: "OutcomeUnknown" });
    }
    // One generation is stuck in its target app; everyone else keeps the shared helper.
    if ((result as { drained?: unknown } | null)?.drained === false)
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" });
  }
  async readiness(): Promise<{ inputSequence: number; lastUserInputAgeMs: number }> {
    if (!this.child || !this.ready)
      throw new ComputerControlError({ _tag: "Unavailable", reason: "helper-missing" });
    const id = randomUUID();
    const result = (await this.sendRequest(
      id,
      { type: "readiness", requestId: id },
      1000,
      false,
    )) as { inputSequence?: unknown; lastUserInputAgeMs?: unknown } | null;
    if (typeof result?.inputSequence !== "number" || typeof result.lastUserInputAgeMs !== "number")
      throw new ComputerControlError({ _tag: "Execution", message: "Helper readiness invalid." });
    return { inputSequence: result.inputSequence, lastUserInputAgeMs: result.lastUserInputAgeMs };
  }
  async suspend(executionGeneration?: number): Promise<void> {
    const child = this.child;
    if (!child) return;
    const id = randomUUID();
    try {
      await this.sendRequest(
        id,
        {
          type: "suspend",
          requestId: id,
          ...(executionGeneration !== undefined ? { executionGeneration } : {}),
        },
        50,
        false,
      );
    } catch {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      child.kill("SIGKILL");
      this.fail({ available: false, reason: "helper-crashed" });
      if (!this.closing && !this.terminalFailure)
        this.restartTimer = setTimeout(() => this.start(), 250);
    }
  }
  retry(): void {
    this.crashes = [];
    this.observationRecovery = undefined;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.fail({ available: false, reason: "helper-missing" });
    const exited = this.childExited;
    child?.kill("SIGKILL");
    if (!child) this.start();
    else void this.restartAfterExit(exited);
  }
  private async restartAfterExit(exited: Promise<void>, delay = 0): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const confirmed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), 2000);
        }),
      ]);
      if (confirmed) {
        if (delay > 0) this.restartTimer = setTimeout(() => this.start(), delay);
        else this.start();
      } else
        this.fail({
          available: false,
          reason: "helper-crashed",
          detail: "Previous helper has not exited. Retry after it exits.",
        });
    } finally {
      clearTimeout(timer);
    }
  }
  onEvent(callback: (message: Record<string, unknown>) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  /** Test supervisors can require an actual exit receipt without changing stop behavior. */
  async closeAndWait(timeoutMs = 2000): Promise<boolean> {
    const exited = this.childExited;
    this.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  close(): void {
    this.closing = true;
    clearInterval(this.monitorTimer);
    clearTimeout(this.restartTimer);
    this.control({ type: "suspend" });
    this.child?.kill("SIGKILL");
    this.child = null;
    this.fail({ available: false, reason: "helper-crashed" });
  }
}
