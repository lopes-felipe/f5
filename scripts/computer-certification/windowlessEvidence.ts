import { record } from "./model";
const observationOps = new Set([
  "status",
  "listApps",
  "resolveApps",
  "inspect",
  "screenshot",
  "leaseAcquire",
]);

/** Content-free receipts shared by the development driver and suite admission.
 * Session stop after a completed turn is not an in-flight interruption measurement. */
export function windowlessChecks(raw: unknown): Record<string, boolean> {
  const data = record(raw) ? raw : {};
  const native = record(data.nativeObservation) ? data.nativeObservation : {};
  const fixture = record(data.fixtureObservation) ? data.fixtureObservation : {};
  const consent = record(data.consentObservation) ? data.consentObservation : {};
  const windows = record(data.windowlessObservation) ? data.windowlessObservation : {};
  const stop = record(data.windowlessStopObservation) ? data.windowlessStopObservation : {};
  const operations = Array.isArray(native.operations) ? native.operations : [];
  const inputs = operations.filter((op) => record(op) && !observationOps.has(String(op.op)));
  const count = (op: string, action?: string) =>
    inputs.filter(
      (entry) =>
        record(entry) && entry.op === op && (action === undefined || entry.action === action),
    ).length;
  const responses = record(native.responses) ? native.responses : {};
  return {
    genuineConsent: ["requested", "trustedClick", "settled", "allowed", "fixtureGranted"].every(
      (key) => consent[key] === true,
    ),
    "native-receipt":
      fixture.presses === 1 &&
      fixture.expectedSyntheticTextReceived === true &&
      ["nativeCaptureSucceeded", "nativeInspectionSucceeded", "nativeInputSucceeded"].every(
        (key) => responses[key] === true,
      ) &&
      native.pendingResponses === 0 &&
      native.traceComplete === true &&
      operations.length <= 128 &&
      operations.every((op) => record(op) && op.outcome === "ok") &&
      operations.some(
        (op) =>
          record(op) &&
          op.op === "activateApp" &&
          op.actionCompleted === true &&
          op.actionCaptureSucceeded === true &&
          op.screenshotError === undefined,
      ) &&
      inputs.length === 4 &&
      count("activateApp") === 1 &&
      count("type") === 1 &&
      count("elementAction", "press") === 1 &&
      count("elementAction", "focus") === 1,
    "windows-closed":
      windows.active === true &&
      windows.reopened === false &&
      windows.inputWithWindow === false &&
      windows.mutationAdmissions === 4 &&
      windows.finalWindowCount === 0,
    stop:
      data.stopScope === "session-stop-after-completed-native-actions" &&
      stop.sessionStopped === true &&
      stop.grantsCleared === true &&
      stop.leaseReleased === true,
    externalSubmissionsOnce: data.externalSubmissions === 1,
    humanFinishAcknowledged: fixture.humanFinishAcknowledged === true,
    noTaggedProviderErrors:
      data.providerTailObserved === true &&
      Array.isArray(data.providerErrorCodes) &&
      data.providerErrorCodes.length === 0,
    cleanup: record(data.cleanup) && data.cleanup.confirmed === true,
  };
}
