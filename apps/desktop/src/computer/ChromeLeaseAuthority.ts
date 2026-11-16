import {
  CHROME_LEASE_HOLDERS_MAX,
  type ChromeLeaseHolder,
  type ChromeProcessRegistration,
  type ComputerLeaseHolder,
  type ComputerLeaseScope,
} from "@t3tools/contracts";
import {
  computerError,
  ComputerControlError,
  CHROME_OWN_CALL_RUNNING_MESSAGE,
  CHROME_OWN_STOPPING_MESSAGE,
  CHROME_NATIVE_WORK_FINISHING_MESSAGE,
  CHROME_WAITING_FOR_CHROME_CALL_MESSAGE,
  CHROME_WAITING_FOR_NATIVE_MESSAGE,
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
export {
  CHROME_NATIVE_WORK_FINISHING_MESSAGE,
  CHROME_WAITING_FOR_CHROME_CALL_MESSAGE,
  CHROME_WAITING_FOR_NATIVE_MESSAGE,
};

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
  /**
   * Whether the holder's backend admits every Chrome call through main
   * (`COMPUTER_CHROME_CALL_ADMISSION_CAPABILITY`). Only then can another thread's native
   * control start while the holder is idle: main sees each call before it runs.
   */
  readonly callAdmission?: (holder: ChromeLeaseHolder) => boolean;
  /**
   * Whether the holder's backend negotiated `COMPUTER_CHROME_SHARED_CAPABILITY`, so it
   * learns every holder of its profile and serializes its calls through main.
   */
  readonly sharedCapable?: (holder: ChromeLeaseHolder) => boolean;
  /** A profile's display name, for other-profile refusals. */
  readonly profileName?: (profileId: string) => string | undefined;
  /** One line per lease event, for the desktop log. Never tool inputs or titles. */
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

/** Admission re-runs every 250 ms while requests wait, so each refusal line is rate-limited. */
const CHROME_LOG_REPEAT_MS = 30_000;

const describeHolder = (holder: ChromeLeaseHolder) =>
  `profile=${holder.profileId} thread=${holder.threadId} provider=${holder.provider} generation=${holder.sessionGeneration}`;

interface Entry {
  readonly holder: ChromeLeaseHolder;
  /** Acquired as shared (`chromeLeaseAcquire.shared`) from a shared-capable backend. */
  readonly shared: boolean;
  paused: boolean;
  /** Generation invalidated by main (emergency stop, disconnect, replacement, shutdown). */
  invalidated: boolean;
  /** Release requested; waiting for the registered group to exit. */
  draining: boolean;
}

/** Native-host registrations are machine resources, held for the provider session.
 * Chrome control excludes foreground native input and background control of every
 * registered browser; background leases on other apps coexist with it. A lease is
 * released only after main observes the provider's registered process group exit.
 *
 * Claude sessions whose certified record proves one native host serves several CLIs
 * (`shared-native-host`) hold Chrome together, across profiles; any other holder (Codex, a
 * restore, an uncertified or older backend) holds it alone. Main runs one shared call at a
 * time (see `ComputerHostChannel`).
 *
 * A Claude session holds the lease for its CLI's whole life and can only give it up by
 * stopping, so the lease alone must not lock the machine. While none of its Chrome calls
 * runs, native control may start: always for the holder's own thread, and for any other
 * thread or profile when its backend admits each call through main. Chrome calls are then
 * refused at validation while such native control is held or reserved, and while released
 * native work is still finishing (see `ComputerHostChannel`), so the two never act at once. */
export class ChromeLeaseAuthority {
  private entries: Entry[] = [];
  /** When each rate-limited line was last written. */
  private readonly logged = new Map<string, number>();
  constructor(
    private readonly changed: (holders: ReadonlyArray<ChromeLeaseHolder>) => void,
    private readonly supervisor?: Pick<
      ChromeProcessSupervisor,
      "alive" | "stop" | "recoveryRequired"
    >,
    private readonly options: ChromeLeaseAuthorityOptions = {},
  ) {}
  /** The first holder, or none. Holders after it share Chrome with it. */
  current(): ChromeLeaseHolder | null {
    return this.entries[0]?.holder ?? null;
  }
  holders(): ReadonlyArray<ChromeLeaseHolder> {
    return this.entries.map((entry) => entry.holder);
  }
  /** The live holder of `profileId`/`threadId`, if it holds Chrome. */
  holderOf(profileId: string, threadId: string): ChromeLeaseHolder | undefined {
    return this.entries.find(
      (entry) => entry.holder.profileId === profileId && entry.holder.threadId === threadId,
    )?.holder;
  }
  holds(holder: ChromeLeaseHolder): boolean {
    return this.entry(holder) !== undefined;
  }
  private entry(holder: ChromeLeaseHolder): Entry | undefined {
    return this.entries.find((entry) => sameChromeHolder(entry.holder, holder));
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
    if (!this.entries.length && !this.recoveryRequired()) return;
    if (!nativeScopeExcludesChrome(scope)) return;
    if (!this.entries.length)
      throw new ComputerControlError({ _tag: "Execution", message: CHROME_RECOVERY_MESSAGE });
    for (const entry of this.entries) {
      const holder = entry.holder;
      // The holder's own thread is never told another thread holds Chrome.
      if (requester && holder.profileId === profileId && holder.threadId === requester.threadId) {
        const refuse = (reason: string, message: string): never => {
          this.log(`native refused: ${reason} (${describeHolder(holder)})`, true);
          throw new ComputerControlError({ _tag: "Execution", message });
        };
        if (holder.provider !== "claude")
          refuse("own Codex Chrome session", CHROME_OWN_CODEX_MESSAGE);
        if (entry.draining || entry.invalidated)
          refuse("own Chrome lease stopping", CHROME_OWN_STOPPING_MESSAGE);
        if (this.options.callsIdle?.(holder) !== true)
          refuse("own Chrome call running", CHROME_OWN_CALL_RUNNING_MESSAGE);
        this.log(
          `native allowed for the Chrome holder's own thread (${describeHolder(holder)})`,
          true,
        );
        continue;
      }
      // An idle Claude session reserves Chrome but acts on nothing: other threads' native
      // control proceeds, and the holder's next call waits for it at validation.
      if (this.sharesWhileIdle(entry)) {
        this.log(
          `native allowed for profile=${profileId} thread=${requester?.threadId ?? "unknown"}: Chrome holder idle (${describeHolder(holder)})`,
          true,
        );
        continue;
      }
      this.log(
        `native refused for profile=${profileId} thread=${requester?.threadId ?? "unknown"}: held by ${describeHolder(holder)}${entry.draining ? " (draining)" : ""}${entry.invalidated ? " (invalidated)" : ""}`,
        true,
      );
      this.busy(profileId, entry);
    }
  }
  /** A Claude holder, not stopping, whose backend admits calls through main and runs none. */
  private sharesWhileIdle(entry: Entry): boolean {
    return (
      entry.holder.provider === "claude" &&
      !entry.draining &&
      !entry.invalidated &&
      this.options.callAdmission?.(entry.holder) === true &&
      this.options.callsIdle?.(entry.holder) === true
    );
  }
  /** Whether some holder refuses other threads' foreground control. */
  blocksOthersNative(): boolean {
    return this.entries.some((entry) => !this.sharesWhileIdle(entry));
  }
  /** Whether `holder` refuses other threads' foreground control. */
  blocksNative(holder: ChromeLeaseHolder): boolean {
    const entry = this.entry(holder);
    return entry !== undefined && !this.sharesWhileIdle(entry);
  }
  /** Whether a holder runs (or may run) a Chrome call right now. */
  private activity(entry: Entry | undefined): "chrome-call" | "chrome-session" {
    return entry && this.options.callsIdle?.(entry.holder) === true
      ? "chrome-session"
      : "chrome-call";
  }
  /** Healthy, shared, from a shared-capable backend: may hold Chrome beside others like it. */
  private shareable(entry: Pick<Entry, "holder" | "shared">): boolean {
    return (
      entry.shared &&
      entry.holder.provider === "claude" &&
      this.options.sharedCapable?.(entry.holder) === true
    );
  }
  /**
   * Shared sessions from different profiles hold Chrome together. Threads in one profile
   * share one Claude config, wrapper and journal, which certification didn't cover, so they
   * still take turns: an idle one is preempted as before.
   */
  private coexist(a: Pick<Entry, "holder" | "shared">, b: Pick<Entry, "holder" | "shared">) {
    return this.shareable(a) && this.shareable(b) && a.holder.profileId !== b.holder.profileId;
  }
  acquire(holder: ChromeLeaseHolder, native: ComputerLeaseHolder | null, shared = false): void {
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
        activity: "computer",
        ...(native.profileId === holder.profileId
          ? {
              holder: "same-profile" as const,
              holderThreadId: native.threadId,
              threadTitle: native.threadTitle,
            }
          : { holder: "other-profile" as const, ...this.profileLabel(native.profileId) }),
      });
    }
    const existing = this.entry(holder);
    if (existing && !existing.draining && !existing.invalidated) return;
    const candidate = { holder, shared };
    // A stopping generation of the same holder still owns its slot until its group exits.
    // Another profile's stopping session doesn't: its CLI's exit can't disturb a peer's.
    const blocking =
      this.entries.length >= CHROME_LEASE_HOLDERS_MAX
        ? this.entries[0]
        : this.entries.find((entry) => entry === existing || !this.coexist(candidate, entry));
    if (blocking) {
      this.log(
        `acquire refused (${describeHolder(holder)}): held by ${describeHolder(blocking.holder)}`,
        true,
      );
      this.busy(holder.profileId, blocking);
    }
    const entry: Entry = { holder, shared, paused: false, invalidated: false, draining: false };
    this.entries = [...this.entries, entry];
    try {
      this.changed(this.holders());
    } catch (error) {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      this.changed(this.holders());
      this.log(`acquire failed while announcing (${describeHolder(holder)})`);
      throw error;
    }
    this.log(
      `acquired${this.entries.length > 1 ? `, shared with ${this.entries.length - 1}` : ""} (${describeHolder(holder)})`,
    );
  }
  /**
   * Both providers hold the lease for their registered child's life (Codex's code can
   * outlive the call that started it), so release waits until every process in the group
   * has exited, stopping whatever remains.
   */
  release(holder: ChromeLeaseHolder, reason: ChromeStopReason = "release"): void {
    const entry = this.entry(holder);
    if (!entry) return;
    this.log(`release requested, reason=${reason} (${describeHolder(holder)})`);
    const filter = ownedBy(holder);
    if (this.supervisor?.alive(filter)) {
      entry.draining = true;
      this.supervisor.stop(filter, reason);
      return;
    }
    this.clear(entry);
  }
  /** A registered process exited: finish each pending release once nothing remains alive. */
  processExited(): void {
    for (const entry of this.entries)
      if (entry.draining && !this.supervisor?.alive(ownedBy(entry.holder))) this.clear(entry);
  }
  private clear(entry: Entry): void {
    if (!this.entries.includes(entry)) return;
    this.log(`released (${describeHolder(entry.holder)})`);
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    this.changed(this.holders());
  }
  setPaused(holder: ChromeLeaseHolder, paused: boolean): void {
    const entry = this.entry(holder);
    if (entry && !entry.invalidated) entry.paused = paused;
  }
  /** Synchronous invalidation of every holder; each group is stopped without the server. */
  interrupt(reason: ChromeStopReason = "emergency"): ReadonlyArray<ChromeLeaseHolder> {
    const interrupted = [...this.entries];
    for (const entry of interrupted) {
      this.log(`interrupted, reason=${reason} (${describeHolder(entry.holder)})`);
      entry.invalidated = true;
      entry.paused = true;
      this.release(entry.holder, reason);
    }
    return interrupted.map((entry) => entry.holder);
  }
  validate(holder: ChromeLeaseHolder): void {
    if (this.recoveryRequired())
      throw new ComputerControlError({ _tag: "Execution", message: CHROME_RECOVERY_MESSAGE });
    const entry = this.entry(holder);
    if (!entry || entry.draining || entry.invalidated)
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (entry.paused) throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
  }
  /** Whether `holder` was acquired as shared and still shares (see `shareable`). */
  sharedHolder(holder: ChromeLeaseHolder): boolean {
    const entry = this.entry(holder);
    return entry !== undefined && this.shareable(entry);
  }
  /** Profile disconnect or backend replacement: the server can no longer stop its children. */
  releaseProfile(profileId: string, reason: ChromeStopReason = "unresponsive"): void {
    this.supervisor?.stop((registration) => registration.profileId === profileId, reason);
    for (const entry of this.entries.filter(
      (candidate) => candidate.holder.profileId === profileId,
    )) {
      this.log(`invalidated with its profile, reason=${reason} (${describeHolder(entry.holder)})`);
      entry.invalidated = true;
      this.release(entry.holder, reason);
    }
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
  private busy(profileId: string, entry: Entry | undefined = this.entries[0]): never {
    const holder = entry?.holder;
    throw new ComputerControlError({
      _tag: "Busy",
      resource: "chrome",
      activity: this.activity(entry),
      ...(holder?.profileId === profileId
        ? { holder: "same-profile" as const, holderThreadId: holder.threadId }
        : {
            holder: "other-profile" as const,
            ...(holder ? this.profileLabel(holder.profileId) : {}),
          }),
    });
  }
  private profileLabel(profileId: string): { holderProfileName?: string } {
    const name = this.options.profileName?.(profileId)?.trim();
    return name ? { holderProfileName: name.slice(0, 100) } : {};
  }
}
