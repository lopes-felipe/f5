import { ComputerControlError } from "@t3tools/shared/computerControl";

/** Focus history lasts for one helper lifetime. A former peer needs a press after handoff.
 * Restart latches execution before resetting history. Eviction requires a press conservatively.
 */
export class ComputerSharedAppState {
  private readonly apps = new Map<
    string,
    { sequence: number; firstMutator: string; mixed: boolean }
  >();
  private readonly presses = new Map<string, Map<string, number>>();
  private overflowed = false;
  private sequence = 0;
  epoch(appId: string): number {
    return this.apps.get(appId)?.sequence ?? (this.overflowed ? this.sequence : 0);
  }
  assertTyping(appId: string, owner: string, anotherLease: boolean): void {
    const state = this.apps.get(appId);
    const press = this.presses.get(appId)?.get(owner);
    if (press !== undefined) return; // Other mutations remove this press synchronously.
    if (
      anotherLease ||
      (!state && this.overflowed) ||
      (state && (state.mixed || state.firstMutator !== owner))
    )
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "shared-focus" });
  }
  mutated(appId: string, owner: string, press: boolean): void {
    const previous = this.apps.get(appId);
    const sequence = ++this.sequence;
    if (!previous && this.apps.size >= 2048) {
      const oldest = this.apps.keys().next().value!;
      this.apps.delete(oldest);
      this.presses.delete(oldest);
      this.overflowed = true;
    }
    this.apps.set(appId, {
      sequence,
      firstMutator: previous?.firstMutator ?? owner,
      mixed:
        previous?.mixed === true ||
        (!previous && this.overflowed) ||
        (!!previous && previous.firstMutator !== owner),
    });
    const presses = this.presses.get(appId) ?? new Map<string, number>();
    for (const other of presses.keys()) if (other !== owner) presses.delete(other);
    if (press) presses.set(owner, sequence);
    this.presses.set(appId, presses);
  }
  yielded(appId: string): void {
    this.presses.delete(appId);
  }
  releaseOwner(owner: string): void {
    for (const [appId, presses] of this.presses) {
      presses.delete(owner);
      if (!presses.size) this.presses.delete(appId);
    }
  }
  reset(): void {
    this.apps.clear();
    this.presses.clear();
    this.overflowed = false;
    this.sequence = 0;
  }
}
