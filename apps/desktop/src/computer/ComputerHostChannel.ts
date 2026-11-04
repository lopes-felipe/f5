import { ComputerGrantAuthority } from "./ComputerGrantAuthority";
import type { ChildProcess } from "node:child_process";
import { Schema } from "effect";
import {
  SCHEDULED_NOTIFICATIONS_CAPABILITY,
  OPEN_EXTERNAL_URL_CAPABILITY,
  type OpenExternalUrlStatus,
  COMPUTER_BACKGROUND_CAPABILITY,
  COMPUTER_SESSION_LIFECYCLE_CAPABILITY,
  COMPUTER_GRANT_FORGET_CAPABILITY,
  COMPUTER_AGENT_IDENTITY_CAPABILITY,
  COMPUTER_ACTIVITY_CORRELATION_CAPABILITY,
  COMPUTER_CHROME_CALLS_CAPABILITY,
  DesktopComputerHostMessage,
  type ComputerAccessAnswer,
  type ComputerAutomationBackendStatus,
  type ComputerAccessRequested,
  type ComputerBackgroundStatus,
  type ComputerLeaseHolder,
  type ChromeLeaseHolder,
  type ChromeProcessRegistration,
} from "@t3tools/contracts";
import { computerError, ComputerControlError } from "@t3tools/shared/computerControl";
import type { ComputerController, ComputerExecutionStateUpdate } from "./ComputerController";
import { ChromeLeaseAuthority } from "./ChromeLeaseAuthority";
import type { ChromeProcessSupervisor } from "./ChromeProcessSupervisor";
import { sameComputerHolder } from "./ComputerLeaseAuthority";
import { ComputerExecutionAuthority } from "./ComputerExecutionAuthority";
import { ComputerTakeoverCoordinator } from "./ComputerTakeoverCoordinator";
import {
  alwaysAllowableIntegration,
  type AlwaysAllowableIntegration,
} from "./IntegrationConsentStore";

interface Backend {
  child: ChildProcess;
  incarnation: string;
  ready: boolean;
  capabilities: ReadonlySet<string>;
  pendingAccess: Map<string, ComputerAccessRequested>;
  acquisitions: Map<string, ComputerLeaseHolder>;
}
function chromeCallsKey(holder: {
  profileId: string;
  threadId: string;
  sessionGeneration: string;
}): string {
  return `${holder.profileId}\u0000${holder.threadId}\u0000${holder.sessionGeneration}`;
}
/** Inherited private process IPC is the only registration, execute and consent transport. */
export class ComputerHostChannel {
  private readonly backends = new Map<string, Backend>();
  readonly chrome: ChromeLeaseAuthority;
  /** Whether a backend's Chrome session runs a browser call (`chromeCallsChanged`). */
  private readonly chromeCalls = new Map<string, boolean>();
  /** The Chrome holder last announced, so its report ends with its lease. */
  private chromeCallsHolder: ChromeLeaseHolder | null = null;
  /** Builtin (Sky) holders kept after a disconnect until main observes the child exit. */
  private readonly builtinQuarantine = new Map<string, ComputerLeaseHolder[]>();
  readonly execution: ComputerExecutionAuthority;
  readonly takeovers: ComputerTakeoverCoordinator;
  constructor(
    private readonly controller: ComputerController,
    private readonly status: () => ComputerAutomationBackendStatus,
    private readonly attention: (profileId: string, request: ComputerAccessRequested) => void,
    private readonly chromeOptions?: {
      certified: (provider: "claude" | "codex") => boolean;
      /** Codex Computer Use (Sky); absent means closed. */
      builtinCertified?: () => boolean;
      changed?: (holder: ChromeLeaseHolder | null) => void;
      supervisor?: ChromeProcessSupervisor;
      /** Signature check for an adopted process and its parent, by PID; returns why it fails. */
      verifyAdoption?: (parentPid: number, runtimePid: number) => Promise<string | undefined>;
      /** The profile chose "always allow" for this integration in main's dialog. */
      alwaysAllowed?: (profileId: string, integration: AlwaysAllowableIntegration) => boolean;
    },
    private readonly grants = new ComputerGrantAuthority(
      process.platform === "win32" ? "win32" : "darwin",
    ),
    private readonly options: {
      /** Desktop + helper side of background availability; the backend adds its own. */
      background?: () => ComputerBackgroundStatus;
      execution?: ComputerExecutionAuthority;
      /**
       * Whether this build offers background delivery at all (the preview gate). When it is
       * closed, Electron never answers with the capability, so foreground-only users keep the
       * legacy single-holder protocol and none of the background paths run.
       */
      advertiseBackground?: boolean;
      notificationAvailable?: () => boolean;
      notification?: (
        profileId: string,
        notification: import("@t3tools/contracts").DesktopScheduledNotification,
      ) => boolean;
      openExternalUrl?: (
        profileId: string,
        url: string,
        options?: { preapproved?: boolean },
      ) => Promise<OpenExternalUrlStatus>;
      cancelBrowserOpen?: (profileId: string) => void;
      grantForgetFailed?: (profileId: string, message: string) => void;
    } = {},
  ) {
    this.chrome = new ChromeLeaseAuthority((holder) => {
      // A report outlives only its own lease; a later holder starts unknown.
      const previous = this.chromeCallsHolder;
      if (previous && (!holder || chromeCallsKey(previous) !== chromeCallsKey(holder)))
        this.chromeCalls.delete(chromeCallsKey(previous));
      this.chromeCallsHolder = holder;
      for (const profileId of this.backends.keys()) this.sendChromeLease(profileId, holder);
      this.chromeOptions?.changed?.(holder);
    }, chromeOptions?.supervisor);
    this.execution = options.execution ?? new ComputerExecutionAuthority();
    this.takeovers = new ComputerTakeoverCoordinator(controller, this.execution, {
      state: (profileId, holder, state) =>
        this.sendExecutionState(profileId, {
          threadId: holder.threadId,
          sessionGeneration: holder.sessionGeneration,
          state,
          delivery: "foreground",
          ...(holder.scope.kind !== "foreground" ? { appId: holder.scope.appId } : {}),
        }),
    });
  }
  private capable(backend: Backend | undefined): boolean {
    return backend?.capabilities.has(COMPUTER_BACKGROUND_CAPABILITY) ?? false;
  }
  /** Status as one backend sees it: only capable peers learn about background delivery. */
  private statusFor(backend: Backend): ComputerAutomationBackendStatus {
    const status = this.status();
    if (!status.available || !this.capable(backend)) return status;
    return {
      ...status,
      background: this.options.background?.() ?? {
        available: false,
        reason: "peer-capability",
      },
    };
  }
  private disconnectProfile(profileId: string): void {
    this.options.cancelBrowserOpen?.(profileId);
    const builtin = this.controller.lease
      .holders()
      .filter((holder) => holder.profileId === profileId && holder.backend !== "native");
    this.takeovers.cancelThread(profileId);
    this.controller.disconnect(profileId);
    this.grants.disconnect(profileId);
    this.execution.disconnect(profileId);
    // A gone backend can't report its calls any more: its Chrome lease reads as unknown.
    const prefix = `${profileId}\u0000`;
    for (const key of this.chromeCalls.keys())
      if (key.startsWith(prefix)) this.chromeCalls.delete(key);
    // Main stops the profile's registered children and keeps Chrome until they exit.
    this.chrome.releaseProfile(profileId, "unresponsive");
    // A drain changes no holder, so nothing announced it: other profiles re-learn the lease,
    // now unreported and so busy, while it may still be acting with no backend to gate it.
    const draining = this.chrome.current();
    if (draining?.profileId === profileId) this.sendChromeLeaseToOthers(draining);
    this.quarantineBuiltin(profileId, builtin);
  }
  /** A disconnected Sky client may still act: keep its foreground lease until it exits. */
  private quarantineBuiltin(profileId: string, holders: ReadonlyArray<ComputerLeaseHolder>): void {
    const supervisor = this.chromeOptions?.supervisor;
    if (
      !holders.length ||
      !supervisor?.alive(
        (registration) =>
          registration.profileId === profileId && registration.integration === "codex-computer",
      )
    )
      return;
    const kept: ComputerLeaseHolder[] = [];
    for (const holder of holders) {
      try {
        kept.push(this.controller.lease.acquire(holder));
      } catch {
        // Another holder already owns the machine; nothing to quarantine.
      }
    }
    if (kept.length) this.builtinQuarantine.set(profileId, kept);
  }
  /** Main observed a registered integration process exit. */
  processExited(registration: ChromeProcessRegistration): void {
    this.chrome.processExited();
    const supervisor = this.chromeOptions?.supervisor;
    const quarantined = this.builtinQuarantine.get(registration.profileId);
    if (
      quarantined &&
      !supervisor?.alive(
        (entry) =>
          entry.profileId === registration.profileId && entry.integration === "codex-computer",
      )
    ) {
      this.builtinQuarantine.delete(registration.profileId);
      for (const holder of quarantined) this.controller.lease.release(holder);
    }
  }
  register(profileId: string, incarnation: string, child: ChildProcess): void {
    // Replacing an incarnation also revokes the old process's device authority.
    if (this.backends.has(profileId)) {
      this.backends.delete(profileId);
      this.disconnectProfile(profileId);
    }
    const backend: Backend = {
      child,
      incarnation,
      ready: false,
      capabilities: new Set(),
      pendingAccess: new Map(),
      acquisitions: new Map(),
    };
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
        backend.capabilities = new Set(
          (message.capabilities ?? []).filter(
            (capability) =>
              (capability === SCHEDULED_NOTIFICATIONS_CAPABILITY &&
                !!this.options.notification &&
                this.options.notificationAvailable?.() !== false) ||
              capability === COMPUTER_AGENT_IDENTITY_CAPABILITY ||
              capability === COMPUTER_ACTIVITY_CORRELATION_CAPABILITY ||
              capability === COMPUTER_CHROME_CALLS_CAPABILITY ||
              capability === COMPUTER_SESSION_LIFECYCLE_CAPABILITY ||
              capability === COMPUTER_GRANT_FORGET_CAPABILITY ||
              (capability === OPEN_EXTERNAL_URL_CAPABILITY && !!this.options.openExternalUrl) ||
              (capability === COMPUTER_BACKGROUND_CAPABILITY &&
                this.options.advertiseBackground !== false),
          ),
        );
        if (backend.capabilities.size)
          this.send(profileId, {
            type: "hostCapabilities",
            capabilities: [...backend.capabilities],
          });
        this.send(profileId, { type: "status", status: this.statusFor(backend) });
        this.sendLeases(profileId);
        if (this.chrome.current() || this.chrome.recoveryRequired())
          this.sendChromeLease(profileId, this.chrome.current());
        return;
      }
      const fail = (requestId: string, error: unknown) =>
        this.send(profileId, { type: "response", requestId, error: computerError(error) });
      switch (message.type) {
        case "openExternalUrlRequest":
          if (!backend.capabilities.has(OPEN_EXTERNAL_URL_CAPABILITY)) return;
          void (
            message.preapproved === true
              ? this.options.openExternalUrl!(profileId, message.url, { preapproved: true })
              : this.options.openExternalUrl!(profileId, message.url)
          ).then(
            (status) => {
              if (this.backends.get(profileId) === backend)
                this.send(profileId, { type: "openExternalUrlResult", id: message.id, status });
            },
            () => {
              if (this.backends.get(profileId) === backend)
                this.send(profileId, {
                  type: "openExternalUrlResult",
                  id: message.id,
                  status: "denied",
                });
            },
          );
          return;
        case "scheduledNotification":
          if (
            backend.capabilities.has(SCHEDULED_NOTIFICATIONS_CAPABILITY) &&
            this.options.notification?.(profileId, message.notification)
          )
            this.send(profileId, { type: "scheduledNotificationAck", id: message.notification.id });
          return;
        case "request":
          if (message.request.authorization.profileId !== profileId) {
            child.disconnect();
            return;
          }
          if (
            message.request.agent.provider !== "claude" &&
            message.request.agent.provider !== "codex" &&
            !backend.capabilities.has(COMPUTER_AGENT_IDENTITY_CAPABILITY)
          ) {
            fail(
              message.request.requestId,
              new ComputerControlError({
                _tag: "Execution",
                message: "Update F5 to use computer control with this agent.",
              }),
            );
            return;
          }
          // Background delivery is only accepted from peers that negotiated it.
          if (message.request.delivery === "background" && !this.capable(backend)) {
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
          if (
            message.holder.profileId !== profileId ||
            message.holder.backend !== "native" ||
            // Takeovers need approval; background scopes need a negotiated peer.
            message.holder.scope.kind === "takeover" ||
            (message.holder.scope.kind === "app" && !this.capable(backend))
          ) {
            child.disconnect();
            return;
          }
          try {
            this.chrome.assertNativeAvailable(profileId, message.holder.scope);
            const status = this.status();
            if (!status.available)
              throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
            if (backend.acquisitions.size >= 32)
              throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
            if (
              !this.execution.revisionAccepted(
                profileId,
                message.holder.threadId,
                message.holder.policyRevision,
              )
            )
              throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
            if (
              message.holder.scope.kind === "app" &&
              !this.execution.hasSessionApproval(
                profileId,
                incarnation,
                message.holder.threadId,
                message.holder.sessionGeneration,
              )
            )
              throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
            const result = this.controller.acquire(message.holder);
            backend.acquisitions.set(message.requestId, result);
            this.send(profileId, { type: "response", requestId: message.requestId, result });
          } catch (error) {
            fail(message.requestId, error);
          }
          break;
        case "foregroundTakeoverAcquire": {
          if (
            message.holder.profileId !== profileId ||
            !this.capable(backend) ||
            message.holder.scope.kind !== "takeover"
          ) {
            child.disconnect();
            return;
          }
          const requestId = message.requestId;
          try {
            this.chrome.assertNativeAvailable(profileId);
            this.takeovers.request(
              profileId,
              incarnation,
              requestId,
              message.approvalRequestId,
              message.holder,
              (outcome) => {
                if (this.backends.get(profileId) !== backend) return;
                if ("error" in outcome) fail(requestId, new ComputerControlError(outcome.error));
                else {
                  backend.acquisitions.set(requestId, outcome.holder);
                  this.send(profileId, {
                    type: "response",
                    requestId,
                    result: outcome.holder,
                  });
                }
              },
            );
          } catch (error) {
            fail(requestId, error);
          }
          break;
        }
        case "observationInvalidate": {
          const requestId = message.requestId;
          this.execution.advanceRevision(profileId, message.threadId, message.policyRevision);
          this.takeovers.cancelThread(profileId, message.threadId);
          void this.controller
            .invalidateThread(profileId, message.threadId, message.policyRevision)
            .then(
              () => this.send(profileId, { type: "response", requestId, result: true }),
              (error: unknown) => fail(requestId, error),
            );
          break;
        }
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
            // ⌃⌘Esc stopped this generation; nothing in it may act until the user resumes.
            if (
              this.chromeOptions?.supervisor?.invalidated(
                profileId,
                message.holder.threadId,
                message.holder.sessionGeneration,
              )
            )
              throw new ComputerControlError({ _tag: "Interrupted", cause: "kill-switch" });
            // Released native holders may still be executing; Chrome waits for their drain.
            if (this.controller.nativeWorkConflicts("chrome"))
              throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
            this.chrome.acquire(message.holder, this.controller.lease.chromeConflict(profileId));
            this.send(profileId, { type: "response", requestId: message.requestId, result: true });
          } catch (error) {
            fail(message.requestId, error);
          }
          break;
        case "chromeRestoreAcquire":
          if (message.holder.profileId !== profileId) {
            child.disconnect();
            return;
          }
          try {
            // Restoring setup files launches nothing, so it needs no certified record or
            // helper; it still excludes Chrome sessions, native work and recovery.
            if (this.controller.nativeWorkConflicts("chrome"))
              throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
            this.chrome.acquire(message.holder, this.controller.lease.chromeConflict(profileId));
            this.send(profileId, { type: "response", requestId: message.requestId, result: true });
          } catch (error) {
            fail(message.requestId, error);
          }
          break;
        case "chromeCallsChanged": {
          if (!backend.capabilities.has(COMPUTER_CHROME_CALLS_CAPABILITY)) break;
          // Keyed by the sending backend, so no profile can report another's calls.
          const key = chromeCallsKey({
            profileId,
            threadId: message.threadId,
            sessionGeneration: message.sessionGeneration,
          });
          const holder = this.chrome.current();
          const before = holder ? this.chromeBusyForOthers(holder) : undefined;
          if (message.running === null) this.chromeCalls.delete(key);
          else this.chromeCalls.set(key, message.running);
          if (
            holder &&
            holder.profileId === profileId &&
            before !== this.chromeBusyForOthers(holder)
          )
            this.sendChromeLeaseToOthers(holder);
          break;
        }
        case "chromeLeaseRelease":
          if (message.holder.profileId === profileId) this.chrome.release(message.holder);
          this.send(profileId, { type: "response", requestId: message.requestId, result: true });
          break;
        case "chromeProcessRegister": {
          const registration = message.registration;
          if (
            registration.profileId !== profileId ||
            registration.backendIncarnation !== incarnation
          ) {
            child.disconnect();
            return;
          }
          const supervisor = this.chromeOptions?.supervisor;
          if (!supervisor || child.pid === undefined) {
            fail(
              message.requestId,
              new ComputerControlError({ _tag: "Unavailable", reason: "not-certified" }),
            );
            break;
          }
          void supervisor.register(registration, child.pid).then(
            () =>
              this.send(profileId, {
                type: "response",
                requestId: message.requestId,
                result: true,
              }),
            (error: unknown) =>
              fail(
                message.requestId,
                new ComputerControlError({
                  _tag: "Execution",
                  message: error instanceof Error ? error.message : "Registration failed.",
                }),
              ),
          );
          break;
        }
        case "chromeProcessAdopt": {
          const adoption = message.adoption;
          if (adoption.profileId !== profileId || adoption.backendIncarnation !== incarnation) {
            child.disconnect();
            return;
          }
          const supervisor = this.chromeOptions?.supervisor;
          const verify = this.chromeOptions?.verifyAdoption;
          if (
            !supervisor ||
            !verify ||
            child.pid === undefined ||
            adoption.integration !== "codex-chrome" ||
            !this.chromeOptions?.certified("codex")
          ) {
            fail(
              message.requestId,
              new ComputerControlError({ _tag: "Unavailable", reason: "not-certified" }),
            );
            break;
          }
          void supervisor.adopt(adoption, child.pid, verify).then(
            (registration) =>
              this.send(profileId, {
                type: "response",
                requestId: message.requestId,
                result: registration,
              }),
            (error: unknown) =>
              fail(
                message.requestId,
                new ComputerControlError({
                  _tag: "Execution",
                  message: error instanceof Error ? error.message : "Adoption failed.",
                }),
              ),
          );
          break;
        }
        case "chromeProcessStop":
          // Only this backend's own registrations; anything else is ignored.
          this.chromeOptions?.supervisor?.stop(
            (registration) =>
              registration.launchToken === message.launchToken &&
              registration.profileId === profileId &&
              registration.backendIncarnation === incarnation,
            message.reason ?? "unresponsive",
          );
          break;
        case "chromeProcessExited":
          this.chromeOptions?.supervisor?.reportedExit(message.launchToken);
          break;
        case "builtinLeaseAcquire":
        case "builtinLeaseValidate":
        case "builtinLeaseRelease": {
          if (
            message.holder.profileId !== profileId ||
            message.holder.backend === "native" ||
            message.holder.scope.kind !== "foreground"
          ) {
            child.disconnect();
            return;
          }
          try {
            if (message.type === "builtinLeaseRelease") {
              this.controller.lease.release(message.holder);
              this.send(profileId, {
                type: "response",
                requestId: message.requestId,
                result: true,
              });
              break;
            }
            if (message.type === "builtinLeaseValidate") {
              if (
                !this.controller.lease
                  .holders()
                  .some((entry) => sameComputerHolder(entry, message.holder))
              )
                throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
              this.send(profileId, {
                type: "response",
                requestId: message.requestId,
                result: true,
              });
              break;
            }
            // Sky stays closed until its spike passes and `codex-computer` is certified.
            if (!this.chromeOptions?.builtinCertified?.())
              throw new ComputerControlError({ _tag: "Unavailable", reason: "not-certified" });
            this.chrome.assertNativeAvailable(profileId);
            if (this.controller.nativeWorkConflicts(message.holder.scope))
              throw new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" });
            const result = this.controller.lease.acquire(message.holder);
            this.send(profileId, { type: "response", requestId: message.requestId, result });
          } catch (error) {
            fail(message.requestId, error);
          }
          break;
        }
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
          if (message.holder.profileId === profileId) {
            this.controller.lease.release(message.holder);
            if (message.holder.scope.kind === "takeover")
              this.execution.revokeTakeovers(
                (receipt) =>
                  receipt.profileId === profileId && receipt.threadId === message.holder.threadId,
              );
          }
          break;
        case "leaseAccepted":
          backend.acquisitions.delete(message.requestId);
          break;
        case "grantForget":
          try {
            this.grants.forget(profileId, message.projectId, message.appId);
            if (message.requestId)
              this.send(profileId, { type: "response", requestId: message.requestId, result: {} });
          } catch (error) {
            if (message.requestId) fail(message.requestId, error);
            else
              this.options.grantForgetFailed?.(
                profileId,
                error instanceof Error ? error.message : "Could not forget this app.",
              );
          }
          break;
        case "computerSessionClosed":
          if (!backend.capabilities.has(COMPUTER_SESSION_LIFECYCLE_CAPABILITY)) break;
          this.grants.sessionClosed(profileId, message.threadId, message.sessionGeneration);
          this.execution.sessionClosed(profileId, message.threadId, message.sessionGeneration);
          break;
        case "grantsValidate":
          this.send(profileId, {
            type: "response",
            requestId: message.requestId,
            result: this.grants.remembered(profileId, message.projectId, message.grants),
          });
          break;
        case "grantsChanged":
          if (message.authorization.profileId === profileId) {
            this.execution.sessionChanged(
              profileId,
              message.authorization.threadId,
              message.authorization.sessionGeneration,
            );
            this.controller.updateGrants(this.grants.validate(message.authorization));
          }
          break;
        case "cancel": {
          const acquired = backend.acquisitions.get(message.requestId);
          backend.acquisitions.delete(message.requestId);
          if (acquired) this.controller.lease.release(acquired);
          // Consent cleanup removes only the consent record, never a takeover coordinator.
          backend.pendingAccess.delete(message.requestId);
          this.takeovers.cancel(profileId, message.requestId);
          this.controller.cancel(message.requestId, profileId);
          break;
        }
        case "pauseChanged":
          // Backend clients can narrow access. Only trusted local renderer IPC can resume.
          if (message.paused) {
            this.takeovers.cancelThread(profileId, message.threadId);
            if (!this.pauseChrome(profileId, message.threadId, true))
              this.controller.setPaused(profileId, message.threadId, true);
          }
          break;
        case "resumeRequested":
          break;
        case "accessRequested": {
          backend.pendingAccess.set(message.request.requestId, message.request);
          // An earlier "always allow" answers here, without a dialog. The grant is main's own.
          if (this.answerAlwaysAllowed(profileId, message.request)) break;
          this.attention(profileId, message.request);
          break;
        }
        default:
          child.disconnect();
      }
    });
    const disconnected = () => {
      if (this.backends.get(profileId) !== backend) return;
      this.backends.delete(profileId);
      this.disconnectProfile(profileId);
    };
    child.once("disconnect", disconnected);
    child.once("exit", disconnected);
  }
  private sendChromeLease(profileId: string, holder: ChromeLeaseHolder | null): void {
    this.send(profileId, {
      type: "chromeLeaseChanged",
      holder: holder?.profileId === profileId ? holder : null,
      otherProfile:
        holder !== null && holder.profileId !== profileId && this.chromeBusyForOthers(holder),
      ...(this.chrome.recoveryRequired() ? { recoveryRequired: true } : {}),
    });
  }
  /**
   * Whether other profiles' banners count this Chrome lease as control. Only a holder whose
   * backend reported no running call is idle; no report (a legacy backend, or a runtime that
   * never reports) stays busy, as the owner's own banner says "may be using Chrome".
   */
  private chromeBusyForOthers(holder: ChromeLeaseHolder): boolean {
    return this.chromeCalls.get(chromeCallsKey(holder)) !== false;
  }
  /** Re-announces the holder's lease to every profile but its own. */
  private sendChromeLeaseToOthers(holder: ChromeLeaseHolder): void {
    for (const profileId of this.backends.keys())
      if (profileId !== holder.profileId) this.sendChromeLease(profileId, holder);
  }
  /** Recovery state changed: every backend re-learns Chrome ownership. */
  publishChrome(): void {
    for (const profileId of this.backends.keys())
      this.sendChromeLease(profileId, this.chrome.current());
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
    if (
      message.type === "activity" &&
      !backend?.capabilities.has(COMPUTER_ACTIVITY_CORRELATION_CAPABILITY)
    ) {
      const {
        requestId: _requestId,
        sessionGeneration: _generation,
        ...activity
      } = message.activity;
      message = { type: "activity", activity };
    }
    if (backend?.ready && backend.child.connected) backend.child.send(message, () => undefined);
  }
  /** Capable peers get every own holder; legacy peers keep the single-holder message. */
  private sendLeases(profileId: string): void {
    const backend = this.backends.get(profileId);
    if (!backend) return;
    const holders = this.controller.lease.holders();
    const own = holders.filter((holder) => holder.profileId === profileId);
    const otherProfile =
      holders.some((holder) => holder.profileId !== profileId) ||
      (this.controller.lease.pendingTakeover()?.holder.profileId ?? profileId) !== profileId;
    if (this.capable(backend)) {
      const pending = this.controller.lease.pendingTakeover();
      this.send(profileId, {
        type: "leasesChanged",
        holders: own,
        otherProfile,
        ...(pending?.holder.profileId === profileId
          ? { pendingTakeover: { threadId: pending.holder.threadId, appId: pending.appId } }
          : {}),
      });
    } else
      this.send(profileId, {
        type: "leaseChanged",
        holder: own[0] ?? null,
        otherProfile: otherProfile && own.length === 0,
      });
  }
  publishLeases(): void {
    for (const profileId of this.backends.keys()) this.sendLeases(profileId);
  }
  /** Per-backend status: capability-dependent fields never reach legacy peers. */
  broadcastStatus(): void {
    for (const [profileId, backend] of this.backends)
      this.send(profileId, { type: "status", status: this.statusFor(backend) });
  }
  sendExecutionState(profileId: string, update: ComputerExecutionStateUpdate): void {
    if (!this.capable(this.backends.get(profileId))) return;
    this.send(profileId, {
      type: "executionStateChanged",
      threadId: update.threadId,
      sessionGeneration: update.sessionGeneration,
      state: update.state,
      ...(update.appId ? { appId: update.appId } : {}),
      ...(update.delivery ? { delivery: update.delivery } : {}),
      ...(update.pauseCause ? { pauseCause: update.pauseCause } : {}),
    });
  }
  broadcast(message: DesktopComputerHostMessage): void {
    for (const profileId of this.backends.keys()) this.send(profileId, message);
  }
  /**
   * Answers a pending request the profile always allows: a Codex Chrome session or a
   * Claude in Chrome setup.
   */
  private answerAlwaysAllowed(profileId: string, request: ComputerAccessRequested): boolean {
    const integration = alwaysAllowableIntegration(request);
    const backend = this.backends.get(profileId);
    if (!backend || !integration || !this.chromeOptions?.alwaysAllowed?.(profileId, integration))
      return false;
    try {
      this.answerAccess(profileId, {
        requestId: request.requestId,
        backendIncarnation: backend.incarnation,
        decisions: [],
        ...(request.kind === "chrome-setup"
          ? { allowChromeSetup: true }
          : { allowChromeSession: true }),
      });
      return true;
    } catch {
      // Defensive: answerAccess refuses a request that is no longer pending here.
      return false;
    }
  }
  /**
   * The profile just chose "always allow": answer its other requests for that kind still
   * waiting, such as those of threads that restarted together.
   */
  answerPendingAlwaysAllowed(profileId: string): void {
    const backend = this.backends.get(profileId);
    if (!backend) return;
    for (const request of backend.pendingAccess.values())
      this.answerAlwaysAllowed(profileId, request);
  }
  accessRequest(profileId: string, answer: ComputerAccessAnswer): ComputerAccessRequested {
    const backend = this.backends.get(profileId);
    const request = backend?.pendingAccess.get(answer.requestId);
    if (!backend?.ready || answer.backendIncarnation !== backend.incarnation || !request)
      throw new Error("This request expired or belongs to another backend.");
    return request;
  }
  answerAccess(profileId: string, answer: ComputerAccessAnswer): void {
    const backend = this.backends.get(profileId);
    const request = backend?.pendingAccess.get(answer.requestId);
    if (
      !backend?.ready ||
      !request ||
      answer.backendIncarnation !== backend.incarnation ||
      !backend.pendingAccess.delete(answer.requestId)
    )
      throw new Error("This request expired or belongs to another backend.");
    // Only this method mints session receipts; never forward one from the answer's source.
    const { sessionReceipt: _untrusted, ...base } = answer;
    answer = base;
    let forwarded: ComputerAccessAnswer = answer;
    if (request.kind === "apps") {
      try {
        forwarded = this.grants.issue(profileId, request, answer);
      } catch (error) {
        // The request has been consumed. Settle the backend before surfacing the native
        // review error; otherwise it hangs until its tool timeout.
        this.send(profileId, {
          type: "accessAnswer",
          answer: {
            ...answer,
            decisions: answer.decisions.map((decision) => ({
              ...decision,
              allow: false,
              allowTyping: false,
              remember: false,
            })),
          },
        });
        throw error;
      }
    } else if (
      request.kind === "session-actions" &&
      request.background === true &&
      answer.allowSessionActions === true &&
      request.sessionGeneration &&
      this.capable(backend)
    )
      forwarded = {
        ...answer,
        sessionReceipt: this.execution.approveSession({
          profileId,
          backendIncarnation: backend.incarnation,
          threadId: request.threadId,
          sessionGeneration: request.sessionGeneration,
          policyRevision: this.execution.minimumRevision(profileId, request.threadId),
        }),
      };
    else if (request.kind === "foreground-takeover")
      this.takeovers.answered(profileId, request, answer.allowForegroundTakeover === true);
    this.send(profileId, { type: "accessAnswer", answer: forwarded });
  }
  incarnation(profileId: string): string | undefined {
    return this.backends.get(profileId)?.incarnation;
  }
  close(): void {
    this.takeovers.close();
  }
}
