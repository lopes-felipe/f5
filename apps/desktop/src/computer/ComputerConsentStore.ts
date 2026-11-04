import type { RememberedComputerConsent } from "@t3tools/contracts";
import { canonicalJson, SignedRecordFile, type IntegrationConsentIo } from "./signedRecordFile";

const DOMAIN = "f5-native-computer-consent-v1";
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;

export function computerConsentKey(record: RememberedComputerConsent): string {
  switch (record.kind) {
    case "full-access-session":
      return canonicalJson([record.kind]);
    case "session-actions":
      return canonicalJson([record.kind, record.projectId]);
    default:
      return canonicalJson([record.kind, record.projectId, record.appId]);
  }
}

function validate(value: unknown, key: string): value is RememberedComputerConsent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.policyVersion !== 1) return false;
  let fields = ["version", "kind", "policyVersion"];
  switch (record.kind) {
    case "app-access":
      if (
        !id(record.projectId) ||
        !id(record.appId) ||
        (record.tier !== "view" && record.tier !== "click" && record.tier !== "full") ||
        typeof record.allowTyping !== "boolean" ||
        (record.tier !== "click" && record.allowTyping)
      )
        return false;
      fields = [...fields, "projectId", "appId", "tier", "allowTyping"];
      break;
    case "session-actions":
      if (!id(record.projectId) || typeof record.background !== "boolean") return false;
      fields = [...fields, "projectId", "background"];
      break;
    case "takeover":
      if (!id(record.projectId) || !id(record.appId)) return false;
      fields = [...fields, "projectId", "appId"];
      break;
    case "full-access-session":
      break;
    default:
      return false;
  }
  return (
    Object.keys(record).length === fields.length &&
    fields.every((field) => Object.hasOwn(record, field)) &&
    key === computerConsentKey(value as RememberedComputerConsent)
  );
}

/**
 * Native-dialog policy, never receipts. Profile isolation comes from the authenticated
 * backend connection; project scoping is cooperative against an honest backend within
 * that profile. Signatures prevent editing grants into broader policy, but cannot
 * prevent a same-user process restoring an older signed file.
 */
export class ComputerConsentStore {
  private readonly records: SignedRecordFile<RememberedComputerConsent>;

  constructor(io: IntegrationConsentIo, key: () => Buffer | undefined) {
    this.records = new SignedRecordFile(io, key, {
      payload: (profileId, record) => canonicalJson([DOMAIN, profileId, record]),
      validate,
      maxRecordsPerProfile: 2000,
      maxProfiles: 64,
      revokeFailureMessage:
        "F5 couldn't save the revocation. A restart could restore this permission. Try again.",
    });
  }

  profiles(): ReadonlyArray<string> {
    return this.records.profilesList();
  }

  list(profileId: string): ReadonlyArray<RememberedComputerConsent> {
    return this.records.list(profileId).map(([, record]) => record);
  }

  allow(profileId: string, record: RememberedComputerConsent): "durable" | "session-only" {
    return this.records.allow(profileId, computerConsentKey(record), record);
  }

  revoke(profileId: string, record: RememberedComputerConsent): void {
    this.records.revoke(profileId, computerConsentKey(record));
  }
}
