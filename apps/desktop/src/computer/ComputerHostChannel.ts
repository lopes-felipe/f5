import { ComputerGrantAuthority } from "./ComputerGrantAuthority";
import { ComputerConsentStore, computerConsentKey } from "./ComputerConsentStore";
import type { ChildProcess } from "node:child_process";
import { Schema } from "effect";
import {
  SCHEDULED_NOTIFICATIONS_CAPABILITY,
  OPEN_EXTERNAL_URL_CAPABILITY,
  type OpenExternalUrlStatus,
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
  DesktopComputerHostMessage,
  type ComputerAccessAnswer,
  type ComputerAutomationBackendStatus,
  type ComputerAccessRequested,
  type ComputerBackgroundStatus,
  type ComputerLeaseHolder,
  type ChromeLeaseHolder,
  type ChromeProcessRegistration,
  type RememberedComputerConsent,
} from "@t3tools/contracts";
import { computerError, ComputerControlError } from "@t3tools/shared/computerControl";
import { restrictComputerTier } from "@t3tools/shared/computerApps";
import type { ComputerController, ComputerExecutionStateUpdate } from "./ComputerController";
import {
  CHROME_NATIVE_WORK_FINISHING_MESSAGE,
  CHROME_OWN_NATIVE_CONTROL_MESSAGE,
  ChromeLeaseAuthority,
  isChromeSelfWait,
  nativeScopeExcludesChrome,
} from "./ChromeLeaseAuthority";
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
  acquiring: Map<string, { holder: ComputerLeaseHolder; cancelled: boolean }>;
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
  private readonly consentBarriers = new Set<string>();
  private readonly approvalSources = new Map<
    string,
    {
      profileId: string;
      request: ComputerAccessRequested;
      source?: RememberedComputerConsent;
    }
  >();
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
      /** Chrome lease events, one line each, for the desktop log. */
      log?: (message: string) => void;
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
      consents?: ComputerConsentStore;
    } = {},
  ) {
    this.chrome = new ChromeLeaseAuthority(
      (holder) => {
        // A report outlives only its own lease; a later holder starts unknown.
        const previous = this.chromeCallsHolder;
        if (previous && (!holder || chromeCallsKey(previous) !== chromeCallsKey(holder)))
          this.chromeCalls.delete(chromeCallsKey(previous));
        this.chromeCallsHolder = holder;
        for (const profileId of this.backends.keys()) this.sendChromeLease(profileId, holder);
        this.chromeOptions?.changed?.(holder);
      },
      chromeOptions?.supervisor,
      {
        // Only an explicit "no call running" report counts; unknown stays busy.
        callsIdle: (holder) => this.chromeCalls.get(chromeCallsKey(holder)) === false,
        ...(chromeOptions?.log ? { log: chromeOptions.log } : {}),
      },
    );
    this.execution = options.execution ?? new ComputerExecutionAuthority();
    controller.setAdmissionCheck?.((holder) => {
      this.chrome.assertNativeAvailable(holder.profileId, holder.scope, holder);
      if (
        !this.execution.revisionAccepted(holder.profileId, holder.threadId, holder.policyRevision)
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
      if (
        holder.scope.kind !== "foreground" &&
        !this.execution.hasSessionApproval(
          holder.profileId,
          this.backends.get(holder.profileId)?.incarnation ?? "",
          holder.threadId,
          holder.sessionGeneration,
        )
      )
        throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
    });
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
  /** A native lease or takeover reservation of this thread that Chrome control would collide with. */
  private holdsNativeExcludingChrome(profileId: string, threadId: string): boolean {
    const own = (holder: ComputerLeaseHolder) =>
      holder.profileId === profileId &&
      holder.threadId === threadId &&
      nativeScopeExcludesChrome(holder.scope);
    const pending = this.controller.lease.pendingTakeover()?.holder;
    return this.controller.lease.holders().some(own) || (pending !== undefined && own(pending));
  }
  private capable(backend: Backend | undefined): boolean {
    return backend?.capabilities.has(COMPUTER_BACKGROUND_CAPABILITY) ?? false;
  }
  cooperationCapable(profileId: string): boolean {
    return (
      this.backends.get(profileId)?.capabilities.has(COMPUTER_COOPERATION_CAPABILITY) === true &&
      this.controller.cooperationAvailable()
    );
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
    for (const [key, entry] of this.approvalSources)
      if (entry.profileId === profileId) this.approvalSources.delete(key);
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
      acquiring: new Map(),
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
              (capability === COMPUTER_REMEMBERED_CONSENT_CAPABILITY && !!this.options.consents) ||
              (capability === COMPUTER_COOPERATION_CAPABILITY &&
                this.controller.cooperationAvailable?.()) ||
              (capability === COMPUTER_TAKEOVER_RESERVATION_CAPABILITY &&
                !!this.controller.admitWhenFree) ||
              (capability === COMPUTER_SHARED_APP_CAPABILITY &&
                this.controller.sharedAppsAvailable?.()) ||
              (capability === COMPUTER_BACKGROUND_EVENTS_CAPABILITY &&
                this.controller.backgroundEventsAvailable?.()) ||
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
      const fail = (requestId: string, error: unknown) => {
        const failure = computerError(error);
        this.send(profileId, {
          type: "response",
          requestId,
          error:
            failure._tag === "TargetBlocked" &&
            failure.kind === "shared-focus" &&
            !backend.capabilities.has(COMPUTER_SHARED_APP_CAPABILITY)
              ? { _tag: "TargetBlocked", kind: "focus-unknown" }
              : failure,
        });
      };
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
            (message.holder.scope.kind === "takeover" &&
              !(this.cooperationCapable(profileId) && message.cooperative)) ||
            (message.holder.scope.kind === "app" && !this.capable(backend))
          ) {
            child.disconnect();
            return;
          }
          if (
            message.holder.scope.kind === "takeover" &&
            (!this.execution.validTakeover(message.holder, backend.incarnation) ||
              !this.controller.cooperation.yielded.has(profileId + "\0" + message.holder.threadId))
          ) {
            fail(message.requestId, new ComputerControlError({ _tag: "ReplayRejected" }));
            break;
          }
          if (
            backend.acquisitions.size + backend.acquiring.size >= 32 ||
            backend.acquiring.has(message.requestId)
          ) {
            fail(
              message.requestId,
              new ComputerControlError({ _tag: "Busy", holder: "same-profile" }),
            );
            break;
          }
          const acquiring = { holder: message.holder, cancelled: false };
          backend.acquiring.set(message.requestId, acquiring);
          void (async () => {
            try {
              const { cooperative: _untrustedCooperative, ...legacyHolder } = message.holder;
              const holder = {
                ...legacyHolder,
                ...(this.cooperationCapable(profileId) && message.cooperative
                  ? { cooperative: true }
                  : {}),
              };
              const check = () => {
                if (this.backends.get(profileId) !== backend || acquiring.cancelled)
                  throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
                this.chrome.assertNativeAvailable(profileId, holder.scope, holder);
                const status = this.status();
                if (!status.available)
                  throw new ComputerControlError({ _tag: "Unavailable", reason: status.reason });
                if (
                  !this.execution.revisionAccepted(
                    profileId,
                    holder.threadId,
                    holder.policyRevision,
                  )
                )
                  throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
                if (
                  holder.scope.kind === "app" &&
                  !this.execution.hasSessionApproval(
                    profileId,
                    incarnation,
                    holder.threadId,
                    holder.sessionGeneration,
                  )
                )
                  throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
              };
              try {
                check();
              } catch (error) {
                // The thread's own Chrome call or stopping lease clears by itself: wait for it
                // in the admission queue instead of failing at once.
                if (!isChromeSelfWait(error)) throw error;
              }
              const preparationStarted = performance.now();
              if (this.cooperationCapable(profileId))
                await this.controller.prepareAcquisition(holder);
              const admit = () => {
                check();
                return this.controller.acquire(holder);
              };
              const result = this.controller.admitWhenFree
                ? await this.controller.admitWhenFree({
                    kind: "lease",
                    holder,
                    profileId,
                    requestId: message.requestId,
                    ...(this.cooperationCapable(profileId) && message.waitMs !== undefined
                      ? {
                          waitMs: Math.max(
                            0,
                            message.waitMs - (performance.now() - preparationStarted),
                          ),
                        }
                      : {}),
                    admit,
                  })
                : admit();
              if (this.backends.get(profileId) !== backend || acquiring.cancelled) {
                this.controller.lease.release(result);
                if (result.scope.kind === "takeover")
                  this.execution.revokeTakeovers(
                    (receipt) =>
                      receipt.profileId === profileId && receipt.threadId === result.threadId,
                  );
                throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
              }
              backend.acquisitions.set(message.requestId, result);
              this.send(profileId, { type: "response", requestId: message.requestId, result });
            } catch (error) {
              fail(message.requestId, error);
            } finally {
              backend.acquiring.delete(message.requestId);
            }
          })();
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
          if (
            backend.acquisitions.size + backend.acquiring.size >= 32 ||
            backend.acquiring.has(requestId)
          ) {
            fail(requestId, new ComputerControlError({ _tag: "Busy", holder: "same-profile" }));
            break;
          }
          const acquiring = { holder: message.holder, cancelled: false };
          backend.acquiring.set(requestId, acquiring);
          try {
            try {
              this.chrome.assertNativeAvailable(profileId, undefined, message.holder);
            } catch (error) {
              // A queued takeover re-checks in admission and waits for it to clear; one that
              // reserves immediately (no reservation capability) must fail now.
              if (
                !isChromeSelfWait(error) ||
                !backend.capabilities.has(COMPUTER_TAKEOVER_RESERVATION_CAPABILITY)
              )
                throw error;
            }
            this.takeovers.request(
              profileId,
              incarnation,
              requestId,
              message.approvalRequestId,
              {
                ...message.holder,
                cooperative: this.cooperationCapable(profileId) && message.cooperative === true,
              },
              (outcome) => {
                backend.acquiring.delete(requestId);
                if (this.backends.get(profileId) !== backend || acquiring.cancelled) {
                  if ("holder" in outcome) {
                    this.controller.lease.release(outcome.holder);
                    this.execution.revokeTakeovers(
                      (receipt) =>
                        receipt.profileId === profileId &&
                        receipt.threadId === outcome.holder.threadId,
                    );
                  }
                  return;
                }
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
              backend.capabilities.has(COMPUTER_TAKEOVER_RESERVATION_CAPABILITY)
                ? {
                    waitMs: message.waitMs ?? 0,
                    reserved: () => {
                      if (this.backends.get(profileId) !== backend || acquiring.cancelled) return;
                      this.send(profileId, { type: "takeoverReserved", requestId });
                      this.answerPendingRemembered(profileId);
                    },
                  }
                : undefined,
            );
          } catch (error) {
            backend.acquiring.delete(requestId);
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
            // The holder's own thread may hold native control beside Chrome (see
            // `ChromeLeaseAuthority`); its Chrome calls wait until that control ends.
            if (this.holdsNativeExcludingChrome(profileId, message.holder.threadId))
              throw new ComputerControlError({
                _tag: "Execution",
                message: CHROME_OWN_NATIVE_CONTROL_MESSAGE,
              });
            // A released lease's input can still be running (`nativeWork` outlives the lease);
            // Chrome must not move focus under it.
            if (this.controller.nativeWorkConflicts("chrome"))
              throw new ComputerControlError({
                _tag: "Execution",
                message: CHROME_NATIVE_WORK_FINISHING_MESSAGE,
              });
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
            if (this.options.consents)
              this.revokeRemembered(profileId, {
                version: 1,
                kind: "app-access",
                projectId: message.projectId,
                appId: message.appId,
                tier: "view",
                allowTyping: false,
                policyVersion: 1,
              });
            else this.grants.forget(profileId, message.projectId, message.appId);
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
        case "grantsRemembered":
          if (!backend.capabilities.has(COMPUTER_REMEMBERED_CONSENT_CAPABILITY)) {
            fail(message.requestId, new Error("Remembered computer consent is unavailable."));
            break;
          }
          {
            const entries = this.rememberedConsents(profileId);
            this.send(profileId, {
              type: "response",
              requestId: message.requestId,
              result: this.grants.listRemembered(profileId, message.projectId).map((grant) => {
                const status = entries.find(
                  (entry) =>
                    entry.consent.kind === "app-access" &&
                    entry.consent.projectId === grant.projectId &&
                    entry.consent.appId === grant.appId,
                );
                return {
                  ...grant,
                  persistence: status?.persistence ?? "session-only",
                  ...(status?.reason ? { persistenceReason: status.reason } : {}),
                };
              }),
            });
          }
          break;
        case "computerSessionClosed":
          if (!backend.capabilities.has(COMPUTER_SESSION_LIFECYCLE_CAPABILITY)) break;
          this.cancelSessionAccess(profileId, message.threadId, message.sessionGeneration);
          this.grants.sessionClosed(profileId, message.threadId, message.sessionGeneration);
          this.execution.sessionClosed(profileId, message.threadId, message.sessionGeneration);
          if (this.cooperationCapable(profileId))
            this.controller.turnEnded(profileId, message.threadId, message.sessionGeneration);
          for (const [key, entry] of this.approvalSources)
            if (
              entry.profileId === profileId &&
              entry.request.threadId === message.threadId &&
              entry.request.sessionGeneration === message.sessionGeneration
            )
              this.approvalSources.delete(key);
          break;
        case "computerTurnEnded":
          if (this.cooperationCapable(profileId)) {
            this.cancelSessionAccess(profileId, message.threadId, message.sessionGeneration);
            this.controller.turnEnded(
              profileId,
              message.threadId,
              message.sessionGeneration,
              message.turnId,
            );
          }
          break;
        case "targetWait":
          if (message.holder.profileId !== profileId) {
            child.disconnect();
            return;
          }
          if (!this.cooperationCapable(profileId)) {
            fail(
              message.requestId,
              new ComputerControlError({
                _tag: "Execution",
                message: "Computer cooperation is unavailable; check the helper status.",
              }),
            );
            break;
          }
          {
            const holder = {
              ...message.holder,
              cooperative:
                [...this.controller.cooperation.yielded.values()].find(
                  (entry) =>
                    entry.holder.profileId === profileId &&
                    entry.holder.threadId === message.holder.threadId,
                )?.holder.cooperative === true,
              scope: message.appId
                ? { kind: "app" as const, appId: message.appId }
                : ([...this.controller.cooperation.yielded.values()].find(
                    (entry) =>
                      entry.holder.profileId === profileId &&
                      entry.holder.threadId === message.holder.threadId &&
                      entry.appId === undefined,
                  )?.holder.scope ?? { kind: "foreground" as const }),
            };
            void this.controller
              .waitForTarget(
                message.requestId,
                holder,
                message.appId,
                message.timeoutMs,
                // The takeover this wait precedes is cooperative when the broker asked for it.
                message.holder.cooperative === true,
              )
              .then(
                (result) =>
                  this.send(profileId, { type: "response", requestId: message.requestId, result }),
                (error: unknown) => fail(message.requestId, error),
              );
          }
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
          const acquiring = backend.acquiring.get(message.requestId);
          if (acquiring) acquiring.cancelled = true;
          backend.acquiring.delete(message.requestId);
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
            // The Chrome holder's echo marks the pause as host-authoritative on the server.
            if (this.setThreadPaused(profileId, message.threadId, true))
              this.send(profileId, {
                type: "pauseChanged",
                threadId: message.threadId,
                paused: true,
              });
          }
          break;
        case "resumeRequested":
          break;
        case "accessRequested": {
          backend.pendingAccess.set(message.request.requestId, message.request);
          // An earlier "always allow" answers here, without a dialog. The grant is main's own.
          if (this.answerRemembered(profileId, message.request)) break;
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
  /** Sets only the Chrome lease's latch; callers send `pauseChanged`. */
  pauseChrome(profileId: string, threadId: string, paused: boolean): boolean {
    const holder = this.chrome.current();
    if (!holder || holder.profileId !== profileId || holder.threadId !== threadId) return false;
    this.chrome.setPaused(holder, paused);
    return true;
  }
  /**
   * Pauses or resumes native control and the Chrome lease together. A thread can hold
   * both, and each keeps its own latch, so resuming only one would leave the other
   * paused (or in recovery). Native goes first: its resume can refuse (helper
   * unavailable, user still in the target), and then Chrome must stay paused as well.
   * Returns whether the thread held the Chrome lease.
   */
  setThreadPaused(profileId: string, threadId: string, paused: boolean): boolean {
    this.controller.setPaused(profileId, threadId, paused);
    return this.pauseChrome(profileId, threadId, paused);
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
    if (!this.capable(this.backends.get(profileId)) && !this.cooperationCapable(profileId)) return;
    this.send(profileId, {
      type: "executionStateChanged",
      threadId: update.threadId,
      sessionGeneration: update.sessionGeneration,
      state: this.cooperationCapable(profileId)
        ? update.state
        : update.state === "waiting-user"
          ? "paused"
          : update.state === "waiting-agent"
            ? "waiting-idle"
            : update.state,
      ...(update.appId ? { appId: update.appId } : {}),
      ...(update.delivery ? { delivery: update.delivery } : {}),
      ...(update.pauseCause ? { pauseCause: update.pauseCause } : {}),
    });
  }
  cancelSessionAccess(profileId: string, threadId: string, sessionGeneration: string): void {
    this.takeovers.cancelThread(profileId, threadId, sessionGeneration);
    const backend = this.backends.get(profileId);
    if (!backend) return;
    for (const [requestId, entry] of backend.acquiring)
      if (
        entry.holder.threadId === threadId &&
        entry.holder.sessionGeneration === sessionGeneration
      ) {
        entry.cancelled = true;
        backend.acquiring.delete(requestId);
        this.controller.cancelAdmission?.(profileId, requestId);
      }
    for (const [requestId, request] of backend.pendingAccess)
      if (request.threadId === threadId && request.sessionGeneration === sessionGeneration)
        backend.pendingAccess.delete(requestId);
  }
  broadcast(message: DesktopComputerHostMessage): void {
    for (const profileId of this.backends.keys()) this.send(profileId, message);
  }
  /**
   * Answers a pending request the profile always allows: a Codex Chrome session or a
   * Claude in Chrome setup.
   */
  private answerRemembered(profileId: string, request: ComputerAccessRequested): boolean {
    const backend = this.backends.get(profileId);
    if (!backend) return false;
    if (backend.capabilities.has(COMPUTER_REMEMBERED_CONSENT_CAPABILITY)) {
      const policies =
        this.options.consents
          ?.list(profileId)
          .filter(
            (policy) =>
              !this.consentBarriers.has(JSON.stringify([profileId, computerConsentKey(policy)])),
          ) ?? [];
      let source: RememberedComputerConsent | undefined;
      let answer: ComputerAccessAnswer | undefined;
      const base = {
        requestId: request.requestId,
        backendIncarnation: backend.incarnation,
        decisions: [],
      };
      if (request.kind === "apps" && request.projectId) {
        const grants = this.grants.listRemembered(profileId, request.projectId);
        const matches = request.apps.map((app) =>
          grants.find(
            (grant) =>
              grant.appId === app.appId &&
              !this.grants.sessionRevoked(profileId, request, grant.receipt!) &&
              grant.tier === restrictComputerTier(app.tier, grant.tier) &&
              (!request.typingRequested || grant.tier !== "click" || grant.allowTyping),
          ),
        );
        if (matches.every((grant) => grant !== undefined))
          answer = {
            ...base,
            decisions: matches.map((grant) => ({
              appId: grant!.appId,
              allow: true,
              allowTyping: grant!.allowTyping,
              remember: true,
            })),
          };
      } else if (request.kind === "session-actions") {
        source =
          policies.find(
            (policy) =>
              policy.kind === "session-actions" &&
              policy.projectId === request.projectId &&
              (!request.background || policy.background),
          ) ??
          (request.fullAccess && request.background
            ? policies.find((policy) => policy.kind === "full-access-session")
            : undefined);
        if (source) answer = { ...base, allowSessionActions: true };
      } else if (
        request.kind === "foreground-takeover" &&
        request.fullAccess &&
        this.takeovers.awaitingConsent(profileId, request.requestId)
      ) {
        source = policies.find(
          (policy) =>
            policy.kind === "takeover" &&
            policy.projectId === request.projectId &&
            policy.appId === request.takeover?.appId,
        );
        if (source) answer = { ...base, allowForegroundTakeover: true };
      }
      if (answer) {
        try {
          this.answerAccess(profileId, answer, [], source);
          return true;
        } catch {
          return false;
        }
      }
    }
    const integration = alwaysAllowableIntegration(request);
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
    this.answerPendingRemembered(profileId);
  }
  answerPendingRemembered(profileId: string): void {
    const backend = this.backends.get(profileId);
    if (!backend) return;
    for (const request of backend.pendingAccess.values()) this.answerRemembered(profileId, request);
  }
  rememberedConsents(profileId: string) {
    return this.options.consents?.entries(profileId) ?? [];
  }
  private rememberedChanged(
    profileId: string,
    projectId?: string,
    revokedSessions?: ReadonlyArray<{ threadId: string; sessionGeneration: string }>,
    backgroundOnly = false,
  ): void {
    if (this.backends.get(profileId)?.capabilities.has(COMPUTER_REMEMBERED_CONSENT_CAPABILITY))
      this.send(profileId, {
        type: "rememberedChanged",
        ...(backgroundOnly ? { backgroundOnly: true } : {}),
        ...(projectId ? { projectId } : {}),
        ...(revokedSessions?.length ? { revokedSessions } : {}),
      });
  }
  revokeRemembered(profileId: string, consent: RememberedComputerConsent): void {
    this.consentBarriers.add(JSON.stringify([profileId, computerConsentKey(consent)]));
    const sourced = [...this.approvalSources.values()].filter(
      (entry) =>
        entry.profileId === profileId &&
        entry.source &&
        computerConsentKey(entry.source) === computerConsentKey(consent),
    );
    const threads =
      consent.kind === "app-access"
        ? undefined
        : new Set(sourced.map((entry) => entry.request.threadId));
    const affected = this.grants.revoke(profileId, consent, threads);
    const stopped = new Set<string>();
    for (const authorization of affected) {
      if (consent.kind === "app-access")
        this.execution.sessionClosed(
          profileId,
          authorization.threadId,
          authorization.sessionGeneration,
        );
      this.controller.setPaused(profileId, authorization.threadId, true);
      this.controller.updateGrants(authorization);
      stopped.add(authorization.threadId);
    }
    for (const entry of sourced) {
      if (entry.request.sessionGeneration) {
        if (consent.kind === "takeover")
          this.execution.revokeTakeovers(
            (receipt) =>
              receipt.profileId === profileId &&
              receipt.threadId === entry.request.threadId &&
              receipt.appId === consent.appId,
          );
        else
          this.execution.sessionClosed(
            profileId,
            entry.request.threadId,
            entry.request.sessionGeneration,
          );
      }
      this.controller.setPaused(profileId, entry.request.threadId, true);
      stopped.add(entry.request.threadId);
    }
    const backend = this.backends.get(profileId);
    for (const request of backend?.pendingAccess.values() ?? []) {
      const matchingApp =
        consent.kind === "app-access" &&
        request.projectId === consent.projectId &&
        (request.apps.some((app) => app.appId === consent.appId) ||
          request.takeover?.appId === consent.appId);
      const matchingPolicy =
        consent.kind === "session-actions"
          ? request.kind === "session-actions" && request.projectId === consent.projectId
          : consent.kind === "full-access-session"
            ? request.kind === "session-actions" && request.fullAccess && request.background
            : consent.kind === "takeover" &&
              request.kind === "foreground-takeover" &&
              request.projectId === consent.projectId &&
              request.takeover?.appId === consent.appId;
      if (!matchingApp && !matchingPolicy && !stopped.has(request.threadId)) continue;
      try {
        this.answerAccess(profileId, {
          requestId: request.requestId,
          backendIncarnation: backend!.incarnation,
          decisions: request.apps.map((app) => ({
            appId: app.appId,
            allow: false,
            allowTyping: false,
            remember: false,
          })),
          allowSessionActions: false,
          allowForegroundTakeover: false,
        });
      } catch {
        backend?.pendingAccess.delete(request.requestId);
      }
    }
    for (const threadId of stopped)
      this.send(profileId, { type: "pauseChanged", threadId, paused: true });
    this.rememberedChanged(
      profileId,
      "projectId" in consent ? consent.projectId : undefined,
      consent.kind === "takeover"
        ? undefined
        : [
            ...affected.map((authorization) => ({
              threadId: authorization.threadId,
              sessionGeneration: authorization.sessionGeneration,
            })),
            ...sourced.flatMap((entry) =>
              entry.request.sessionGeneration
                ? [
                    {
                      threadId: entry.request.threadId,
                      sessionGeneration: entry.request.sessionGeneration,
                    },
                  ]
                : [],
            ),
          ],
      consent.kind === "app-access",
    );
    // A failed durable revocation never removes the barrier or restores current authority.
    this.options.consents?.revoke(profileId, consent);
  }
  accessRequest(profileId: string, answer: ComputerAccessAnswer): ComputerAccessRequested {
    const backend = this.backends.get(profileId);
    const request = backend?.pendingAccess.get(answer.requestId);
    if (!backend?.ready || answer.backendIncarnation !== backend.incarnation || !request)
      throw new Error("This request expired or belongs to another backend.");
    return request;
  }
  answerAccess(
    profileId: string,
    answer: ComputerAccessAnswer,
    policies: ReadonlyArray<RememberedComputerConsent> = [],
    source?: RememberedComputerConsent,
  ): void {
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
    const takeoverReserved =
      request.kind === "foreground-takeover" &&
      this.takeovers.awaitingConsent(profileId, request.requestId);
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
    if (
      (request.kind === "session-actions" && answer.allowSessionActions) ||
      (request.kind === "foreground-takeover" && answer.allowForegroundTakeover && takeoverReserved)
    ) {
      const selected =
        source ??
        policies.find(
          (policy) =>
            policy.kind === "session-actions" ||
            policy.kind === "full-access-session" ||
            policy.kind === "takeover",
        );
      this.approvalSources.set(
        JSON.stringify([profileId, request.threadId, request.sessionGeneration, request.kind]),
        {
          profileId,
          request,
          ...(selected ? { source: selected } : {}),
        },
      );
    }
    if (policies.length && this.options.consents) {
      let persistence: "durable" | "session-only" = "durable";
      let reason: string | undefined;
      for (const policy of policies) {
        if (policy.kind === "takeover" && !takeoverReserved) {
          persistence = "session-only";
          reason = "The foreground reservation expired before this choice could be saved.";
          continue;
        }
        try {
          if (this.options.consents.allow(profileId, policy) === "session-only") {
            persistence = "session-only";
            reason = "F5 could not save this choice. It applies until F5 closes.";
          }
          this.consentBarriers.delete(JSON.stringify([profileId, computerConsentKey(policy)]));
        } catch (error) {
          persistence = "session-only";
          reason = error instanceof Error ? error.message : "F5 could not save this choice.";
          if (policy.kind === "app-access") {
            this.grants.unremember(profileId, policy.projectId, policy.appId);
            forwarded = {
              ...forwarded,
              decisions: forwarded.decisions.map((decision) =>
                decision.appId === policy.appId ? { ...decision, remember: false } : decision,
              ),
            };
          }
        }
      }
      forwarded = { ...forwarded, persistence, ...(reason ? { persistenceReason: reason } : {}) };
    }
    this.send(profileId, { type: "accessAnswer", answer: forwarded });
    if (policies.length) {
      this.rememberedChanged(
        profileId,
        policies.every((policy) => "projectId" in policy && policy.projectId === request.projectId)
          ? request.projectId
          : undefined,
      );
      this.answerPendingRemembered(profileId);
    }
  }
  incarnation(profileId: string): string | undefined {
    return this.backends.get(profileId)?.incarnation;
  }
  close(): void {
    this.takeovers.close();
    this.approvalSources.clear();
    this.consentBarriers.clear();
  }
}
