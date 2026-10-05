/** Shortcut registrations are shared by all enabled windows; activation selects the active owner. */
export class CaptureShortcut {
  readonly #owners = new Map<number, { key: string; invoke: () => void }>();
  readonly #registered = new Set<string>();
  constructor(
    readonly register: (key: string, invoke: () => void) => boolean,
    readonly unregister: (key: string) => void,
    readonly activeOwner: () => number | undefined = () => undefined,
  ) {}
  configure(owner: number, key: string, enabled: boolean, invoke: () => void): void {
    if (!enabled) {
      this.release(owner);
      return;
    }
    if (!this.#registered.has(key)) {
      if (
        !this.register(key, () => {
          const candidates = [...this.#owners].filter(([, value]) => value.key === key);
          const active = this.activeOwner();
          const target = candidates.find(([id]) => id === active) ?? candidates.at(-1);
          target?.[1].invoke();
        })
      )
        throw new Error("The capture shortcut is unavailable.");
      this.#registered.add(key);
    }
    this.#owners.delete(owner);
    this.#owners.set(owner, { key, invoke });
    this.#prune();
  }
  #prune(): void {
    for (const key of this.#registered)
      if (![...this.#owners.values()].some((value) => value.key === key)) {
        this.unregister(key);
        this.#registered.delete(key);
      }
  }
  release(owner: number): void {
    this.#owners.delete(owner);
    this.#prune();
  }
}
