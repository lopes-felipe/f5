import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface IntegrationConsentIo {
  readonly read: () => string | undefined;
  readonly write: (contents: string) => void;
  readonly remove: () => void;
}

/** Atomic JSON file; missing or unreadable files mean no grants. */
export function fileConsentIo(path: string): IntegrationConsentIo {
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    write: (contents) => {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    remove: () => rmSync(path, { force: true }),
  };
}

export interface ConsentKeyCrypto {
  readonly available: () => boolean;
  readonly encrypt: (plain: string) => Buffer;
  readonly decrypt: (encrypted: Buffer) => string;
}

/** One main-owned getter can share the OS-protected signing key across policy stores. */
export function keychainConsentKey(
  path: string,
  crypto: ConsentKeyCrypto,
): () => Buffer | undefined {
  let key: Buffer | undefined;
  return () => {
    if (key) return key;
    if (!crypto.available()) return undefined;
    try {
      const plain = crypto.decrypt(readFileSync(path));
      if (/^[0-9a-f]{64}$/.test(plain)) return (key = Buffer.from(plain, "hex"));
    } catch {
      // Missing or unreadable: replace the key, invalidating the old records.
    }
    try {
      const fresh = randomBytes(32);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, crypto.encrypt(fresh.toString("hex")), { mode: 0o600 });
      return (key = fresh);
    } catch {
      return undefined;
    }
  };
}

export interface SignedRecordOptions<R extends object> {
  readonly payload: (profileId: string, record: R, id: string) => string;
  readonly validate: (record: unknown, id: string) => record is R;
  readonly revokeFailureMessage: string;
  readonly maxRecordsPerProfile: number;
  readonly maxProfiles: number;
  /** Legacy files retain unverified entries verbatim and verify lazily on use. */
  readonly preserveUnverified?: boolean;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Main-owned signed policy records. Failed grants are run-only; revocations must reach disk. */
export class SignedRecordFile<R extends object> {
  private readonly profiles = new Map<string, Map<string, { record: R; mac: string }>>();
  private readonly unsaved = new Set<string>();

  constructor(
    private readonly io: IntegrationConsentIo,
    private readonly key: () => Buffer | undefined,
    private readonly options: SignedRecordOptions<R>,
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(io.read() ?? "{}");
    } catch {
      return;
    }
    if (!object(parsed)) return;
    for (const [profileId, records] of Object.entries(parsed)) {
      if (this.profiles.size >= options.maxProfiles) break;
      if (!object(records)) continue;
      const kept = new Map<string, { record: R; mac: string }>();
      for (const [id, entry] of Object.entries(records)) {
        if (kept.size >= options.maxRecordsPerProfile) break;
        if (!object(entry) || typeof entry.mac !== "string" || !/^[0-9a-f]{64}$/.test(entry.mac))
          continue;
        const { mac, ...record } = entry;
        if (!options.validate(record, id)) continue;
        if (options.preserveUnverified || this.verified(profileId, record, id, mac))
          kept.set(id, { record, mac });
      }
      if (kept.size) this.profiles.set(profileId, kept);
    }
  }

  list(profileId: string): ReadonlyArray<readonly [string, R]> {
    return [...(this.profiles.get(profileId) ?? [])]
      .filter(
        ([id, entry]) =>
          this.unsaved.has(JSON.stringify([profileId, id])) ||
          this.verified(profileId, entry.record, id, entry.mac),
      )
      .map(([id, entry]) => [id, structuredClone(entry.record)]);
  }

  profilesList(): ReadonlyArray<string> {
    return [...this.profiles.keys()];
  }

  allow(profileId: string, id: string, record: R): "durable" | "session-only" {
    if (!this.options.validate(record, id)) throw new Error("Invalid consent record.");
    const entries = this.profiles.get(profileId);
    if (
      (!entries && this.profiles.size >= this.options.maxProfiles) ||
      (!entries?.has(id) && (entries?.size ?? 0) >= this.options.maxRecordsPerProfile)
    )
      throw new Error("Remembered consent limit reached.");
    const mac = this.sign(profileId, record, id);
    const entry = entries ?? new Map<string, { record: R; mac: string }>();
    entry.set(id, { record: structuredClone(record), mac: mac ?? "" });
    this.profiles.set(profileId, entry);
    const identity = JSON.stringify([profileId, id]);
    this.unsaved.add(identity);
    if (mac === undefined) return "session-only";
    this.unsaved.delete(identity);
    try {
      this.save();
      return "durable";
    } catch {
      this.unsaved.add(identity);
      return "session-only";
    }
  }

  revoke(profileId: string, id: string): void {
    const entry = this.profiles.get(profileId);
    entry?.delete(id);
    if (entry?.size === 0) this.profiles.delete(profileId);
    this.unsaved.delete(JSON.stringify([profileId, id]));
    try {
      this.save();
    } catch {
      try {
        this.io.remove();
      } catch (error) {
        throw new Error(
          this.options.revokeFailureMessage +
            " (" +
            (error instanceof Error ? error.message : String(error)) +
            ")",
          { cause: error },
        );
      }
    }
  }

  private sign(profileId: string, record: R, id: string): string | undefined {
    const key = this.key();
    return key
      ? createHmac("sha256", key)
          .update(this.options.payload(profileId, record, id))
          .digest("hex")
      : undefined;
  }

  private verified(profileId: string, record: R, id: string, mac: string): boolean {
    const expected = this.sign(profileId, record, id);
    return (
      expected !== undefined &&
      expected.length === mac.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(mac))
    );
  }

  private save(): void {
    this.io.write(
      JSON.stringify(
        Object.fromEntries(
          [...this.profiles].map(([profileId, entries]) => [
            profileId,
            Object.fromEntries(
              [...entries]
                .filter(([id]) => !this.unsaved.has(JSON.stringify([profileId, id])))
                .map(([id, { record, mac }]) => [id, { ...record, mac }]),
            ),
          ]),
        ),
      ),
    );
  }
}

/** Stable MAC input independent of object insertion order. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(normalize)
      : object(input)
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, normalize(input[key])]),
          )
        : input;
  return JSON.stringify(normalize(value));
}
