import { windowsDiagnosticFailure, windowsDiagnosticStatus } from "./rehearsalWindowsDiagnostics";
import type { ComputerAutomationBackendStatus } from "@t3tools/contracts";

/** Bounded protocol facts only: no requests, response payloads, titles or text. */
export class WindowsWorkflowTrace {
  private readonly operations: {
    op: string;
    delivery: "foreground" | "background";
    response: "none" | "ok" | "error";
    actionConfirmed: boolean;
    elapsedMs?: number;
    nativeError?: ReturnType<typeof windowsDiagnosticFailure>;
    returnedError?: ReturnType<typeof windowsDiagnosticFailure>;
    traversal?: {
      complete: boolean;
      visited: number;
      reported: number;
      processSkipped: number;
      runtimeSkipped: number;
      errors: string[];
    };
  }[] = [];
  private active: { id: string; index: number; started: number } | undefined;
  private heartbeatAt: number | undefined;
  private monitorHealthy: boolean | undefined;
  private status: ReturnType<typeof windowsDiagnosticStatus> | undefined;
  private overflow = false;
  private readonly hookProbes: {
    acknowledged: boolean;
    mouseQueued: boolean;
    keyboardQueued: boolean;
    mouseAcknowledged: boolean;
    keyboardAcknowledged: boolean;
    elapsedMs: number;
    mouseProbe?: "wheel-zero" | "raw-input-liveness";
    mouseRegistered?: boolean;
  }[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  start(request: { requestId: string; op: string; delivery?: string | undefined }) {
    if (this.operations.length >= 32) {
      this.overflow = true;
      this.active = undefined;
      return;
    }
    const op = ["inspect", "elementAction", "screenshot", "key", "zoom"].includes(request.op)
      ? request.op
      : "other";
    this.active = { id: request.requestId, index: this.operations.length, started: this.now() };
    this.operations.push({
      op,
      delivery: request.delivery === "background" ? "background" : "foreground",
      response: "none",
      actionConfirmed: false,
    });
  }
  event(message: Record<string, unknown>) {
    if (
      message.type === "hookProbe" &&
      [
        "acknowledged",
        "mouseQueued",
        "keyboardQueued",
        "mouseAcknowledged",
        "keyboardAcknowledged",
      ].every((key) => typeof message[key] === "boolean") &&
      typeof message.elapsedMs === "number" &&
      Number.isFinite(message.elapsedMs)
    ) {
      this.hookProbes.push({
        acknowledged: message.acknowledged as boolean,
        mouseQueued: message.mouseQueued as boolean,
        keyboardQueued: message.keyboardQueued as boolean,
        mouseAcknowledged: message.mouseAcknowledged as boolean,
        keyboardAcknowledged: message.keyboardAcknowledged as boolean,
        elapsedMs: Math.min(10000, Math.max(0, message.elapsedMs)),
        ...(message.mouseProbe === "wheel-zero" || message.mouseProbe === "raw-input-liveness"
          ? { mouseProbe: message.mouseProbe }
          : {}),
        ...(typeof message.mouseRegistered === "boolean"
          ? { mouseRegistered: message.mouseRegistered }
          : {}),
      });
      if (this.hookProbes.length > 8) this.hookProbes.shift();
    }
    if (message.type === "heartbeat") {
      this.heartbeatAt = this.now();
      this.monitorHealthy = message.monitorHealthy === true;
    }
    if (message.type === "status" && message.status && typeof message.status === "object") {
      this.status = windowsDiagnosticStatus(message.status as ComputerAutomationBackendStatus);
    }
    if (!this.active || message.requestId !== this.active.id) return;
    const operation = this.operations[this.active.index]!;
    if (
      message.type === "accessibilityTraversal" &&
      typeof message.complete === "boolean" &&
      ["visited", "reported", "processSkipped", "runtimeSkipped"].every(
        (key) =>
          typeof message[key] === "number" &&
          Number.isSafeInteger(message[key]) &&
          (message[key] as number) >= 0 &&
          (message[key] as number) <= 8000,
      ) &&
      Array.isArray(message.errors)
    ) {
      operation.traversal = {
        complete: message.complete,
        visited: message.visited as number,
        reported: message.reported as number,
        processSkipped: message.processSkipped as number,
        runtimeSkipped: message.runtimeSkipped as number,
        errors: message.errors
          .filter(
            (value): value is string => typeof value === "string" && /^[0-9A-F]{8}$/.test(value),
          )
          .slice(0, 8),
      };
    }
    if (message.type === "actionConfirmed") operation.actionConfirmed = true;
    if (message.type === "response") {
      operation.response = message.error ? "error" : "ok";
      if (message.error) operation.nativeError = windowsDiagnosticFailure({ error: message.error });
    }
  }
  finish(error?: unknown) {
    if (!this.active) return;
    const operation = this.operations[this.active.index]!;
    operation.elapsedMs = Math.min(300_000, Math.max(0, this.now() - this.active.started));
    if (error !== undefined) operation.returnedError = windowsDiagnosticFailure(error);
    this.active = undefined;
  }
  report() {
    return {
      operations: this.operations.map((operation) => ({ ...operation })),
      overflow: this.overflow,
      hookProbes: this.hookProbes.map((probe) => ({ ...probe })),
      ...(this.status ? { lastStatus: this.status } : {}),
      ...(this.heartbeatAt !== undefined
        ? {
            lastHeartbeatAgeMs: Math.min(300_000, Math.max(0, this.now() - this.heartbeatAt)),
            monitorHealthy: this.monitorHealthy,
          }
        : {}),
    };
  }
}
