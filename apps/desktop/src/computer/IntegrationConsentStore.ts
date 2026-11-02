import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { INTEGRATION_DISCLOSURES } from "@t3tools/shared/providerIntegrationCertification";

/** Provider integrations whose per-session consent a profile can allow always. */
export type AlwaysAllowableIntegration = "codex-chrome" | "codex-computer";
const INTEGRATIONS: ReadonlyArray<AlwaysAllowableIntegration> = ["codex-chrome", "codex-computer"];

/** A grant covers the disclosures the user saw: changing them asks again. */
export function disclosuresDigest(integration: AlwaysAllowableIntegration): string {
  return createHash("sha256")
    .update(JSON.stringify(INTEGRATION_DISCLOSURES[integration]))
    .digest("hex");
}

export interface IntegrationConsentIo {
  readonly read: () => string | undefined;
  readonly write: (contents: string) => void;
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
  };
}

/**
 * Main-owned "always allow" for a profile's provider integration sessions. Only main's
 * native consent dialog adds a grant; the renderer and backends can only list and revoke.
 */
export class IntegrationConsentStore {
  private readonly grants = new Map<string, Map<AlwaysAllowableIntegration, string>>();

  constructor(private readonly io: IntegrationConsentIo) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(io.read() ?? "{}");
    } catch {
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [profileId, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const kept = new Map<AlwaysAllowableIntegration, string>();
      for (const integration of INTEGRATIONS) {
        const digest = (entry as Record<string, unknown>)[integration];
        if (typeof digest === "string") kept.set(integration, digest);
      }
      if (kept.size) this.grants.set(profileId, kept);
    }
  }

  allowed(profileId: string, integration: AlwaysAllowableIntegration): boolean {
    return this.grants.get(profileId)?.get(integration) === disclosuresDigest(integration);
  }

  list(profileId: string): AlwaysAllowableIntegration[] {
    return INTEGRATIONS.filter((integration) => this.allowed(profileId, integration));
  }

  allow(profileId: string, integration: AlwaysAllowableIntegration): void {
    const entry = this.grants.get(profileId) ?? new Map();
    entry.set(integration, disclosuresDigest(integration));
    this.grants.set(profileId, entry);
    this.save();
  }

  revoke(profileId: string, integration: AlwaysAllowableIntegration): void {
    const entry = this.grants.get(profileId);
    if (!entry?.delete(integration)) return;
    if (!entry.size) this.grants.delete(profileId);
    this.save();
  }

  private save(): void {
    try {
      this.io.write(
        JSON.stringify(
          Object.fromEntries(
            [...this.grants].map(([profileId, entry]) => [profileId, Object.fromEntries(entry)]),
          ),
        ),
      );
    } catch {
      // The grant still holds for this run; it asks again after a restart.
    }
  }
}

export function isAlwaysAllowableIntegration(value: unknown): value is AlwaysAllowableIntegration {
  return INTEGRATIONS.includes(value as AlwaysAllowableIntegration);
}
