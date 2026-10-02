import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopBrowserProfile } from "@t3tools/contracts";

export function browserPartition(
  scope: string,
  profile: Pick<DesktopBrowserProfile, "id" | "persistent">,
): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope) || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id))
    throw new Error("Invalid browser profile.");
  return `${profile.persistent ? "persist:" : ""}f5-preview-${scope}-${profile.id}`;
}
/** Metadata is serialized before exposure; imported profiles are never published halfway. */
export class BrowserProfiles {
  readonly #file: string;
  readonly #scope: string;
  readonly #clear: (partition: string) => Promise<void>;
  #profiles: DesktopBrowserProfile[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | undefined;
  #selected = "default";
  #staging: string[] = [];
  constructor(directory: string, scope: string, clear: (partition: string) => Promise<void>) {
    this.#file = path.join(directory, "preview-browser-profiles.json");
    this.#scope = scope;
    this.#clear = clear;
  }
  initialize(): Promise<void> {
    return (this.#ready ??= (async () => {
      let values: unknown = [];
      try {
        values = JSON.parse(await readFile(this.#file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Browser profiles could not be read.");
      }
      if (!Array.isArray(values) || values.length > 32)
        throw new Error("Invalid browser profiles.");
      this.#profiles = values.map((v: DesktopBrowserProfile) => {
        if (
          !v ||
          typeof v.name !== "string" ||
          !v.name.trim() ||
          v.name.length > 100 ||
          v.persistent !== true
        )
          throw new Error("Invalid browser profiles.");
        browserPartition(this.#scope, v);
        return { id: v.id, name: v.name, persistent: true };
      });
      if (new Set(this.#profiles.map((v) => v.id)).size !== this.#profiles.length)
        throw new Error("Duplicate browser profile.");
      if (!this.#profiles.some((v) => v.id === "default"))
        this.#profiles.unshift({ id: "default", name: "Default", persistent: true });
      let pending: unknown = [];
      try {
        pending = JSON.parse(await readFile(this.#file + ".staging", "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Import staging metadata could not be read.");
      }
      if (!Array.isArray(pending) || pending.length > 32)
        throw new Error("Invalid import staging metadata.");
      for (const id of pending) {
        if (typeof id !== "string") throw new Error("Invalid import staging metadata.");
        if (!this.#profiles.some((p) => p.id === id))
          await this.#clear(browserPartition(this.#scope, { id, persistent: true }));
      }
      await this.#saveStages([]);
    })());
  }
  async list(): Promise<DesktopBrowserProfile[]> {
    await this.initialize();
    await this.#queue;
    return this.#profiles.map((v) => ({ ...v }));
  }
  async config(id = this.#selected): Promise<DesktopBrowserProfile & { partition: string }> {
    await this.initialize();
    const profile = this.#profiles.find((v) => v.id === id);
    if (!profile) throw new Error("Unknown browser profile.");
    return { ...profile, partition: browserPartition(this.#scope, profile) };
  }
  async select(id: string): Promise<void> {
    await this.config(id);
    this.#selected = id;
  }
  #serial<A>(run: () => Promise<A>): Promise<A> {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
  async #persist(values: DesktopBrowserProfile[]): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(values.filter((v) => v.persistent)), { mode: 0o600 });
    await rename(temp, this.#file);
  }
  create(name: string, persistent = true): Promise<DesktopBrowserProfile> {
    return this.#serial(async () => {
      await this.initialize();
      if (!name.trim() || name.length > 100 || this.#profiles.length >= 32)
        throw new Error("Invalid name or browser profile limit reached.");
      const value = { id: randomUUID(), name: name.trim(), persistent };
      const next = [...this.#profiles, value];
      await this.#persist(next);
      this.#profiles = next;
      return { ...value };
    });
  }
  /** Reserve a private partition, then publish only after import has flushed successfully. */
  async stage(name: string): Promise<{
    profile: DesktopBrowserProfile;
    partition: string;
    commit: () => Promise<DesktopBrowserProfile>;
    discard: () => Promise<void>;
  }> {
    const profile = { id: randomUUID(), name: name.trim(), persistent: true };
    const partition = browserPartition(this.#scope, profile);
    await this.#serial(async () => {
      await this.initialize();
      await this.#saveStages([...this.#staging, profile.id]);
    });
    let finished = false;
    return {
      profile,
      partition,
      commit: () =>
        this.#serial(async () => {
          await this.initialize();
          if (finished || !profile.name || profile.name.length > 100 || this.#profiles.length >= 32)
            throw new Error("Invalid import staging profile.");
          const next = [...this.#profiles, profile];
          await this.#persist(next);
          this.#profiles = next;
          finished = true;
          await this.#saveStages(this.#staging.filter((id) => id !== profile.id)).catch(
            () => undefined,
          );
          return { ...profile };
        }),
      discard: () =>
        this.#serial(async () => {
          if (!finished) {
            await this.#clear(partition);
            await this.#saveStages(this.#staging.filter((id) => id !== profile.id));
            finished = true;
          }
        }),
    };
  }
  async #saveStages(ids: string[]): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temp = this.#file + ".staging." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(ids), { mode: 0o600 });
    await rename(temp, this.#file + ".staging");
    this.#staging = ids;
  }
  delete(id: string): Promise<void> {
    return this.#serial(async () => {
      const value = await this.config(id);
      if (id === "default") throw new Error("The default browser profile cannot be deleted.");
      await this.#clear(value.partition);
      const next = this.#profiles.filter((v) => v.id !== id);
      await this.#persist(next);
      this.#profiles = next;
      if (this.#selected === id) this.#selected = "default";
    });
  }
  ownsPartition(partition: string): boolean {
    return this.#profiles.some((v) => browserPartition(this.#scope, v) === partition);
  }
}
