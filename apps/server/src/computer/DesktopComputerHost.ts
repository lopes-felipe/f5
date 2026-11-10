import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  SCHEDULED_NOTIFICATIONS_CAPABILITY,
  OPEN_EXTERNAL_URL_CAPABILITY,
  COMPUTER_BACKGROUND_CAPABILITY,
  COMPUTER_SESSION_LIFECYCLE_CAPABILITY,
  COMPUTER_GRANT_FORGET_CAPABILITY,
  COMPUTER_REMEMBERED_CONSENT_CAPABILITY,
  COMPUTER_COOPERATION_CAPABILITY,
  COMPUTER_TAKEOVER_RESERVATION_CAPABILITY,
  COMPUTER_SHARED_APP_CAPABILITY,
  COMPUTER_BACKGROUND_EVENTS_CAPABILITY,
  COMPUTER_AGENT_IDENTITY_CAPABILITY,
  COMPUTER_ACTIVITY_CORRELATION_CAPABILITY,
  COMPUTER_CHROME_CALLS_CAPABILITY,
  COMPUTER_CHROME_CALL_ADMISSION_CAPABILITY,
  COMPUTER_CHROME_RELEASE_CAPABILITY,
  DesktopComputerHostMessage,
  type ComputerAutomationBackendStatus,
  type ComputerAutomationRequest,
  type OpenExternalUrlStatus,
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
  private closed = false;
  private state: ComputerAutomationBackendStatus = { available: false, reason: "no-host" };
  private readonly pending = new Map<string, Pending>();
  private readonly browserPending = new Map<
    string,
    {
      resolve: (status: OpenExternalUrlStatus | "unavailable") => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<(message: DesktopComputerHostMessage) => void>();
  private connected = false;
  private awaitingHost = false;
  private hostCapabilities = new Set<string>();
  constructor(
    readonly profileId: string,
    readonly backendIncarnation: string,
    private readonly ipc: ComputerIpcProcess = process,
    enabled = process.env.F5_DESKTOP_COMPUTER_HOST === "ipc",
  ) {
    if (!enabled || !ipc.send || ipc.connected === false) return;
    this.connected = true;
    this.awaitingHost = true;
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
        OPEN_EXTERNAL_URL_CAPABILITY,
        COMPUTER_BACKGROUND_CAPABILITY,
        COMPUTER_SESSION_LIFECYCLE_CAPABILITY,
        COMPUTER_GRANT_FORGET_CAPABILITY,
        COMPUTER_REMEMBERED_CONSENT_CAPABILITY,
        COMPUTER_COOPERATION_CAPABILITY,
        COMPUTER_TAKEOVER_RESERVATION_CAPABILITY,
        COMPUTER_SHARED_APP_CAPABILITY,
        COMPUTER_BACKGROUND_EVENTS_CAPABILITY,
        COMPUTER_AGENT_IDENTITY_CAPABILITY,
        COMPUTER_ACTIVITY_CORRELATION_CAPABILITY,
        COMPUTER_CHROME_CALLS_CAPABILITY,
        COMPUTER_CHROME_CALL_ADMISSION_CAPABILITY,
        COMPUTER_CHROME_RELEASE_CAPABILITY,
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
  sessionLifecycleCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_SESSION_LIFECYCLE_CAPABILITY);
  }
  grantForgetCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_GRANT_FORGET_CAPABILITY);
  }
  rememberedConsentCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_REMEMBERED_CONSENT_CAPABILITY);
  }
  cooperationCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_COOPERATION_CAPABILITY);
  }
  takeoverReservationCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_TAKEOVER_RESERVATION_CAPABILITY);
  }
  backgroundEventsCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_BACKGROUND_EVENTS_CAPABILITY);
  }
  /** Install before sending the corresponding request, including synchronous IPC transports. */
  awaitEvent(
    matches: (message: DesktopComputerHostMessage) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.connected)
      return Promise.reject(new ComputerControlError({ _tag: "Unavailable", reason: "no-host" }));
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(
          signal?.reason ?? new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }),
        );
      const off = this.onMessage((message) => {
        if (message.type === "status" && !this.connected) abort();
        else if (matches(message)) finish();
      });
      const timer = setTimeout(
        () =>
          finish(
            new ComputerControlError({
              _tag: "Execution",
              message: "Desktop reservation timed out.",
            }),
          ),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  /** Main sends capabilities before status; a legacy host settles readiness with status alone. */
  async handshake(): Promise<void> {
    if (!this.connected || this.hostCapabilities.size || this.state.available || !this.awaitingHost)
      return;
    await new Promise<void>((resolve) => {
      const off = this.onMessage((message) => {
        if (message.type !== "hostCapabilities" && message.type !== "status") return;
        clearTimeout(timer);
        off();
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        resolve();
      }, 2000);
    });
  }
  awaitingHandshake(): boolean {
    return this.connected && this.awaitingHost;
  }
  supportsAgentIdentity(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_AGENT_IDENTITY_CAPABILITY);
  }
  supportsActivityCorrelation(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_ACTIVITY_CORRELATION_CAPABILITY);
  }
  /** Main understands `chromeCallsChanged`; older mains disconnect on unknown messages. */
  chromeCallsCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_CHROME_CALLS_CAPABILITY);
  }
  /** Main admits each Chrome call (`callId`) and understands `chromeCallEnded`. */
  chromeCallAdmissionCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_CHROME_CALL_ADMISSION_CAPABILITY);
  }
  /** Main routes Chrome release requests across profiles and sends waiting blockers. */
  chromeReleaseCapable(): boolean {
    return this.connected && this.hostCapabilities.has(COMPUTER_CHROME_RELEASE_CAPABILITY);
  }
  notificationsCapable(): boolean {
    return this.connected && this.hostCapabilities.has(SCHEDULED_NOTIFICATIONS_CAPABILITY);
  }
  hasHost(): boolean {
    return this.connected;
  }
  /** `preapproved`: the requesting thread is in full access, so the desktop skips its prompt. */
  openExternalUrl(
    url: string,
    options?: { preapproved?: boolean },
  ): Promise<OpenExternalUrlStatus | "unavailable"> {
    if (!this.connected || !this.hostCapabilities.has(OPEN_EXTERNAL_URL_CAPABILITY))
      return Promise.resolve("unavailable");
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.browserPending.delete(id);
        resolve("unavailable");
      }, 330_000);
      this.browserPending.set(id, { resolve, timer });
      this.send({
        type: "openExternalUrlRequest",
        id,
        url,
        ...(options?.preapproved ? { preapproved: true } : {}),
      });
    });
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
    if (message.type === "hostCapabilities") {
      this.hostCapabilities = new Set(message.capabilities);
      this.awaitingHost = false;
    }
    if (message.type === "status") {
      this.state = message.status;
      this.awaitingHost = false;
    }
    if (message.type === "openExternalUrlResult") {
      const pending = this.browserPending.get(message.id);
      if (pending) {
        this.browserPending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message.status);
      }
      return;
    }
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
    for (const pending of this.browserPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve("unavailable");
    }
    this.browserPending.clear();
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
  /**
   * Cancel a correlated exchange locally and on the desktop; late replies are ignored. The
   * rejection is usually a `ComputerControlError`, but abort-driven callers pass their signal's
   * reason as-is (e.g. a wait's deadline sentinel), so their own handlers can tell the causes
   * apart. Consumers must not assume an error shape.
   */
  abandon(requestId: string, error: unknown): void {
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
    if (this.closed) return;
    this.closed = true;
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
