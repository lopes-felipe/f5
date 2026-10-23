import type {
  ChromeLeaseHolder,
  ChromeProcessRegistration,
  ComputerLeaseHolder,
  ComputerLeaseScope,
} from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { COMPUTER_CHROME_APP_IDS } from "@t3tools/shared/computerExecution";
import type { ChromeProcessSupervisor, ChromeStopReason } from "./ChromeProcessSupervisor";

export function sameChromeHolder(a: ChromeLeaseHolder, b: ChromeLeaseHolder): boolean {
  return (
    a.profileId === b.profileId &&
    a.threadId === b.threadId &&
    a.sessionGeneration === b.sessionGeneration &&
    a.provider === b.provider
  );
}
const ownedBy = (holder: ChromeLeaseHolder) => (registration: ChromeProcessRegistration) =>
  registration.integration === (holder.provider === "claude" ? "claude-chrome" : "codex-chrome") &&
  registration.profileId === holder.profileId &&
  registration.threadId === holder.threadId &&
  registration.sessionGeneration === holder.sessionGeneration;

export const CHROME_RECOVERY_MESSAGE =
  "Browser control from an earlier session hasn't stopped yet. Quit Chrome control there or restart your Mac, then retry.";

/** Native-host registrations are machine resources, held for the provider session.
 * Chrome control excludes foreground native input and background control of every
 * registered browser; background leases on other apps coexist with it. The lease is
 * released only after main observes the provider's registered process group exit. */
export class ChromeLeaseAuthority {
  private holder: ChromeLeaseHolder | null = null;
  private paused = false;
  /** Generation invalidated by main (emergency stop, disconnect, replacement, shutdown). */
  private invalidated = false;
  /** Release requested; waiting for the registered group to exit. */
  private draining = false;
  constructor(
    private readonly changed: (holder: ChromeLeaseHolder | null) => void,
    private readonly supervisor?: Pick<
      ChromeProcessSupervisor,
      "alive" | "stop" | "recoveryRequired"
    >,
  ) {}
  current(): ChromeLeaseHolder | null {
    return this.holder;
  }
  recoveryRequired(): boolean {
    return this.supervisor?.recoveryRequired() ?? false;
  }
  assertNativeAvailable(
    profileId: string,
    scope: ComputerLeaseScope = { kind: "foreground" },
  ): void {
    if (!this.holder && !this.recoveryRequired()) return;
    if (scope.kind === "app" && !COMPUTER_CHROME_APP_IDS.includes(scope.appId)) return;
    if (!this.holder)
      throw new ComputerControlError({ _tag: "Execution", message: CHROME_RECOVERY_MESSAGE });
    this.busy(profileId);
  }
  acquire(holder: ChromeLeaseHolder, native: ComputerLeaseHolder | null): void {
    if (this.recoveryRequired())
      throw new ComputerControlError({ _tag: "Execution", message: CHROME_RECOVERY_MESSAGE });
    if (native)
      throw new ComputerControlError({
        _tag: "Busy",
        holder: native.profileId === holder.profileId ? "same-profile" : "other-profile",
      });
    if (this.holder) {
      if (sameChromeHolder(this.holder, holder) && !this.draining && !this.invalidated) return;
      this.busy(holder.profileId);
    }
    this.holder = holder;
    this.paused = false;
    this.invalidated = false;
    this.draining = false;
    try {
      this.changed(holder);
    } catch (error) {
      this.holder = null;
      this.paused = false;
      this.changed(null);
      throw error;
    }
  }
  /**
   * Both providers hold the lease for their registered child's life (Codex's code can
   * outlive the call that started it), so release waits until every process in the group
   * has exited, stopping whatever remains.
   */
  release(holder: ChromeLeaseHolder, reason: ChromeStopReason = "release"): void {
    if (!this.holder || !sameChromeHolder(this.holder, holder)) return;
    const filter = ownedBy(holder);
    if (this.supervisor?.alive(filter)) {
      this.draining = true;
      this.supervisor.stop(filter, reason);
      return;
    }
    this.clear();
  }
  /** A registered process exited: finish a pending release once nothing remains alive. */
  processExited(): void {
    if (!this.holder || !this.draining) return;
    if (this.supervisor?.alive(ownedBy(this.holder))) return;
    this.clear();
  }
  private clear(): void {
    this.holder = null;
    this.paused = false;
    this.invalidated = false;
    this.draining = false;
    this.changed(null);
  }
  setPaused(holder: ChromeLeaseHolder, paused: boolean): void {
    if (this.holder && sameChromeHolder(this.holder, holder) && !this.invalidated)
      this.paused = paused;
  }
  /** Synchronous generation invalidation; the group is stopped without the server. */
  interrupt(reason: ChromeStopReason = "emergency"): ChromeLeaseHolder | null {
    const holder = this.holder;
    if (!holder) return null;
    this.invalidated = true;
    this.paused = true;
    this.release(holder, reason);
    return holder;
  }
  validate(holder: ChromeLeaseHolder): void {
    if (this.recoveryRequired())
      throw new ComputerControlError({ _tag: "Execution", message: CHROME_RECOVERY_MESSAGE });
    if (!this.holder || !sameChromeHolder(this.holder, holder) || this.draining || this.invalidated)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (this.paused) throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
  }
  /** Profile disconnect or backend replacement: the server can no longer stop its children. */
  releaseProfile(profileId: string, reason: ChromeStopReason = "unresponsive"): void {
    this.supervisor?.stop((registration) => registration.profileId === profileId, reason);
    if (this.holder?.profileId !== profileId) return;
    this.invalidated = true;
    this.release(this.holder, reason);
  }
  private busy(profileId: string): never {
    throw new ComputerControlError({
      _tag: "Busy",
      holder: this.holder?.profileId === profileId ? "same-profile" : "other-profile",
    });
  }
}
