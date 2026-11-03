import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { INTEGRATION_DISCLOSURES } from "@t3tools/shared/providerIntegrationCertification";

/**
 * Provider integrations whose per-session consent a profile can allow always. Only Codex
 * Chrome for now: each one needs its own Settings row to revoke it.
 */
export type AlwaysAllowableIntegration = "codex-chrome";
const INTEGRATIONS: ReadonlyArray<AlwaysAllowableIntegration> = ["codex-chrome"];

/** A grant covers the disclosures the user saw: changing them asks again. */
export function disclosuresDigest(integration: AlwaysAllowableIntegration): string {
  return createHash("sha256")
    .update(JSON.stringify(INTEGRATION_DISCLOSURES[integration]))
    .digest("hex");
}

export interface IntegrationConsentIo {
  readonly read: () => string | undefined;
  readonly write: (contents: string) => void;
  /** Deletes the file: the fallback when a revocation can't be written. */
  readonly remove: () => void;
}

/** Atomic JSON file; a missing or unreadable file means no grants. */
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
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, contents, { mode: 0o600 });
      renameSync(temporary, path);
    },
    remove: () => rmSync(path, { force: true }),
  };
}

/** What `safeStorage` offers, so the key can be kept where only main can read it. */
export interface ConsentKeyCrypto {
  readonly available: () => boolean;
  readonly encrypt: (plain: string) => Buffer;
  readonly decrypt: (encrypted: Buffer) => string;
}

/**
 * The key that signs grants, kept encrypted with the OS keychain (`safeStorage`). Another
 * process running as the user can read and write the grant file, but can't sign a grant
 * without the keychain releasing this key to F5. No keychain means no key, so grants are
 * kept for this run only. A key that can't be read is replaced, which drops old grants.
 */
export function keychainConsentKey(
  path: string,
  crypto: ConsentKeyCrypto,
): () => Buffer | undefined {
  let key: Buffer | undefined;
  return () => {
    if (key) return key;
    if (!crypto.available()) return undefined;
    try {
      const stored = Buffer.from(crypto.decrypt(readFileSync(path)), "hex");
      if (stored.length === 32) return (key = stored);
    } catch {
      // Missing or unreadable: make a new one below.
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

interface Grant {
  readonly digest: string;
  readonly mac: string;
}

/**
 * Main-owned "always allow" for a profile's provider integration sessions. Only main's
 * native consent dialog adds a grant; the renderer can only list and revoke, and
 * backends can't reach it. Each grant is signed with `key`, so one written to the file
 * by anything else is ignored.
 */
export class IntegrationConsentStore {
  private readonly grants = new Map<string, Map<AlwaysAllowableIntegration, Grant>>();
  /** Grants allowed this run whose write failed: they hold until restart. */
  private readonly unsaved = new Set<string>();

  constructor(
    private readonly io: IntegrationConsentIo,
    private readonly key: () => Buffer | undefined,
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(io.read() ?? "{}");
    } catch {
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [profileId, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const kept = new Map<AlwaysAllowableIntegration, Grant>();
      for (const integration of INTEGRATIONS) {
        const grant = (entry as Record<string, unknown>)[integration] as Partial<Grant> | null;
        if (typeof grant?.digest === "string" && typeof grant.mac === "string")
          kept.set(integration, { digest: grant.digest, mac: grant.mac });
      }
      if (kept.size) this.grants.set(profileId, kept);
    }
  }

  allowed(profileId: string, integration: AlwaysAllowableIntegration): boolean {
    const grant = this.grants.get(profileId)?.get(integration);
    if (!grant || grant.digest !== disclosuresDigest(integration)) return false;
    if (this.unsaved.has(`${profileId}\0${integration}`)) return true;
    const expected = this.sign(profileId, integration, grant.digest);
    return (
      expected !== undefined &&
      expected.length === grant.mac.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(grant.mac))
    );
  }

  list(profileId: string): AlwaysAllowableIntegration[] {
    return INTEGRATIONS.filter((integration) => this.allowed(profileId, integration));
  }

  allow(profileId: string, integration: AlwaysAllowableIntegration): void {
    const digest = disclosuresDigest(integration);
    const mac = this.sign(profileId, integration, digest);
    const entry = this.grants.get(profileId) ?? new Map();
    entry.set(integration, { digest, mac: mac ?? "" });
    this.grants.set(profileId, entry);
    const id = `${profileId}\0${integration}`;
    if (mac === undefined) {
      // No key: the grant holds for this run only; it asks again after a restart.
      this.unsaved.add(id);
      return;
    }
    this.unsaved.delete(id);
    try {
      this.save();
    } catch {
      this.unsaved.add(id);
    }
  }

  /**
   * Removes a grant. Unlike a grant, a revocation must reach disk: if the file can't be
   * rewritten it is deleted (every profile is asked again), and if that fails too this
   * throws so the user knows. Revoking again retries the write.
   */
  revoke(profileId: string, integration: AlwaysAllowableIntegration): void {
    const entry = this.grants.get(profileId);
    entry?.delete(integration);
    if (entry && !entry.size) this.grants.delete(profileId);
    this.unsaved.delete(`${profileId}\0${integration}`);
    try {
      this.save();
    } catch {
      try {
        this.io.remove();
      } catch (error) {
        throw new Error(
          `F5 couldn't save the revocation, so Codex may use Chrome without asking after F5 restarts. Try again. (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
    }
  }

  private sign(
    profileId: string,
    integration: AlwaysAllowableIntegration,
    digest: string,
  ): string | undefined {
    const key = this.key();
    if (!key) return undefined;
    return createHmac("sha256", key)
      .update(JSON.stringify([profileId, integration, digest]))
      .digest("hex");
  }

  private save(): void {
    this.io.write(
      JSON.stringify(
        Object.fromEntries(
          [...this.grants].map(([profileId, entry]) => [
            profileId,
            Object.fromEntries(
              [...entry].filter(
                ([integration]) => !this.unsaved.has(`${profileId}\0${integration}`),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

export function isAlwaysAllowableIntegration(value: unknown): value is AlwaysAllowableIntegration {
  return INTEGRATIONS.includes(value as AlwaysAllowableIntegration);
}
