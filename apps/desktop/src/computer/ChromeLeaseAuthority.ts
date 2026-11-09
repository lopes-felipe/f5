import type {
  ChromeLeaseHolder,
  ChromeProcessRegistration,
  ComputerLeaseHolder,
  ComputerLeaseScope,
} from "@t3tools/contracts";
import {
  computerError,
  ComputerControlError,
  CHROME_OWN_CALL_RUNNING_MESSAGE,
  CHROME_OWN_STOPPING_MESSAGE,
} from "@t3tools/shared/computerControl";
export { CHROME_OWN_CALL_RUNNING_MESSAGE, CHROME_OWN_STOPPING_MESSAGE };
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
export const CHROME_OWN_CODEX_MESSAGE =
  "This thread's Codex Chrome session blocks native computer control until it stops; Codex threads can't use both at once.";
export const CHROME_OWN_NATIVE_CONTROL_MESSAGE =
  "This thread holds foreground computer control, so its Chrome calls are refused until the turn ends (or, for a takeover, until a background action ends it).";
export const CHROME_NATIVE_WORK_FINISHING_MESSAGE =
  "Native computer input is still finishing; retry the Chrome call shortly.";

/**
 * Refusals of the holder's own thread that clear by themselves (its Chrome call ends, or its
 * lease finishes stopping), so a native request can wait in the admission queue for them.
 */
export function isChromeSelfWait(cause: unknown): boolean {
  const error = computerError(cause);
  return (
    error._tag === "Execution" &&
    (error.message === CHROME_OWN_CALL_RUNNING_MESSAGE ||
      error.message === CHROME_OWN_STOPPING_MESSAGE)
  );
}

/** Native scopes that exclude Chrome control: foreground, takeover, or a registered browser. */
export function nativeScopeExcludesChrome(scope: ComputerLeaseScope): boolean {
  return scope.kind !== "app" || COMPUTER_CHROME_APP_IDS.includes(scope.appId);
}

export interface ChromeLeaseAuthorityOptions {
  /**
   * Whether the holder's backend reported no Chrome call running. No report reads as busy,
   * so the same-thread exemption never applies to a session that can't say.
   */
  readonly callsIdle?: (holder: ChromeLeaseHolder) => boolean;
  /** One line per lease event, for the desktop log. Never tool inputs or titles. */
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

/** Admission re-runs every 250 ms while requests wait, so each refusal line is rate-limited. */
const CHROME_LOG_REPEAT_MS = 30_000;

const describeHolder = (holder: ChromeLeaseHolder) =>
  `profile=${holder.profileId} thread=${holder.threadId} provider=${holder.provider} generation=${holder.sessionGeneration}`;

/** Native-host registrations are machine resources, held for the provider session.
 * Chrome control excludes foreground native input and background control of every
 * registered browser; background leases on other apps coexist with it. The lease is
 * released only after main observes the provider's registered process group exit.
 *
 * One exception: a Claude session holds the lease for its CLI's whole life and can only
 * give it up by stopping, so the holder's own thread may take native control while none of
 * its Chrome calls runs. Chrome calls are then refused at validation while that thread holds
 * or has reserved such control, and while released native work is still finishing (see
 * `ComputerHostChannel`), so the two never act at once. */
export class ChromeLeaseAuthority {
  private holder: ChromeLeaseHolder | null = null;
  private paused = false;
  /** Generation invalidated by main (emergency stop, disconnect, replacement, shutdown). */
  private invalidated = false;
  /** Release requested; waiting for the registered group to exit. */
  private draining = false;
  /** When each rate-limited line was last written. */
  private readonly logged = new Map<string, number>();
  constructor(
    private readonly changed: (holder: ChromeLeaseHolder | null) => void,
    private readonly supervisor?: Pick<
      ChromeProcessSupervisor,
      "alive" | "stop" | "recoveryRequired"
    >,
    private readonly options: ChromeLeaseAuthorityOptions = {},
  ) {}
  current(): ChromeLeaseHolder | null {
    return this.holder;
  }
  recoveryRequired(): boolean {
    return this.supervisor?.recoveryRequired() ?? false;
  }
  /**
   * Whether native control in `profileId` may start or continue. `requester` names the
   * thread asking, so a Claude Chrome holder's own thread can take native control while its
   * Chrome calls are idle.
   */
  assertNativeAvailable(
    profileId: string,
    scope: ComputerLeaseScope = { kind: "foreground" },
    requester?: { readonly threadId: string },
  ): void {
    if (!this.holder && !this.recoveryRequired()) return;
    if (!nativeScopeExcludesChrome(scope)) return;
    if (!this.holder)
      throw new ComputerControlError({ _tag: "Execution", message: CHROME_RECOVERY_MESSAGE });
    const holder = this.holder;
    // The holder's own thread is never told another thread holds Chrome.
    if (requester && holder.profileId === profileId && holder.threadId === requester.threadId) {
      const refuse = (reason: string, message: string): never => {
        this.log(`native refused: ${reason} (${describeHolder(holder)})`, true);
        throw new ComputerControlError({ _tag: "Execution", message });
      };
      if (holder.provider !== "claude")
        refuse("own Codex Chrome session", CHROME_OWN_CODEX_MESSAGE);
      if (this.draining || this.invalidated)
        refuse("own Chrome lease stopping", CHROME_OWN_STOPPING_MESSAGE);
      if (this.options.callsIdle?.(holder) !== true)
        refuse("own Chrome call running", CHROME_OWN_CALL_RUNNING_MESSAGE);
      this.log(
        `native allowed for the Chrome holder's own thread (${describeHolder(holder)})`,
        true,
      );
      return;
    }
    this.log(
      `native refused for profile=${profileId} thread=${requester?.threadId ?? "unknown"}: held by ${describeHolder(holder)}${this.draining ? " (draining)" : ""}${this.invalidated ? " (invalidated)" : ""}`,
      true,
    );
    this.busy(profileId);
  }
  acquire(holder: ChromeLeaseHolder, native: ComputerLeaseHolder | null): void {
    if (this.recoveryRequired()) {
      this.log(`acquire refused, recovery required (${describeHolder(holder)})`, true);
      throw new ComputerControlError({ _tag: "Execution", message: CHROME_RECOVERY_MESSAGE });
    }
    if (native) {
      this.log(
        `acquire refused (${describeHolder(holder)}): native control held by profile=${native.profileId} thread=${native.threadId}`,
        true,
      );
      throw new ComputerControlError({
        _tag: "Busy",
        resource: "computer",
        ...(native.profileId === holder.profileId
          ? {
              holder: "same-profile" as const,
              holderThreadId: native.threadId,
              threadTitle: native.threadTitle,
            }
          : { holder: "other-profile" as const }),
      });
    }
    if (this.holder) {
      if (sameChromeHolder(this.holder, holder) && !this.draining && !this.invalidated) return;
      this.log(
        `acquire refused (${describeHolder(holder)}): held by ${describeHolder(this.holder)}`,
        true,
      );
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
      this.log(`acquire failed while announcing (${describeHolder(holder)})`);
      throw error;
    }
    this.log(`acquired (${describeHolder(holder)})`);
  }
  /**
   * Both providers hold the lease for their registered child's life (Codex's code can
   * outlive the call that started it), so release waits until every process in the group
   * has exited, stopping whatever remains.
   */
  release(holder: ChromeLeaseHolder, reason: ChromeStopReason = "release"): void {
    if (!this.holder || !sameChromeHolder(this.holder, holder)) return;
    this.log(`release requested, reason=${reason} (${describeHolder(holder)})`);
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
    if (this.holder) this.log(`released (${describeHolder(this.holder)})`);
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
    this.log(`interrupted, reason=${reason} (${describeHolder(holder)})`);
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
    this.log(`invalidated with its profile, reason=${reason} (${describeHolder(this.holder)})`);
    this.invalidated = true;
    this.release(this.holder, reason);
  }
  /**
   * Lease transitions are always written. Refusals and grants repeat on every admission retry
   * and per-action check, so each distinct line is written at most once per 30 s.
   */
  private log(message: string, rateLimited = false): void {
    if (!this.options.log) return;
    if (rateLimited) {
      const now = this.options.now?.() ?? Date.now();
      const last = this.logged.get(message);
      if (last !== undefined && now - last < CHROME_LOG_REPEAT_MS) return;
      if (this.logged.size >= 64) this.logged.clear();
      this.logged.set(message, now);
    }
    try {
      this.options.log(`chrome lease: ${message}`);
    } catch {
      // Logging never changes lease behaviour.
    }
  }
  /** Same-profile holders are named so the server can attribute (and preempt) them. */
  private busy(profileId: string): never {
    const holder = this.holder;
    throw new ComputerControlError({
      _tag: "Busy",
      resource: "chrome",
      ...(holder?.profileId === profileId
        ? { holder: "same-profile" as const, holderThreadId: holder.threadId }
        : { holder: "other-profile" as const }),
    });
  }
}
