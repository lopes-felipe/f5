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
  suspend(): Promise<void>;
  onEvent(callback: (message: Record<string, unknown>) => void): () => void;
}
export class ComputerHelperClient implements ComputerHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: ComputerAutomationBackendStatus = { available: false, reason: "helper-missing" };
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(message: Record<string, unknown>) => void>();
  private lastHeartbeat = 0;
  private crashes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly monitorTimer: ReturnType<typeof setInterval>;
  private ready = false;
  private closing = false;
  private terminalFailure = false;
  constructor(
    private readonly root: string,
    private readonly executable: string,
    private readonly now: () => number = Date.now,
  ) {
    this.monitorTimer = setInterval(() => {
      if (this.ready && this.now() - this.lastHeartbeat > 750)
        this.fail({ available: false, reason: "monitor-unhealthy" });
    }, 250);
    this.monitorTimer.unref();
  }
  status(): ComputerAutomationBackendStatus {
    return this.state;
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
    this.ready = false;
    this.terminalFailure = false;
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
      this.crashes = this.crashes.filter((time) => this.now() - time < 60_000);
      this.crashes.push(this.now());
      if (this.crashes.length < 3)
        this.restartTimer = setTimeout(() => this.start(), 500 * 2 ** (this.crashes.length - 1));
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
      this.lastHeartbeat = this.now();
      this.control({ type: "permissions" });
    } else if (message.type === "status") {
      this.state = Schema.decodeUnknownSync(BackendStatusSchema)(message.status);
      if (!this.state.available && ["other-instance", "os-too-old"].includes(this.state.reason))
        this.terminalFailure = true;
    } else if (message.type === "heartbeat") {
      this.lastHeartbeat = this.now();
      if (
        message.monitorHealthy !== true &&
        (this.state.available || this.state.reason === "monitor-unhealthy")
      )
        this.fail({ available: false, reason: "monitor-unhealthy" });
    } else if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new ComputerControlError(Schema.decodeUnknownSync(ErrorSchema)(message.error)),
        );
      else pending.resolve(message.result);
    }
    for (const listener of this.listeners) listener(message);
  }
  private fail(status: ComputerAutomationBackendStatus): void {
    if (JSON.stringify(this.state) === JSON.stringify(status) && this.pending.size === 0) return;
    this.state = status;
    this.control({ type: "suspend" });
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
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, mutation });
      this.control(message);
    });
  }
  async suspend(): Promise<void> {
    if (!this.child) return;
    const id = randomUUID();
    try {
      await this.sendRequest(id, { type: "suspend", requestId: id }, 50, false);
    } catch {
      const child = this.child;
      this.child = null;
      child?.kill("SIGKILL");
      this.fail({ available: false, reason: "helper-crashed" });
      if (!this.closing) this.restartTimer = setTimeout(() => this.start(), 250);
    }
  }
  retry(): void {
    this.crashes = [];
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.fail({ available: false, reason: "helper-missing" });
    child?.kill("SIGKILL");
    this.start();
  }
  onEvent(callback: (message: Record<string, unknown>) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
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
