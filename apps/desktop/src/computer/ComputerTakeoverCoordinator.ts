import { COMPUTER_TAKEOVER_CONSENT_TIMEOUT_MS } from "@t3tools/contracts";
import type {
  ComputerAccessRequested,
  ComputerAutomationError,
  ComputerLeaseHolder,
  ComputerUserActiveDetail,
} from "@t3tools/contracts";
import { ComputerControlError, computerError } from "@t3tools/shared/computerControl";
import type { ComputerController } from "./ComputerController";
import { COMPUTER_TAKEOVER_IDLE_MS } from "./ComputerCooperation";
import type { ComputerExecutionAuthority } from "./ComputerExecutionAuthority";
import type { ComputerTakeoverReservation } from "./ComputerLeaseAuthority";

export const TAKEOVER_IDLE_MS = COMPUTER_TAKEOVER_IDLE_MS;
export const TAKEOVER_IDLE_TIMEOUT_MS = 30_000;
export const TAKEOVER_CONSENT_TIMEOUT_MS = COMPUTER_TAKEOVER_CONSENT_TIMEOUT_MS;
interface Takeover {
  requestId: string;
  approvalRequestId: string;
  profileId: string;
  backendIncarnation: string;
  holder: ComputerLeaseHolder;
  reservation: ComputerTakeoverReservation;
  phase: "consent" | "idle" | "arming" | "settled";
  /** The last condition that kept the takeover from arming, reported if it times out. */
  detail?: ComputerUserActiveDetail;
  timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>;
  respond: (result: { holder: ComputerLeaseHolder } | { error: ComputerAutomationError }) => void;
}
type Preparation = Pick<
  Takeover,
  "requestId" | "approvalRequestId" | "profileId" | "backendIncarnation" | "holder" | "respond"
> & { cancelled: boolean };
const preparationKey = (profileId: string, requestId: string) =>
  JSON.stringify([profileId, requestId]);
/**
 * Electron-owned foreground takeover: reserve → native approval → wait for the user to be
 * idle → drain other background work → arm. It never loops over ordinary `acquire`, and holds
 * no permit, mutation queue slot or action deadline while waiting.
 */
export class ComputerTakeoverCoordinator {
  private readonly takeovers = new Map<string, Takeover>();
  private readonly preparing = new Map<string, Preparation>();
  private readonly offLease: () => void;
  constructor(
    private readonly controller: ComputerController,
    private readonly execution: ComputerExecutionAuthority,
    private readonly options: {
      /** Publishes pending/waiting state; never reaches other profiles. */
      state: (
        profileId: string,
        holder: ComputerLeaseHolder,
        state: "pending-consent" | "waiting-idle" | null,
      ) => void;
      now?: () => number;
    },
  ) {
    // A kill switch, stop or profile release clears the reservation out from under us.
    this.offLease = controller.lease.subscribe(() => {
      for (const takeover of this.takeovers.values())
        if (
          takeover.phase !== "arming" &&
          controller.lease.pendingTakeover()?.id !== takeover.reservation.id
        )
          this.fail(takeover, new ComputerControlError({ _tag: "Interrupted", cause: "paused" }));
    });
  }
  request(
    profileId: string,
    backendIncarnation: string,
    requestId: string,
    approvalRequestId: string,
    holder: ComputerLeaseHolder,
    respond: Takeover["respond"],
    wait?: { waitMs: number; reserved: () => void },
  ): void {
    const input: Preparation = {
      profileId,
      backendIncarnation,
      requestId,
      approvalRequestId,
      holder,
      respond,
      cancelled: false,
    };
    if (!wait) {
      this.reserveImmediately(input);
      return;
    }
    const key = preparationKey(profileId, requestId);
    if (this.preparing.has(key))
      throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
    this.preparing.set(key, input);
    void this.controller
      .admitWhenFree({
        kind: "takeover",
        holder,
        profileId,
        requestId,
        waitMs: wait.waitMs,
        admit: () => {
          if (input.cancelled)
            throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
          this.controller.assertTakeoverAdmission(holder);
          this.reserveImmediately(input);
        },
      })
      .then(
        () => {
          if (this.preparing.get(key) === input) this.preparing.delete(key);
          if (!input.cancelled && this.awaitingConsent(profileId, approvalRequestId))
            wait.reserved();
        },
        (error: unknown) => {
          if (this.preparing.get(key) === input) this.preparing.delete(key);
          if (!input.cancelled) respond({ error: computerError(error) });
        },
      );
  }
  private reserveImmediately(input: Preparation): void {
    const { profileId, backendIncarnation, requestId, approvalRequestId, holder, respond } = input;
    if (holder.scope.kind !== "takeover" || holder.backend !== "native")
      throw new ComputerControlError({ _tag: "Execution", message: "Not a takeover request." });
    if (!this.execution.revisionAccepted(profileId, holder.threadId, holder.policyRevision))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "access-changed" });
    if (
      !this.execution.hasSessionApproval(
        profileId,
        backendIncarnation,
        holder.threadId,
        holder.sessionGeneration,
      )
    )
      throw new ComputerControlError({ _tag: "NotGranted", needed: "click" });
    const reservation = this.controller.lease.reserveTakeover(holder);
    const takeover: Takeover = {
      requestId,
      approvalRequestId,
      profileId,
      backendIncarnation,
      holder,
      reservation,
      phase: "consent",
      timers: [],
      respond,
    };
    this.takeovers.set(requestId, takeover);
    // Registering the kill chord happens in the lease listener; failure cancels preparation.
    if (this.controller.lease.pendingTakeover()?.id !== reservation.id) {
      this.fail(takeover, new ComputerControlError({ _tag: "Interrupted", cause: "paused" }));
      return;
    }
    takeover.timers.push(
      setTimeout(
        () =>
          this.fail(takeover, new ComputerControlError({ _tag: "NotGranted", needed: "click" })),
        TAKEOVER_CONSENT_TIMEOUT_MS,
      ),
    );
    this.options.state(profileId, holder, "pending-consent");
  }
  /**
   * Called from main's consent path only, after the native dialog. The dialog the user answered
   * must describe exactly this reservation: same thread, session, turn and app. A mismatched
   * pair never mints a receipt.
   */
  awaitingConsent(profileId: string, approvalRequestId: string): boolean {
    return [...this.takeovers.values()].some(
      (entry) =>
        entry.profileId === profileId &&
        entry.approvalRequestId === approvalRequestId &&
        entry.phase === "consent",
    );
  }
  answered(profileId: string, approval: ComputerAccessRequested, allowed: boolean): void {
    const takeover = [...this.takeovers.values()].find(
      (entry) =>
        entry.profileId === profileId &&
        entry.approvalRequestId === approval.requestId &&
        entry.phase === "consent",
    );
    if (!takeover) return;
    const scope = takeover.holder.scope as { appId: string };
    const matches =
      approval.kind === "foreground-takeover" &&
      approval.threadId === takeover.holder.threadId &&
      approval.takeover?.threadId === takeover.holder.threadId &&
      approval.takeover.turnId === takeover.holder.turnId &&
      approval.takeover.appId === scope.appId &&
      (approval.sessionGeneration === undefined ||
        approval.sessionGeneration === takeover.holder.sessionGeneration);
    if (!allowed || !matches) {
      this.fail(takeover, new ComputerControlError({ _tag: "NotGranted", needed: "click" }));
      return;
    }
    this.clearTimers(takeover);
    this.options.state(profileId, takeover.holder, "waiting-idle");
    this.waitIdle(takeover, this.now());
  }
  /**
   * Every physical input resets the 1.5 s window; give up 30 s after approval, naming the
   * condition (recent input, held input or an unhealthy monitor) that last blocked arming.
   */
  private waitIdle(takeover: Takeover, started: number): void {
    takeover.phase = "idle";
    const poll = setInterval(() => {
      if (takeover.phase !== "idle") return;
      const idle = this.controller.takeoverIdle(takeover.holder);
      if (idle.idle) {
        void this.arm(takeover, started);
        return;
      }
      takeover.detail = idle.detail;
      if (this.now() - started >= TAKEOVER_IDLE_TIMEOUT_MS)
        this.fail(
          takeover,
          new ComputerControlError({
            _tag: "TargetBlocked",
            kind: "user-active",
            detail: takeover.detail,
          }),
        );
    }, 100);
    poll.unref?.();
    takeover.timers.push(poll);
  }
  private async arm(takeover: Takeover, started: number): Promise<void> {
    this.clearTimers(takeover);
    takeover.phase = "arming";
    let release: (() => void) | undefined;
    try {
      const key = `${takeover.profileId}\0${takeover.holder.threadId}`;
      release = await this.controller.drainBackground(key);
      if (
        !this.takeovers.has(takeover.requestId) ||
        this.controller.isPaused(takeover.profileId, takeover.holder.threadId)
      )
        throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      // Native readiness exchange: the helper's current idle age, not cached telemetry. The
      // helper re-checks the input sequence it reported when the armed generation resumes.
      const { idleMs, detail } = await this.controller.takeoverReadiness(takeover.holder);
      if (!this.takeovers.has(takeover.requestId))
        throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
      if (idleMs < TAKEOVER_IDLE_MS) {
        takeover.detail = detail ?? "recent-input";
        release();
        release = undefined;
        // The cached poll and this native check can disagree; the give-up deadline still holds.
        if (this.now() - started >= TAKEOVER_IDLE_TIMEOUT_MS)
          throw new ComputerControlError({
            _tag: "TargetBlocked",
            kind: "user-active",
            detail: takeover.detail,
          });
        this.waitIdle(takeover, started);
        return;
      }
      const scope = takeover.holder.scope as { appId: string };
      const receipt = this.execution.issueTakeover({
        profileId: takeover.profileId,
        backendIncarnation: takeover.backendIncarnation,
        threadId: takeover.holder.threadId,
        sessionGeneration: takeover.holder.sessionGeneration,
        policyRevision: takeover.holder.policyRevision,
        turnId: takeover.holder.turnId,
        appId: scope.appId,
        grantVersion: takeover.holder.grantVersion,
      });
      const armed = this.controller.lease.armTakeover(takeover.reservation, receipt);
      this.execution.bindTakeover(receipt, armed.executionGeneration);
      takeover.phase = "settled";
      this.takeovers.delete(takeover.requestId);
      this.options.state(takeover.profileId, armed, null);
      takeover.respond({ holder: armed });
    } catch (error) {
      this.fail(takeover, error);
    } finally {
      release?.();
    }
  }
  /** Cancellation, timeout, turn end, disconnect: clears the reservation; late replies are ignored. */
  cancel(profileId: string, requestId: string): void {
    const key = preparationKey(profileId, requestId);
    const preparing = this.preparing.get(key);
    if (preparing) {
      preparing.cancelled = true;
      this.preparing.delete(key);
      this.controller.cancelAdmission(profileId, requestId);
    }
    const takeover = this.takeovers.get(requestId);
    if (takeover?.profileId === profileId)
      this.fail(
        takeover,
        new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }),
        false,
      );
  }
  cancelThread(profileId: string, threadId?: string, sessionGeneration?: string): void {
    for (const entry of this.preparing.values())
      if (
        entry.profileId === profileId &&
        (!threadId || entry.holder.threadId === threadId) &&
        (!sessionGeneration || entry.holder.sessionGeneration === sessionGeneration)
      )
        this.cancel(profileId, entry.requestId);
    // Snapshot: fail() deletes from the map while we iterate.
    for (const takeover of [...this.takeovers.values()])
      if (
        takeover.profileId === profileId &&
        (!threadId || takeover.holder.threadId === threadId) &&
        (!sessionGeneration || takeover.holder.sessionGeneration === sessionGeneration)
      )
        this.fail(takeover, new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" }));
  }
  pending(profileId: string): ComputerLeaseHolder | undefined {
    return [...this.takeovers.values()].find((entry) => entry.profileId === profileId)?.holder;
  }
  close(): void {
    this.offLease();
    for (const entry of this.preparing.values()) this.cancel(entry.profileId, entry.requestId);
    for (const takeover of [...this.takeovers.values()])
      this.fail(takeover, new ComputerControlError({ _tag: "Interrupted", cause: "paused" }));
  }
  private fail(takeover: Takeover, cause: unknown, respond = true): void {
    if (!this.takeovers.delete(takeover.requestId)) return;
    this.clearTimers(takeover);
    takeover.phase = "settled";
    this.controller.lease.cancelTakeover(takeover.reservation);
    this.options.state(takeover.profileId, takeover.holder, null);
    if (respond) takeover.respond({ error: computerError(cause) });
  }
  private clearTimers(takeover: Takeover): void {
    for (const timer of takeover.timers) clearTimeout(timer as ReturnType<typeof setTimeout>);
    takeover.timers = [];
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
