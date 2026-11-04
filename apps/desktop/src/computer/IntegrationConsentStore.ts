import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { AlwaysAllowedIntegration, ComputerAccessRequested } from "@t3tools/contracts";
import {
  INTEGRATION_DISCLOSURES,
  PROVIDER_INTEGRATION_RECORDS,
} from "@t3tools/shared/providerIntegrationCertification";
import { SignedRecordFile, type IntegrationConsentIo } from "./signedRecordFile";
export { fileConsentIo, keychainConsentKey } from "./signedRecordFile";
export type { IntegrationConsentIo, ConsentKeyCrypto } from "./signedRecordFile";

/**
 * Provider integrations whose consent a profile can allow always: Codex Chrome's
 * per-session consent and Claude in Chrome's setup consent. Each one needs its own
 * Settings row to revoke it.
 */
export type AlwaysAllowableIntegration = AlwaysAllowedIntegration;
const INTEGRATIONS: ReadonlyArray<AlwaysAllowableIntegration> = ["codex-chrome", "claude-chrome"];

/**
 * Where a terminal `claude --chrome` points the browser: the native-host wrapper under the
 * user's own `~/.claude`, for every record's wrapper path.
 */
export function claudeTerminalTargets(home: string = userInfo().homedir): ReadonlyArray<string> {
  return [
    ...new Set(
      PROVIDER_INTEGRATION_RECORDS["claude-chrome"].map((record) =>
        join(home, ".claude", ...record.identity.wrapperPath),
      ),
    ),
  ];
}

/**
 * The integration a consent request can be always allowed for; undefined for any other.
 * Claude's setup qualifies only when every registration it replaces is the user's own
 * terminal Claude: another F5 profile's, or any other, registration always asks.
 */
export function alwaysAllowableIntegration(
  request: Pick<ComputerAccessRequested, "kind" | "chromeSession" | "chromeSetup">,
  terminalTargets: ReadonlyArray<string> = claudeTerminalTargets(),
): AlwaysAllowableIntegration | undefined {
  if (request.kind === "chrome-session" && request.chromeSession?.integration === "codex-chrome")
    return "codex-chrome";
  const setup = request.chromeSetup;
  if (
    request.kind === "chrome-setup" &&
    setup?.provider === "claude" &&
    setup.previousTargets.length > 0 &&
    setup.previousTargets.every((target) => terminalTargets.includes(target))
  )
    return "claude-chrome";
  return undefined;
}

/** A grant covers the disclosures the user saw: changing them asks again. */
export function disclosuresDigest(integration: AlwaysAllowableIntegration): string {
  return createHash("sha256")
    .update(JSON.stringify(INTEGRATION_DISCLOSURES[integration]))
    .digest("hex");
}

interface Grant {
  readonly digest: string;
}

/**
 * Main-owned "always allow" for a profile's provider integration sessions. Only main's
 * native consent dialog adds a grant; the renderer can only list and revoke, and
 * backends can't reach it. Each grant is signed with `key`, so one written to the file
 * by anything else is ignored.
 */
export class IntegrationConsentStore {
  private readonly records: SignedRecordFile<Grant>;

  constructor(io: IntegrationConsentIo, key: () => Buffer | undefined) {
    this.records = new SignedRecordFile(io, key, {
      payload: (profileId, record, integration) =>
        JSON.stringify([profileId, integration, record.digest]),
      validate: (record, integration): record is Grant =>
        isAlwaysAllowableIntegration(integration) &&
        record !== null &&
        typeof record === "object" &&
        Object.keys(record).length === 1 &&
        "digest" in record &&
        typeof record.digest === "string",
      maxRecordsPerProfile: INTEGRATIONS.length,
      maxProfiles: Number.POSITIVE_INFINITY,
      revokeFailureMessage:
        "F5 couldn't save the revocation, so Codex may use Chrome without asking after F5 restarts. Try again.",
    });
  }

  allowed(profileId: string, integration: AlwaysAllowableIntegration): boolean {
    return this.records
      .list(profileId)
      .some(
        ([id, record]) => id === integration && record.digest === disclosuresDigest(integration),
      );
  }

  list(profileId: string): AlwaysAllowableIntegration[] {
    return INTEGRATIONS.filter((integration) => this.allowed(profileId, integration));
  }

  allow(profileId: string, integration: AlwaysAllowableIntegration): void {
    this.records.allow(profileId, integration, { digest: disclosuresDigest(integration) });
  }

  /**
   * Removes a grant. Unlike a grant, a revocation must reach disk: if the file can't be
   * rewritten it is deleted (every profile is asked again), and if that fails too this
   * throws so the user knows. Revoking again retries the write.
   */
  revoke(profileId: string, integration: AlwaysAllowableIntegration): void {
    this.records.revoke(profileId, integration);
  }
}

export function isAlwaysAllowableIntegration(value: unknown): value is AlwaysAllowableIntegration {
  return INTEGRATIONS.includes(value as AlwaysAllowableIntegration);
}
