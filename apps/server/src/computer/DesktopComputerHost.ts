import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  SCHEDULED_NOTIFICATIONS_CAPABILITY,
  COMPUTER_BACKGROUND_CAPABILITY,
  COMPUTER_AGENT_IDENTITY_CAPABILITY,
  COMPUTER_ACTIVITY_CORRELATION_CAPABILITY,
  DesktopComputerHostMessage,
  type ComputerAutomationBackendStatus,
  type ComputerAutomationRequest,
} from "@t3tools/contracts";
import { ComputerControlError, isComputerMutation } from "@t3tools/shared/computerControl";

export interface ComputerIpcProcess {
  readonly connected?: boolean | undefined;
  send?: ((message: unknown, callback: (error: Error | null) => void) => boolean) | undefined;
  on(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
  off(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
}
export class DesktopComputerHost {
  private state: ComputerAutomationBackendStatus = { available: false, reason: "no-host" };
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(message: DesktopComputerHostMessage) => void>();
  private connected = false;
  private hostCapabilities = new Set<string>();
  constructor(
    readonly profileId: string,
    readonly backendIncarnation: string,
    private readonly ipc: ComputerIpcProcess = process,
    enabled = process.env.F5_DESKTOP_COMPUTER_HOST === "ipc",
  ) {
    if (!enabled || !ipc.send || ipc.connected === false) return;
    this.connected = true;
    this.state = {
      available: false,
      reason: "no-host",
      detail: "Waiting for desktop host.",
    };
    ipc.on("message", this.receive);
    ipc.on("disconnect", this.disconnect);
    this.send({
      type: "hello",
      profileId,
      backendIncarnation,
      protocolVersion: 1,
      capabilities: [
        SCHEDULED_NOTIFICATIONS_CAPABILITY,
        COMPUTER_BACKGROUND_CAPABILITY,
        COMPUTER_AGENT_IDENTITY_CAPABILITY,
        COMPUTER_ACTIVITY_CORRELATION_CAPABILITY,
      ],
    });
  }
  status(): ComputerAutomationBackendStatus {
    return this.state;
  }
  /** Background delivery needs the desktop to have answered with the same capability. */
  backgroundCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_BACKGROUND_CAPABILITY);
  }
  supportsAgentIdentity(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_AGENT_IDENTITY_CAPABILITY);
  }
  supportsActivityCorrelation(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_ACTIVITY_CORRELATION_CAPABILITY);
  }
  notificationsCapable(): boolean {
    return this.connected && this.hostCapabilities.has(SCHEDULED_NOTIFICATIONS_CAPABILITY);
  }
  hasHost(): boolean {
    return this.connected;
  }
  send(message: DesktopComputerHostMessage): void {
    if (!this.connected || !this.ipc.send) return;
    try {
      this.ipc.send(message, (error) => {
        if (error) this.disconnect();
      });
    } catch {
      this.disconnect();
    }
  }
  private readonly receive = (raw: unknown) => {
    let message: DesktopComputerHostMessage;
    try {
      message = Schema.decodeUnknownSync(DesktopComputerHostMessage)(raw);
    } catch {
      this.disconnect();
      return;
    }
    if (message.type === "hostCapabilities") this.hostCapabilities = new Set(message.capabilities);
    if (message.type === "status") this.state = message.status;
    if (message.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new ComputerControlError(message.error));
        else pending.resolve(message.result);
      }
    }
    for (const listener of this.listeners) listener(message);
  };
  private readonly disconnect = () => {
    this.connected = false;
    this.hostCapabilities = new Set();
    this.state = { available: false, reason: "no-host" };
    for (const listener of this.listeners) listener({ type: "status", status: this.state });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new ComputerControlError(
          pending.mutation
            ? { _tag: "OutcomeUnknown" }
            : { _tag: "Interrupted", cause: "turn-ended" },
        ),
      );
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ type: "status", status: this.state });
  };
  correlated(
    message: DesktopComputerHostMessage & { requestId: string },
    timeoutMs: number,
    mutation: boolean,
  ): Promise<unknown> {
    if (!this.connected)
      return Promise.reject(new ComputerControlError({ _tag: "Unavailable", reason: "no-host" }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        this.send({ type: "cancel", requestId: message.requestId });
        reject(
          new ComputerControlError(
            mutation
              ? { _tag: "OutcomeUnknown" }
              : { _tag: "Execution", message: "Desktop host timed out." },
          ),
        );
      }, timeoutMs);
      this.pending.set(message.requestId, { resolve, reject, timer, mutation });
      this.send(message);
    });
  }
  /** Cancel a correlated exchange locally and on the desktop; late replies are ignored. */
  abandon(requestId: string, error: ComputerControlError): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    this.send({ type: "cancel", requestId });
    pending.reject(error);
  }
  request(request: ComputerAutomationRequest): Promise<unknown> {
    const requestId = request.requestId;
    // The request has its correlation id inside the envelope.
    if (!this.connected)
      return Promise.reject(new ComputerControlError({ _tag: "Unavailable", reason: "no-host" }));
    return new Promise((resolve, reject) => {
      const mutation = isComputerMutation(request.op);
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          this.send({ type: "cancel", requestId });
          reject(
            new ComputerControlError(
              mutation
                ? { _tag: "OutcomeUnknown" }
                : { _tag: "Execution", message: "Desktop response timed out." },
            ),
          );
        },
        Math.max(1, request.deadlineAtMs - Date.now() + 2000),
      );
      this.pending.set(requestId, { resolve, reject, timer, mutation });
      this.send({ type: "request", request });
    });
  }
  onMessage(callback: (message: DesktopComputerHostMessage) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  close(): void {
    this.disconnect();
    this.ipc.off("message", this.receive);
    this.ipc.off("disconnect", this.disconnect);
  }
  static fromEnvironment(profileId: string): DesktopComputerHost {
    return new DesktopComputerHost(
      profileId,
      process.env.F5_DESKTOP_BACKEND_INCARNATION ?? randomUUID(),
    );
  }
}
