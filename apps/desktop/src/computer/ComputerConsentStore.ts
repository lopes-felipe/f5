import { RememberedComputerConsent } from "@t3tools/contracts";
import { Exit, Schema } from "effect";
import { canonicalJson, SignedRecordFile, type IntegrationConsentIo } from "./signedRecordFile";

const DOMAIN = "f5-native-computer-consent-v1";
const decodeConsent = Schema.decodeUnknownExit(RememberedComputerConsent);

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
  const decoded = decodeConsent(value, { onExcessProperty: "error" });
  return Exit.isSuccess(decoded) && key === computerConsentKey(decoded.value);
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
