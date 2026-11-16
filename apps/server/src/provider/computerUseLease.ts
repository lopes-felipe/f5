/**
 * The machine has one screen, mouse, and keyboard, so at most one agent thread may
 * control it at a time. The lease is process-wide and in memory: a server restart
 * ends every provider session, which releases control anyway.
 */
export type ComputerUseLeaseListener = (holder: string | null) => void;

export class ComputerUseLease {
  private holder: string | null = null;
  private readonly listeners = new Set<ComputerUseLeaseListener>();

  current(): string | null {
    return this.holder;
  }
  /** Compatibility mirror; desktop main is the device authority for v2. */
  setFromHost(threadId: string | null): void {
    if (this.holder === threadId) return;
    this.holder = threadId;
    this.notify();
  }

  /** Grants or keeps the lease for `threadId`; false when another thread holds it. */
  acquire(threadId: string): boolean {
    if (this.holder === threadId) return true;
    if (this.holder !== null) return false;
    this.holder = threadId;
    this.notify();
    return true;
  }

  isHeldByOther(threadId: string): boolean {
    return this.holder !== null && this.holder !== threadId;
  }

  release(threadId: string): void {
    if (this.holder !== threadId) return;
    this.holder = null;
    this.notify();
  }

  subscribe(listener: ComputerUseLeaseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.holder);
      } catch {
        // A failing observer must not affect who controls the computer.
      }
    }
  }
}

export const computerUseLease = new ComputerUseLease();
