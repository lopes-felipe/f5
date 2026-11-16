import { WS_METHODS } from "@t3tools/contracts";
import { record } from "./model";

export interface GrantMemoryObserver {
  readonly accessRequests: number;
  readonly accessAnswersForwarded: number;
  readonly accessAnswerSummaries: readonly {
    appCount: number;
    allowed: number;
    remembered: number;
  }[];
  readonly sessionGenerationsObserved: number;
  readonly grantChanges: number;
  readonly lastGrantCount: number;
  readonly traceComplete: boolean;
  readonly pendingResponses: number;
  readonly leaseObserved: boolean;
  readonly operations: readonly Record<string, string | number | boolean>[];
}
export interface GrantMemoryDriver {
  readonly appId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly checks: Record<string, boolean>;
  readonly stage: (name: string) => void;
  readonly rpc: (method: string, body: Record<string, unknown>) => Promise<unknown>;
  readonly observer: () => Promise<GrantMemoryObserver>;
  readonly review: (options: {
    allow: boolean;
    remember: boolean;
    repeat: number;
  }) => Promise<boolean>;
  readonly rememberedTurn: () => Promise<void>;
  readonly stopSession: () => Promise<void>;
  readonly waitFor: (condition: () => Promise<boolean>, timeout: number) => Promise<void>;
}

/** Real-driver sequence uses only ordinary provider turns and authenticated grant
 * narrowing/list APIs. Reviews remain genuine native user actions. Fakes validate
 * sequencing only and cannot qualify human consent or native-machine evidence. */
export async function runGrantMemory(driver: GrantMemoryDriver) {
  const { appId, threadId, projectId, checks } = driver;
  const expect = (key: string, passed: boolean) => {
    checks[key] = passed;
    if (!passed) throw new Error("Grant memory receipt incomplete.");
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
      throw new Error("Unexpected grant memory state.");
    return raw.length;
  };
  driver.stage("grant-memory-prerequisites");
  expect("grantMemoryInitiallyEmpty", (await grants()) === 0 && (await grants(true)) === 0);
  driver.stage("grant-memory-denial");
  expect(
    "grantMemoryTrustedDenial",
    await driver.review({ allow: false, remember: false, repeat: 2 }),
  );
  let native = await driver.observer();
  expect(
    "grantMemoryDenialSuppressedReprompt",
    native.accessRequests === 1 &&
      native.accessAnswersForwarded === 1 &&
      native.accessAnswerSummaries[0]?.appCount === 1 &&
      native.accessAnswerSummaries[0]?.allowed === 0 &&
      native.operations.filter((op) => op.op === "resolveApps" && op.outcome === "ok").length ===
        2 &&
      (await grants()) === 0 &&
      (await grants(true)) === 0,
  );
  driver.stage("grant-memory-remember");
  expect(
    "grantMemoryTrustedRemember",
    await driver.review({ allow: true, remember: true, repeat: 1 }),
  );
  native = await driver.observer();
  expect(
    "grantMemoryRemembered",
    native.accessRequests === 2 &&
      native.accessAnswersForwarded === 2 &&
      native.accessAnswerSummaries[1]?.appCount === 1 &&
      native.accessAnswerSummaries[1]?.allowed === 1 &&
      native.accessAnswerSummaries[1]?.remembered === 1 &&
      (await grants()) === 1 &&
      (await grants(true)) === 1,
  );
  driver.stage("grant-memory-revoke");
  const beforeRevoke = native.grantChanges;
  await driver.rpc(WS_METHODS.computerAccessRevoke, { threadId, appId });
  await driver.waitFor(async () => {
    const observed = await driver.observer();
    return observed.grantChanges > beforeRevoke && observed.lastGrantCount === 0;
  }, 5000);
  expect("grantMemoryRevokedSessionOnly", (await grants()) === 0 && (await grants(true)) === 1);
  driver.stage("grant-memory-first-restart");
  await driver.stopSession();
  expect("grantMemorySurvivedStop", (await grants()) === 0 && (await grants(true)) === 1);
  await driver.rememberedTurn();
  native = await driver.observer();
  expect(
    "grantMemoryRestoredWithoutPrompt",
    native.accessRequests === 2 &&
      native.accessAnswersForwarded === 2 &&
      native.sessionGenerationsObserved === 2 &&
      (await grants()) === 1 &&
      (await grants(true)) === 1,
  );
  driver.stage("grant-memory-forget");
  const beforeForget = native.grantChanges;
  await driver.rpc(WS_METHODS.computerAccessForgetRemembered, { projectId, appId });
  await driver.waitFor(async () => {
    const observed = await driver.observer();
    return observed.grantChanges > beforeForget && observed.lastGrantCount === 0;
  }, 5000);
  expect("grantMemoryForgotten", (await grants()) === 0 && (await grants(true)) === 0);
  driver.stage("grant-memory-second-restart");
  await driver.stopSession();
  expect(
    "grantMemoryTrustedFreshDenial",
    await driver.review({ allow: false, remember: false, repeat: 1 }),
  );
  native = await driver.observer();
  expect(
    "grantMemoryFreshConsentRequired",
    native.accessRequests === 3 &&
      native.accessAnswersForwarded === 3 &&
      native.accessAnswerSummaries[2]?.appCount === 1 &&
      native.accessAnswerSummaries[2]?.allowed === 0 &&
      native.sessionGenerationsObserved === 3 &&
      (await grants()) === 0 &&
      (await grants(true)) === 0,
  );
  driver.stage("grant-memory-final-stop");
  await driver.stopSession();
  native = await driver.observer();
  expect(
    "grantMemoryNoNativeActions",
    native.traceComplete &&
      native.pendingResponses === 0 &&
      !native.leaseObserved &&
      native.operations.every(
        (op) =>
          ["status", "listApps", "resolveApps"].includes(String(op.op)) && op.outcome === "ok",
      ) &&
      native.operations.filter((op) => op.op === "resolveApps").length === 5,
  );
  return {
    reviews: native.accessRequests,
    sessionGenerations: native.sessionGenerationsObserved,
    forwardedAnswers: native.accessAnswersForwarded,
    grantChanges: native.grantChanges,
  };
}

/** Receipt admission is separate from the driver's assertion flags. */
export function grantMemoryReceiptsComplete(raw: unknown): boolean {
  if (
    !record(raw) ||
    !record(raw.grantMemoryObservation) ||
    !record(raw.nativeObservation) ||
    !Array.isArray(raw.grantMemoryConsentReceipts) ||
    raw.grantMemoryConsentReceipts.length !== 3
  )
    return false;
  const summary = raw.grantMemoryObservation;
  const native = raw.nativeObservation;
  const reviews = raw.grantMemoryConsentReceipts;
  const answers = native.accessAnswerSummaries;
  const operations = native.operations;
  return (
    summary.reviews === 3 &&
    summary.forwardedAnswers === 3 &&
    summary.sessionGenerations === 3 &&
    typeof summary.grantChanges === "number" &&
    Number.isSafeInteger(summary.grantChanges) &&
    summary.grantChanges >= 3 &&
    native.accessRequests === 3 &&
    native.accessAnswersForwarded === 3 &&
    native.sessionGenerationsObserved === 3 &&
    native.traceComplete === true &&
    native.pendingResponses === 0 &&
    native.leaseObserved === false &&
    Array.isArray(operations) &&
    operations.length <= 128 &&
    operations.every(
      (op) =>
        record(op) &&
        ["status", "listApps", "resolveApps"].includes(String(op.op)) &&
        op.outcome === "ok",
    ) &&
    operations.filter((op) => record(op) && op.op === "resolveApps").length === 5 &&
    Array.isArray(answers) &&
    answers.length === 3 &&
    answers.every(
      (answer, index) =>
        record(answer) &&
        answer.appCount === 1 &&
        answer.allowed === (index === 1 ? 1 : 0) &&
        answer.remembered === (index === 1 ? 1 : 0),
    ) &&
    reviews.every(
      (review, index) =>
        record(review) &&
        review.visible === true &&
        review.trustedReview === true &&
        review.settled === true &&
        review.appCount === 1 &&
        review.allowed === (index === 1) &&
        review.rememberRequested === (index === 1),
    ) &&
    raw.providerTailObserved === true &&
    Array.isArray(raw.providerErrorCodes) &&
    raw.providerErrorCodes.length === 0
  );
}
