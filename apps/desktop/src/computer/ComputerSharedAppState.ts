import { ComputerControlError } from "@t3tools/shared/computerControl";

/** Focus belongs to the app, so another agent's writes invalidate a prior field press. */
export class ComputerSharedAppState {
  private readonly apps = new Map<
    string,
    { sequence: number; firstMutator: string; mixed: boolean }
  >();
  private readonly presses = new Map<string, Map<string, number>>();
  assertTyping(appId: string, owner: string, anotherLease: boolean): void {
    const state = this.apps.get(appId);
    const press = this.presses.get(appId)?.get(owner);
    if (press !== undefined) return; // Other mutations remove this press synchronously.
    if (anotherLease || (state && (state.mixed || state.firstMutator !== owner)))
      throw new ComputerControlError({ _tag: "TargetBlocked", kind: "shared-focus" });
  }
  mutated(appId: string, owner: string, press: boolean): void {
    const previous = this.apps.get(appId);
    const sequence = (previous?.sequence ?? 0) + 1;
    this.apps.set(appId, {
      sequence,
      firstMutator: previous?.firstMutator ?? owner,
      mixed: previous?.mixed === true || (!!previous && previous.firstMutator !== owner),
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
  }
}
