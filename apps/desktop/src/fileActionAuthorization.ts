import { randomUUID } from "node:crypto";

/** One-shot authorizations survive async UI work, but stay scoped to their renderer and target. */
export class FileActionAuthorizations {
  private readonly pending = new Map<string, { owner: number; target?: string; expires: number }>();
  private readonly nativeMenus = new Map<number, { target: string; expires: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  nativeMenuSelected(owner: number, target: string): void {
    this.prune();
    this.nativeMenus.set(owner, { target, expires: this.now() + 60_000 });
  }

  prepare(owner: number, target: string | undefined, trustedGesture: boolean): string {
    this.prune();
    const menu = this.nativeMenus.get(owner);
    const menuAuthorized = Boolean(menu && menu.target === target);
    if (!trustedGesture && !menuAuthorized)
      throw new Error("File actions require a user gesture or native-menu selection.");
    if (menuAuthorized) this.nativeMenus.delete(owner);
    if (this.pending.size >= 128) throw new Error("Too many pending file actions.");
    const token = randomUUID();
    this.pending.set(token, {
      owner,
      ...(target !== undefined ? { target } : {}),
      expires: this.now() + 5 * 60_000,
    });
    return token;
  }

  consume(owner: number, target: string, trustedGesture: boolean, token?: unknown): void {
    this.prune();
    if (token !== undefined) {
      const grant = typeof token === "string" ? this.pending.get(token) : undefined;
      if (
        !grant ||
        grant.owner !== owner ||
        (grant.target !== undefined && grant.target !== target)
      ) {
        throw new Error("Invalid or expired file-action authorization.");
      }
      this.pending.delete(token as string);
      return;
    }
    if (!trustedGesture) throw new Error("File actions require a user gesture.");
  }

  release(owner: number, token: unknown): void {
    this.prune();
    if (typeof token === "string" && this.pending.get(token)?.owner === owner)
      this.pending.delete(token);
  }

  private prune(): void {
    for (const [key, grant] of this.pending)
      if (grant.expires <= this.now()) this.pending.delete(key);
    for (const [key, grant] of this.nativeMenus)
      if (grant.expires <= this.now()) this.nativeMenus.delete(key);
  }
}
