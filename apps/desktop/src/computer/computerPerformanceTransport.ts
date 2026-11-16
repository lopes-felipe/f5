// Rehearsal-only adapter for scripts/performance-computer.mjs, never a production transport.
import { EventEmitter } from "node:events";
import type {
  ComputerAutomationBackendStatus,
  DesktopComputerHostMessage as Message,
} from "@t3tools/contracts";
import { DesktopComputerHostMessage } from "@t3tools/contracts";
import { COMPUTER_COOPERATION_CAPABILITY } from "@t3tools/contracts";
import { Schema } from "effect";
import { computerError, ComputerControlError } from "@t3tools/shared/computerControl";
import type { ComputerController } from "./ComputerController";
import type { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";

/** Rehearsal-only transport. It cannot grant access, resolve other apps or acquire takeovers. */
export class ComputerPerformanceTransport extends EventEmitter {
  connected = true;
  resolutions = 0;
  constructor(
    private readonly options: {
      profileId: string;
      allowedApps: ReadonlySet<string>;
      status: () => ComputerAutomationBackendStatus;
      controller: Pick<
        ComputerController,
        | "updateGrants"
        | "prepareAcquisition"
        | "acquire"
        | "invoke"
        | "cancel"
        | "setPaused"
        | "invalidateThread"
      >;
      lease: Pick<ComputerLeaseAuthority, "release">;
      probe?: (stage: string, elapsedMs: number) => void;
    },
  ) {
    super();
  }
  send(raw: unknown, callback: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback(new Error("Rehearsal transport closed."));
      return false;
    }
    let message: Message;
    try {
      message = Schema.decodeUnknownSync(DesktopComputerHostMessage)(raw);
    } catch {
      callback(new Error("Invalid rehearsal transport message."));
      return false;
    }
    callback(null);
    queueMicrotask(() => {
      void this.receive(message);
    });
    return true;
  }
  close(): void {
    this.connected = false;
    this.emit("disconnect");
  }
  private async receive(message: Message): Promise<void> {
    if (!this.connected) return;
    const { controller, lease, profileId, allowedApps } = this.options;
    const refuse = () => {
      throw new ComputerControlError({
        _tag: "Execution",
        message: "Only synthetic foreground fixtures are allowed.",
      });
    };
    const reply = (requestId: string, result: unknown) =>
      this.emit("message", { type: "response", requestId, result });
    try {
      switch (message.type) {
        case "hello":
          if (message.profileId !== profileId) refuse();
          this.emit("message", {
            type: "hostCapabilities",
            capabilities: [COMPUTER_COOPERATION_CAPABILITY],
          });
          this.emit("message", { type: "status", status: this.options.status() });
          break;
        case "grantsChanged":
          if (
            message.authorization.profileId !== profileId ||
            message.authorization.grants.some((grant) => !allowedApps.has(grant.appId))
          )
            refuse();
          controller.updateGrants(message.authorization);
          break;
        case "leaseAcquire":
          if (
            message.holder.profileId !== profileId ||
            message.holder.scope.kind !== "foreground" ||
            message.holder.grants.some((grant) => !allowedApps.has(grant.appId))
          )
            refuse();
          controller.updateGrants(message.holder);
          const { cooperative: _callerCooperative, ...legacyHolder } = message.holder;
          const holder = { ...legacyHolder, ...(message.cooperative ? { cooperative: true } : {}) };
          await controller.prepareAcquisition(holder);
          reply(message.requestId, controller.acquire(holder));
          break;
        case "leaseRelease":
          if (message.holder.profileId !== profileId) refuse();
          lease.release(message.holder);
          break;
        case "request": {
          const request = message.request;
          if (
            request.authorization.profileId !== profileId ||
            request.authorization.grants.some((grant) => !allowedApps.has(grant.appId))
          )
            refuse();
          if ("appId" in request && request.appId && !allowedApps.has(request.appId)) refuse();
          if (request.op === "listApps") refuse();
          if (request.op === "resolveApps") {
            if (request.queries.some((query) => !allowedApps.has(query))) refuse();
            this.resolutions++;
          }
          const started = performance.now();
          const value = await controller.invoke(request);
          if (request.op === "resolveApps") {
            try {
              this.options.probe?.("tool.app-resolution", performance.now() - started);
            } catch {
              /* Diagnostic callbacks cannot change native outcomes. */
            }
          }
          reply(request.requestId, value);
          break;
        }
        case "cancel":
          controller.cancel(message.requestId, profileId);
          break;
        case "pauseChanged":
          controller.setPaused(profileId, message.threadId, message.paused);
          break;
        case "observationInvalidate":
          await controller.invalidateThread(profileId, message.threadId, message.policyRevision);
          reply(message.requestId, true);
          break;
        case "accessRequested":
          refuse();
          break;
      }
    } catch (cause) {
      const requestId =
        message.type === "request"
          ? message.request.requestId
          : "requestId" in message
            ? message.requestId
            : undefined;
      if (requestId)
        this.emit("message", { type: "response", requestId, error: computerError(cause) });
    }
  }
}
