import type { ChildProcess } from "node:child_process";
import { Schema } from "effect";
import {
  DesktopComputerHostMessage,
  type ComputerAccessAnswer,
  type ComputerAutomationBackendStatus,
  type ComputerAccessRequested,
  type ComputerLeaseHolder,
  type ChromeLeaseHolder,
} from "@t3tools/contracts";
import { computerError, ComputerControlError } from "@t3tools/shared/computerControl";
import type { ComputerController } from "./ComputerController";
import { ChromeLeaseAuthority } from "./ChromeLeaseAuthority";

interface Backend {
  child: ChildProcess;
  incarnation: string;
  ready: boolean;
  pendingAccess: Set<string>;
}
/** Inherited private process IPC is the only registration, execute and consent transport. */
export class ComputerHostChannel {
  private readonly backends = new Map<string, Backend>();
  readonly chrome = new ChromeLeaseAuthority((holder) => {
    for (const profileId of this.backends.keys()) this.sendChromeLease(profileId, holder);
    this.chromeOptions?.changed?.(holder);
  });
  constructor(
    private readonly controller: ComputerController,
    private readonly status: () => ComputerAutomationBackendStatus,
    private readonly attention: (profileId: string, request: ComputerAccessRequested) => void,
    private readonly chromeOptions?: {
      certified: (provider: "claude" | "codex") => boolean;
      changed?: (holder: ChromeLeaseHolder | null) => void;
    },
  ) {}
  register(profileId: string, incarnation: string, child: ChildProcess): void {
    // Replacing an incarnation also revokes the old process's device authority.
    if (this.backends.has(profileId)) {
      this.backends.delete(profileId);
      this.controller.disconnect(profileId);
      this.chrome.releaseProfile(profileId);
    }
    const backend: Backend = { child, incarnation, ready: false, pendingAccess: new Set() };
    this.backends.set(profileId, backend);
    child.on("message", (raw: unknown) => {
      if (this.backends.get(profileId) !== backend) return;
      let message: DesktopComputerHostMessage;
      try {
        message = Schema.decodeUnknownSync(DesktopComputerHostMessage)(raw);
      } catch {
        child.disconnect();
        return;
      }
      if (!backend.ready) {
        if (
          message.type !== "hello" ||
          message.profileId !== profileId ||
          message.backendIncarnation !== incarnation ||
          message.protocolVersion !== 1
        ) {
          child.disconnect();
          return;
        }
        backend.ready = true;
        this.send(profileId, { type: "status", status: this.status() });
        this.sendLease(profileId, this.controller.lease.current());
        if (this.chrome.current()) this.sendChromeLease(profileId, this.chrome.current());
        return;
      }
      const fail = (requestId: string, error: unknown) =>
        this.send(profileId, { type: "response", requestId, error: computerError(error) });
      switch (message.type) {
        case "request":
          if (message.request.authorization.profileId !== profileId) {
            child.disconnect();
            return;
          }
          {
            const status = this.status();
            if (!status.available) {
              fail(
                message.request.requestId,
                new ComputerControlError({ _tag: "Unavailable", reason: status.reason }),
              );
              return;
            }
          }
          void this.controller.invoke(message.request).then(
            (result) =>
              this.send(profileId, {
                type: "response",
                requestId: message.request.requestId,
                result,
              }),
            (error: unknown) => fail(message.request.requestId, error),
          );
          break;
        case "leaseAcquire":
          if (message.holder.profileId !== profileId || message.holder.backend !== "native") {
            child.disconnect();
            return;
          }
          try {
            this.chrome.assertNativeAvailable(profileId);
            const status = this.status();
            if (!status.available)
              throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
            const result = this.controller.acquire(message.holder);
            this.send(profileId, { type: "response", requestId: message.requestId, result });
          } catch (error) {
            fail(message.requestId, error);
          }
          break;
        case "chromeLeaseAcquire":
          if (message.holder.profileId !== profileId) {
            child.disconnect();
            return;
          }
          try {
            if (!this.chromeOptions?.certified(message.holder.provider))
              throw new ComputerControlError({ _tag: "Unavailable", reason: "not-certified" });
            const status = this.status();
            if (!status.available)
              throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
            this.chrome.acquire(message.holder, this.controller.lease.current());
            this.send(profileId, { type: "response", requestId: message.requestId, result: true });
          } catch (error) {
            fail(message.requestId, error);
          }
          break;
        case "chromeLeaseRelease":
          if (message.holder.profileId === profileId) this.chrome.release(message.holder);
          this.send(profileId, { type: "response", requestId: message.requestId, result: true });
          break;
        case "chromeLeaseValidate":
          if (message.holder.profileId !== profileId) {
            child.disconnect();
            return;
          }
          try {
            if (!this.chromeOptions?.certified(message.holder.provider))
              throw new ComputerControlError({ _tag: "Unavailable", reason: "not-certified" });
            const status = this.status();
            if (!status.available)
              throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
            this.chrome.validate(message.holder);
            this.send(profileId, { type: "response", requestId: message.requestId, result: true });
          } catch (error) {
            fail(message.requestId, error);
          }
          break;
        case "leaseRelease":
          if (message.holder.profileId === profileId) this.controller.lease.release(message.holder);
          break;
        case "grantsChanged":
          if (message.authorization.profileId === profileId)
            this.controller.updateGrants(message.authorization);
          break;
        case "cancel":
          backend.pendingAccess.delete(message.requestId);
          this.controller.cancel(message.requestId, profileId);
          break;
        case "pauseChanged":
          try {
            if (!this.pauseChrome(profileId, message.threadId, message.paused))
              this.controller.setPaused(profileId, message.threadId, message.paused);
          } catch {
            /* A failed resume keeps the native latch set. */
          }
          break;
        case "resumeRequested":
          try {
            if (!this.pauseChrome(profileId, message.threadId, false))
              this.controller.setPaused(profileId, message.threadId, false);
            this.send(profileId, {
              type: "pauseChanged",
              threadId: message.threadId,
              paused: false,
            });
          } catch {
            /* Fail closed; no resume notification. */
          }
          break;
        case "accessRequested":
          backend.pendingAccess.add(message.request.requestId);
          this.attention(profileId, message.request);
          break;
        default:
          child.disconnect();
      }
    });
    const disconnected = () => {
      if (this.backends.get(profileId) !== backend) return;
      this.backends.delete(profileId);
      this.controller.disconnect(profileId);
      this.chrome.releaseProfile(profileId);
    };
    child.once("disconnect", disconnected);
    child.once("exit", disconnected);
  }
  private sendChromeLease(profileId: string, holder: ChromeLeaseHolder | null): void {
    this.send(profileId, {
      type: "chromeLeaseChanged",
      holder: holder?.profileId === profileId ? holder : null,
      otherProfile: holder !== null && holder.profileId !== profileId,
    });
  }
  pauseChrome(profileId: string, threadId: string, paused: boolean): boolean {
    const holder = this.chrome.current();
    if (!holder || holder.profileId !== profileId || holder.threadId !== threadId) return false;
    this.chrome.setPaused(holder, paused);
    this.send(profileId, { type: "pauseChanged", threadId, paused });
    return true;
  }
  send(profileId: string, message: DesktopComputerHostMessage): void {
    const backend = this.backends.get(profileId);
    if (backend?.ready && backend.child.connected) backend.child.send(message, () => undefined);
  }
  private sendLease(profileId: string, holder: ComputerLeaseHolder | null): void {
    this.send(profileId, {
      type: "leaseChanged",
      holder: holder?.profileId === profileId ? holder : null,
      otherProfile: holder !== null && holder.profileId !== profileId,
    });
  }
  publishLease(holder: ComputerLeaseHolder | null): void {
    for (const profileId of this.backends.keys()) this.sendLease(profileId, holder);
  }
  broadcast(message: DesktopComputerHostMessage): void {
    for (const profileId of this.backends.keys()) this.send(profileId, message);
  }
  answerAccess(profileId: string, answer: ComputerAccessAnswer): void {
    const backend = this.backends.get(profileId);
    if (
      !backend?.ready ||
      answer.backendIncarnation !== backend.incarnation ||
      !backend.pendingAccess.delete(answer.requestId)
    )
      throw new Error("This request expired or belongs to another backend.");
    this.send(profileId, { type: "accessAnswer", answer });
  }
  incarnation(profileId: string): string | undefined {
    return this.backends.get(profileId)?.incarnation;
  }
}
