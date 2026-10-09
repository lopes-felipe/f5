import type { ComputerLeaseHolder } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";

export function sameComputerHolder(a: ComputerLeaseHolder, b: ComputerLeaseHolder): boolean {
  return (
    a.profileId === b.profileId &&
    a.threadId === b.threadId &&
    a.sessionGeneration === b.sessionGeneration &&
    a.turnId === b.turnId &&
    a.executionGeneration === b.executionGeneration &&
    a.backend === b.backend
  );
}
/** Owned by Electron main, shared across every profile and provider. */
export class ComputerLeaseAuthority {
  private holder: ComputerLeaseHolder | null = null;
  private generation = 0;
  private lastMutationAt = 0;
  private readonly listeners = new Set<(holder: ComputerLeaseHolder | null) => void>();
  constructor(private readonly now: () => number = Date.now) {}
  current(): ComputerLeaseHolder | null {
    return this.holder;
  }
  acquire(input: ComputerLeaseHolder): ComputerLeaseHolder {
    this.sweep();
    if (this.holder) {
      const holder = this.holder;
      if (
        holder.profileId === input.profileId &&
        holder.threadId === input.threadId &&
        holder.sessionGeneration === input.sessionGeneration &&
        holder.turnId === input.turnId &&
        holder.backend === input.backend
      )
        return holder;
      throw new ComputerControlError({
        _tag: "Busy",
        holder: holder.profileId === input.profileId ? "same-profile" : "other-profile",
        ...(holder.profileId === input.profileId ? { threadTitle: holder.threadTitle } : {}),
      });
    }
    this.holder = { ...input, executionGeneration: ++this.generation };
    this.lastMutationAt = this.now();
    this.notify();
    return this.holder;
  }
  touch(holder: ComputerLeaseHolder): void {
    if (this.holder && sameComputerHolder(this.holder, holder)) this.lastMutationAt = this.now();
  }
  release(holder: ComputerLeaseHolder): void {
    if (this.holder && sameComputerHolder(this.holder, holder)) {
      this.holder = null;
      this.notify();
    }
  }
  releaseProfile(profileId: string): void {
    if (this.holder?.profileId === profileId) this.release(this.holder);
  }
  invalidate(): void {
    ++this.generation;
    if (this.holder) {
      this.holder = null;
      this.notify();
    }
  }
  sweep(): void {
    if (this.holder && this.now() - this.lastMutationAt >= 60_000) this.release(this.holder);
  }
  subscribe(listener: (holder: ComputerLeaseHolder | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.holder);
      } catch {
        /* Authority must survive a failing observer. */
      }
    }
  }
}
