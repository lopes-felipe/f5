import type { ChromeLeaseHolder, ComputerLeaseHolder } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";

export function sameChromeHolder(a: ChromeLeaseHolder, b: ChromeLeaseHolder): boolean {
  return (
    a.profileId === b.profileId &&
    a.threadId === b.threadId &&
    a.sessionGeneration === b.sessionGeneration &&
    a.provider === b.provider
  );
}

/** Native-host registrations are machine resources, held for the provider session.
 * The initial Chrome flow conservatively excludes all concurrent native input. */
export class ChromeLeaseAuthority {
  private holder: ChromeLeaseHolder | null = null;
  private paused = false;
  constructor(private readonly changed: (holder: ChromeLeaseHolder | null) => void) {}
  current(): ChromeLeaseHolder | null {
    return this.holder;
  }
  assertNativeAvailable(profileId: string): void {
    if (this.holder) this.busy(profileId);
  }
  acquire(holder: ChromeLeaseHolder, native: ComputerLeaseHolder | null): void {
    if (native)
      throw new ComputerControlError({
        _tag: "Busy",
        holder: native.profileId === holder.profileId ? "same-profile" : "other-profile",
      });
    if (this.holder) {
      if (sameChromeHolder(this.holder, holder)) return;
      this.busy(holder.profileId);
    }
    this.holder = holder;
    this.paused = false;
    try {
      this.changed(holder);
    } catch (error) {
      this.holder = null;
      this.paused = false;
      this.changed(null);
      throw error;
    }
  }
  release(holder: ChromeLeaseHolder): void {
    if (!this.holder || !sameChromeHolder(this.holder, holder)) return;
    this.holder = null;
    this.paused = false;
    this.changed(null);
  }
  setPaused(holder: ChromeLeaseHolder, paused: boolean): void {
    if (this.holder && sameChromeHolder(this.holder, holder)) this.paused = paused;
  }
  validate(holder: ChromeLeaseHolder): void {
    if (!this.holder || !sameChromeHolder(this.holder, holder))
      throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (this.paused) throw new ComputerControlError({ _tag: "Interrupted", cause: "paused" });
  }
  releaseProfile(profileId: string): void {
    if (this.holder?.profileId === profileId) this.release(this.holder);
  }
  private busy(profileId: string): never {
    throw new ComputerControlError({
      _tag: "Busy",
      holder: this.holder?.profileId === profileId ? "same-profile" : "other-profile",
    });
  }
}
