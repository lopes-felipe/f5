/** Keep the previous shortcut live if a replacement cannot be registered. */
export class CaptureShortcut {
  #key: string | null = null;
  #owner: number | null = null;
  #invoke: (() => void) | null = null;
  constructor(
    readonly register: (key: string, invoke: () => void) => boolean,
    readonly unregister: (key: string) => void,
  ) {}
  configure(owner: number, key: string, enabled: boolean, invoke: () => void): void {
    if (!enabled) {
      this.release(owner);
      return;
    }
    if (key !== this.#key) {
      if (!this.register(key, () => this.#invoke?.()))
        throw new Error("The capture shortcut is unavailable.");
      if (this.#key) this.unregister(this.#key);
      this.#key = key;
    }
    this.#owner = owner;
    this.#invoke = invoke;
  }
  release(owner: number): void {
    if (this.#owner !== owner) return;
    if (this.#key) this.unregister(this.#key);
    this.#key = null;
    this.#owner = null;
    this.#invoke = null;
  }
}
