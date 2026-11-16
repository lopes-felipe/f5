import { WS_METHODS } from "@t3tools/contracts";
import { record } from "./model";
import type { GrantMemoryObserver } from "./grantMemory";

export interface SessionActionsObserver extends GrantMemoryObserver {
  readonly accessAnswerSummaries: readonly {
    kind?: string;
    appCount: number;
    allowed: number;
    remembered: number;
    allowSessionActions?: boolean;
  }[];
}
export interface SessionActionsReview {
  readonly kind: "apps" | "session-actions";
  readonly allowed: boolean;
  readonly appCount: number;
  readonly visible: boolean;
  readonly trustedReview: boolean;
  readonly settled: boolean;
}
export interface SessionActionsDriver {
  readonly appId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly checks: Record<string, boolean>;
  readonly stage: (name: string) => void;
  readonly rpc: (method: string, body: Record<string, unknown>) => Promise<unknown>;
  readonly observer: () => Promise<SessionActionsObserver>;
  readonly review: (
    kind: SessionActionsReview["kind"],
    allow: boolean,
  ) => Promise<SessionActionsReview>;
  readonly pressTurn: () => Promise<void>;
  readonly presses: () => number;
  readonly failures: () => Promise<readonly { op: string; outcome: string }[]>;
  readonly stopSession: () => Promise<void>;
}

/** Only ordinary provider turns, genuine native reviews and listing/stop APIs.
 * Sequencing fakes cannot qualify consent or real OS delivery. */
export async function runSessionActions(driver: SessionActionsDriver) {
  const { checks, threadId, projectId, appId } = driver;
  const expect = (key: string, passed: boolean) => {
    checks[key] = passed;
    if (!passed) throw new Error("Session actions receipt incomplete.");
  };
  const grants = async (remembered = false) => {
    const raw = await driver.rpc(
      remembered ? WS_METHODS.computerAccessListRemembered : WS_METHODS.computerAccessList,
      remembered ? { projectId } : { threadId },
    );
    if (
      !Array.isArray(raw) ||
      raw.length > 1 ||
      !raw.every(
        (grant) =>
          record(grant) &&
          grant.appId === appId &&
          grant.tier === "full" &&
          grant.allowTyping === false &&
          (!remembered || grant.projectId === projectId),
      )
    )
      throw new Error("Unexpected session actions grant state.");
    return raw.length;
  };
  const reviews: SessionActionsReview[] = [];
  const review = async (kind: SessionActionsReview["kind"], allow: boolean) => {
    const receipt = await driver.review(kind, allow);
    reviews.push(receipt);
    return (
      receipt.kind === kind &&
      receipt.allowed === allow &&
      receipt.visible &&
      receipt.trustedReview &&
      receipt.settled &&
      receipt.appCount === (kind === "apps" ? 1 : 0)
    );
  };
  const noMutations = (native: SessionActionsObserver) =>
    native.traceComplete &&
    native.pendingResponses === 0 &&
    !native.leaseObserved &&
    native.operations.every(
      (op) => ["status", "listApps", "resolveApps"].includes(String(op.op)) && op.outcome === "ok",
    );
  driver.stage("session-actions-prerequisites");
  expect(
    "sessionActionsInitiallyEmpty",
    (await grants()) === 0 && (await grants(true)) === 0 && driver.presses() === 0,
  );
  driver.stage("session-actions-app-consent");
  expect("sessionActionsTrustedAppConsent", await review("apps", true));
  let native = await driver.observer();
  expect(
    "sessionActionsAppConsentNoInput",
    noMutations(native) && (await grants()) === 1 && (await grants(true)) === 0,
  );
  driver.stage("session-actions-denial");
  expect("sessionActionsTrustedDenial", await review("session-actions", false));
  native = await driver.observer();
  const failures = await driver.failures();
  expect(
    "sessionActionsDeniedWithoutInput",
    noMutations(native) &&
      driver.presses() === 0 &&
      native.accessRequests === 2 &&
      native.accessAnswersForwarded === 2 &&
      failures.length === 1 &&
      failures[0]?.op === "activateApp" &&
      failures[0]?.outcome === "NotGranted",
  );
  driver.stage("session-actions-approval");
  expect("sessionActionsTrustedApproval", await review("session-actions", true));
  native = await driver.observer();
  expect(
    "sessionActionsApprovedActivation",
    native.operations.filter((op) => op.op === "activateApp").length === 1 &&
      native.operations.some(
        (op) =>
          op.op === "activateApp" &&
          op.outcome === "ok" &&
          op.actionCompleted === true &&
          op.actionCaptureSucceeded === true,
      ) &&
      driver.presses() === 0,
  );
  driver.stage("session-actions-next-turn");
  await driver.pressTurn();
  native = await driver.observer();
  expect(
    "sessionActionsSurvivedTurn",
    native.accessRequests === 3 &&
      native.accessAnswersForwarded === 3 &&
      native.sessionGenerationsObserved === 1 &&
      driver.presses() === 1 &&
      native.operations.filter((op) => op.op === "elementAction").length === 1 &&
      native.operations.some(
        (op) => op.op === "elementAction" && op.action === "press" && op.outcome === "ok",
      ) &&
      native.operations.some(
        (op) =>
          op.op === "inspect" &&
          op.outcome === "ok" &&
          op.accessible === true &&
          Number(op.nodes) > 0,
      ),
  );
  driver.stage("session-actions-final-stop");
  await driver.stopSession();
  native = await driver.observer();
  expect("sessionActionsGrantsCleared", (await grants()) === 0 && (await grants(true)) === 0);
  expect(
    "sessionActionsCompleteNativeTrace",
    native.traceComplete &&
      native.pendingResponses === 0 &&
      native.operations.every(
        (op) =>
          [
            "status",
            "listApps",
            "resolveApps",
            "leaseAcquire",
            "activateApp",
            "inspect",
            "elementAction",
          ].includes(String(op.op)) && op.outcome === "ok",
      ),
  );
  return { reviews, expectedDeniedActions: 1, deliveredPresses: driver.presses() };
}

/** Admission rechecks independent content-free outcomes rather than flags alone. */
export function sessionActionsReceiptsComplete(raw: unknown): boolean {
  if (
    !record(raw) ||
    !record(raw.sessionActionsObservation) ||
    !record(raw.nativeObservation) ||
    !record(raw.fixtureObservation)
  )
    return false;
  const summary = raw.sessionActionsObservation;
  const native = raw.nativeObservation;
  const reviews = summary.reviews;
  const answers = native.accessAnswerSummaries;
  const operations = native.operations;
  return (
    raw.runtimeMode === "approval-required" &&
    raw.composerSubmissions === 4 &&
    raw.approvalModeVerifiedTurns === 4 &&
    Array.isArray(raw.submittedRuntimeModes) &&
    raw.submittedRuntimeModes.length === 4 &&
    raw.submittedRuntimeModes.every((mode) => mode === "approval-required") &&
    summary.expectedDeniedActions === 1 &&
    summary.deliveredPresses === 1 &&
    raw.fixtureObservation.presses === 1 &&
    raw.fixtureObservation.expectedSyntheticTextReceived === false &&
    raw.fixtureObservation.humanFinishAcknowledged === true &&
    native.traceComplete === true &&
    native.pendingResponses === 0 &&
    native.held === false &&
    native.leaseObserved === true &&
    native.sessionGenerationsObserved === 1 &&
    native.accessRequests === 3 &&
    native.accessAnswersForwarded === 3 &&
    Array.isArray(reviews) &&
    reviews.length === 3 &&
    reviews.every(
      (review, index) =>
        record(review) &&
        review.kind === (index === 0 ? "apps" : "session-actions") &&
        review.appCount === (index === 0 ? 1 : 0) &&
        review.allowed === (index !== 1) &&
        review.visible === true &&
        review.trustedReview === true &&
        review.settled === true,
    ) &&
    Array.isArray(answers) &&
    answers.length === 3 &&
    answers.every(
      (answer, index) =>
        record(answer) &&
        answer.kind === (index === 0 ? "apps" : "session-actions") &&
        answer.appCount === (index === 0 ? 1 : 0) &&
        answer.allowed === (index === 0 ? 1 : 0) &&
        answer.remembered === 0 &&
        (index === 0 || answer.allowSessionActions === (index === 2)),
    ) &&
    Array.isArray(operations) &&
    operations.length <= 128 &&
    operations.every(
      (op) =>
        record(op) &&
        [
          "status",
          "listApps",
          "resolveApps",
          "leaseAcquire",
          "activateApp",
          "inspect",
          "elementAction",
        ].includes(String(op.op)) &&
        op.outcome === "ok",
    ) &&
    operations.filter((op) => record(op) && op.op === "activateApp").length === 1 &&
    operations.some(
      (op) =>
        record(op) &&
        op.op === "activateApp" &&
        op.actionCompleted === true &&
        op.actionCaptureSucceeded === true,
    ) &&
    operations.filter((op) => record(op) && op.op === "elementAction").length === 1 &&
    operations.some((op) => record(op) && op.op === "elementAction" && op.action === "press") &&
    operations.some(
      (op) => record(op) && op.op === "inspect" && op.accessible === true && Number(op.nodes) > 0,
    ) &&
    Array.isArray(raw.sessionActionsFailures) &&
    raw.sessionActionsFailures.length === 1 &&
    record(raw.sessionActionsFailures[0]) &&
    raw.sessionActionsFailures[0].op === "activateApp" &&
    raw.sessionActionsFailures[0].outcome === "NotGranted" &&
    raw.providerTailObserved === true &&
    Array.isArray(raw.providerErrorCodes) &&
    raw.providerErrorCodes.every((code) => code === "NotGranted")
  );
}
