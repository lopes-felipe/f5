import { record } from "./model";
import { PROFILE_OBSERVATION_REQUEST_LIMIT } from "@t3tools/shared/computerRehearsalProfiles";

/** Diagnostic only: plan-mode observation is not contention or veto evidence. */
export function profileInspectionDiagnosticChecks(raw: unknown): Record<string, boolean> {
  const data = record(raw) ? raw : {};
  const receipt = record(data.profileIsolationObservation) ? data.profileIsolationObservation : {};
  const channels = record(receipt.channels) ? receipt.channels : {};
  const profiles = Array.isArray(channels.profiles) ? channels.profiles : [];
  const base = profileIsolationChecks(raw);
  const both = (check: (p: Record<string, unknown>, n: Record<string, unknown>) => boolean) =>
    channels.configured === true &&
    channels.traceComplete === true &&
    profiles.length === 2 &&
    profiles.every(
      (p) =>
        record(p) &&
        record(p.native) &&
        p.native.traceComplete === true &&
        p.native.pendingResponses === 0 &&
        check(p, p.native),
    );
  return {
    "two-real-profiles":
      base["two-real-profiles"] === true && receipt.profileSnapshotsPrivate === true,
    "genuine-consents": base["genuine-consents"] === true,
    "plan-observations":
      receipt.inspectionDiagnostic === true &&
      receipt.planModeVerified === true &&
      both(
        (_p, n) =>
          n.inspectionResponses === 20 &&
          Array.isArray(n.operations) &&
          n.operations.filter(
            (op) =>
              record(op) &&
              op.op === "inspect" &&
              op.outcome === "ok" &&
              op.accessible === true &&
              typeof op.nodes === "number" &&
              op.nodes > 0,
          ).length === 20,
      ),
    "no-native-input": both(
      (p, n) =>
        p.held === false &&
        n.leaseObserved === false &&
        n.captureResponses === 0 &&
        p.ownActivities === 0 &&
        p.ownWsActivities === 0 &&
        p.ownImages === 0 &&
        p.ownWsImages === 0 &&
        [
          "foreignActivity",
          "foreignImages",
          "foreignGrants",
          "foreignIdentity",
          "invalidBanner",
        ].every((k) => p[k] === false) &&
        Array.isArray(n.operations) &&
        n.operations.every(
          (op) =>
            record(op) &&
            typeof op.op === "string" &&
            ["resolveApps", "inspect"].includes(op.op) &&
            op.outcome === "ok",
        ),
    ),
    "credential-files-unchanged":
      receipt.sourceCredentialsUnchanged === true && receipt.isolatedCredentialsUnchanged === true,
    "sessions-stopped":
      receipt.bothSessionsStopped === true && both((_p, n) => n.lastGrantCount === 0),
    cleanup: record(data.cleanup) && data.cleanup.confirmed === true,
  };
}

export function profileReadinessChecks(raw: unknown): Record<string, boolean> {
  const data = record(raw) ? raw : {};
  const receipt = record(data.profileIsolationObservation) ? data.profileIsolationObservation : {};
  const channels = record(receipt.channels) ? receipt.channels : {};
  const profiles = Array.isArray(channels.profiles) ? channels.profiles : [];
  return {
    "two-real-profiles":
      receipt.bothChatSurfacesReady === true &&
      receipt.ownerPollingReadOnlyChecked === true &&
      receipt.readinessOnly === true &&
      receipt.distinctRendererProfiles === true &&
      receipt.distinctBackendProcesses === true &&
      receipt.isolatedProviderHomes === true &&
      receipt.profileSnapshotsPrivate === true,
    "no-grant-lease-or-input":
      channels.configured === true &&
      channels.traceComplete === true &&
      profiles.length === 2 &&
      profiles.every(
        (p) =>
          record(p) &&
          p.held === false &&
          p.ownActivities === 0 &&
          p.ownImages === 0 &&
          record(p.native) &&
          p.native.traceComplete === true &&
          p.native.pendingResponses === 0 &&
          p.native.accessRequests === 0 &&
          p.native.accessAnswersForwarded === 0 &&
          p.native.leaseObserved === false &&
          Array.isArray(p.native.operations) &&
          p.native.operations.length === 1 &&
          p.native.operations.every(
            (op) =>
              record(op) && op.op === "listApps" && op.outcome === "ok" && op.validApps === true,
          ),
      ),
    "credential-files-unchanged":
      receipt.sourceCredentialsUnchanged === true && receipt.isolatedCredentialsUnchanged === true,
    "sessions-stopped": receipt.bothSessionsStopped === true,
    cleanup: record(data.cleanup) && data.cleanup.confirmed === true,
  };
}

/** Real receipts must include both positive owner evidence and negative foreign
 * evidence. An idle second profile cannot establish thumbnail isolation. */
export function profileIsolationChecks(raw: unknown): Record<string, boolean> {
  const data = record(raw) ? raw : {};
  const receipt = record(data.profileIsolationObservation) ? data.profileIsolationObservation : {};
  const observation = record(receipt.channels) ? receipt.channels : {};
  const profiles = Array.isArray(observation.profiles) ? observation.profiles : [];
  const valid =
    observation.configured === true &&
    observation.traceComplete === true &&
    profiles.length === 2 &&
    profiles.every(record);
  const both = (test: (p: Record<string, unknown>) => boolean) =>
    valid && profiles.every((p) => record(p) && test(p));
  const native = (p: Record<string, unknown>) => (record(p.native) ? p.native : {});
  const noForeign = (p: Record<string, unknown>) =>
    ["foreignActivity", "foreignImages", "foreignGrants", "foreignIdentity", "invalidBanner"].every(
      (k) => p[k] === false,
    );
  const ops = (p: Record<string, unknown>) =>
    Array.isArray(native(p).operations) ? (native(p).operations as unknown[]) : [];
  const before = record(receipt.beforeNonHolderStop) ? receipt.beforeNonHolderStop : {};
  const after = record(receipt.afterNonHolderStop) ? receipt.afterNonHolderStop : {};
  const secondHeld = (v: Record<string, unknown>) =>
    v.traceComplete === true &&
    Array.isArray(v.profiles) &&
    v.profiles.length === 2 &&
    record(v.profiles[0]) &&
    record(v.profiles[1]) &&
    v.profiles[0].held === false &&
    v.profiles[1].held === true;
  return {
    "two-real-profiles":
      receipt.bothChatSurfacesReady === true &&
      receipt.distinctRendererProfiles === true &&
      receipt.distinctBackendProcesses === true &&
      receipt.isolatedProviderHomes === true,
    "genuine-consents":
      Array.isArray(receipt.consents) &&
      receipt.consents.length === 2 &&
      receipt.consents.every(
        (c) =>
          record(c) &&
          c.trustedReview === true &&
          c.visible === true &&
          c.allowed === true &&
          c.settled === true &&
          c.remembered === false,
      ),
    "lease-contention": both((p) => p.busy === 1 && p.busyWhileForeignHeld === true),
    "exact-release":
      secondHeld(before) && secondHeld(after) && receipt.nonHolderSessionStopped === true,
    "anonymous-banner": both(
      (p) =>
        Number(p.anonymousBanners) > 0 && Number(p.ownBanners) > 0 && p.invalidBanner === false,
    ),
    "no-foreign-activity": both(
      (p) =>
        Number(p.ownActivities) > 0 &&
        Number(p.ownWsActivities) > 0 &&
        p.foreignActivity === false &&
        p.foreignIdentity === false,
    ),
    "no-foreign-images": both(
      (p) => Number(p.ownImages) > 0 && Number(p.ownWsImages) > 0 && p.foreignImages === false,
    ),
    "no-foreign-grants": both((p) => Number(p.grants) > 0 && p.foreignGrants === false),
    "credential-files-unchanged":
      receipt.sourceCredentialsUnchanged === true &&
      receipt.isolatedCredentialsUnchanged === true &&
      receipt.profileSnapshotsPrivate === true,
    "device-lock": receipt.secondHelperReason === "other-instance",
    "native-actions":
      receipt.fixturesUntouched === true &&
      both(
        (p) =>
          native(p).traceComplete === true &&
          native(p).pendingResponses === 0 &&
          ops(p).length > 0 &&
          ops(p).length <= PROFILE_OBSERVATION_REQUEST_LIMIT &&
          ops(p).every(
            (op) =>
              record(op) &&
              ["resolveApps", "inspect", "leaseAcquire", "activateApp"].includes(String(op.op)) &&
              (op.outcome === "ok" || (op.op === "leaseAcquire" && op.outcome === "Busy")),
          ) &&
          ops(p).filter((op) => record(op) && op.op === "activateApp").length === 1 &&
          ops(p).some(
            (op) =>
              record(op) &&
              op.op === "activateApp" &&
              op.actionCompleted === true &&
              op.actionCaptureSucceeded === true,
          ) &&
          noForeign(p),
      ),
    "stop-and-grants":
      both((p) => p.held === false && native(p).lastGrantCount === 0) &&
      receipt.bothSessionsStopped === true,
    "human-finish": receipt.humanFinishAcknowledged === true,
    cleanup: record(data.cleanup) && data.cleanup.confirmed === true,
  };
}
