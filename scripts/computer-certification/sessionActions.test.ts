import { expect, it, vi } from "vitest";
import { WS_METHODS } from "@t3tools/contracts";
import {
  runSessionActions,
  sessionActionsReceiptsComplete,
  type SessionActionsDriver,
} from "./sessionActions";

// Fakes exercise sequencing/admission only, never real provider, consent or OS evidence.
function fixture() {
  let granted = false;
  let presses = 0;
  const failures: { op: string; outcome: string }[] = [];
  const observed = {
    accessRequests: 0,
    accessAnswersForwarded: 0,
    accessAnswerSummaries: [] as {
      kind: string;
      appCount: number;
      allowed: number;
      remembered: number;
      allowSessionActions?: boolean;
    }[],
    sessionGenerationsObserved: 1,
    grantChanges: 0,
    lastGrantCount: 0,
    traceComplete: true,
    pendingResponses: 0,
    leaseObserved: false,
    held: false,
    operations: [] as Record<string, string | number | boolean>[],
  };
  const driver: SessionActionsDriver = {
    appId: "fixture",
    projectId: "project",
    threadId: "thread",
    checks: {},
    stage: vi.fn(),
    rpc: vi.fn(async (method) => {
      if (method === WS_METHODS.computerAccessList)
        return granted ? [{ appId: "fixture", tier: "full", allowTyping: false }] : [];
      if (method === WS_METHODS.computerAccessListRemembered) return [];
      throw new Error("Unexpected API");
    }),
    observer: async () => observed,
    failures: async () => failures,
    presses: () => presses,
    review: vi.fn(async (kind, allow) => {
      observed.accessRequests++;
      observed.accessAnswersForwarded++;
      observed.accessAnswerSummaries.push({
        kind,
        appCount: kind === "apps" ? 1 : 0,
        allowed: kind === "apps" && allow ? 1 : 0,
        remembered: 0,
        ...(kind === "session-actions" ? { allowSessionActions: allow } : {}),
      });
      observed.operations.push({ op: "resolveApps", outcome: "ok" });
      if (kind === "apps") granted = allow;
      else if (!allow) failures.push({ op: "activateApp", outcome: "NotGranted" });
      else {
        observed.leaseObserved = true;
        observed.operations.push(
          { op: "leaseAcquire", outcome: "ok" },
          { op: "activateApp", outcome: "ok", actionCompleted: true, actionCaptureSucceeded: true },
        );
      }
      return {
        kind,
        allowed: allow,
        appCount: kind === "apps" ? 1 : 0,
        visible: true,
        trustedReview: true,
        settled: true,
      };
    }),
    pressTurn: vi.fn(async () => {
      presses++;
      observed.operations.push(
        { op: "inspect", outcome: "ok", accessible: true, nodes: 4 },
        { op: "elementAction", action: "press", outcome: "ok" },
      );
    }),
    stopSession: vi.fn(async () => {
      granted = false;
    }),
  };
  return { driver, observed, failures };
}

it("requires separate app consent, denied session actions and genuine approval before the next-turn press", async () => {
  const { driver } = fixture();
  const result = await runSessionActions(driver);
  expect(result.deliveredPresses).toBe(1);
  expect(Object.values(driver.checks).every(Boolean)).toBe(true);
  expect(driver.review).toHaveBeenNthCalledWith(1, "apps", true);
  expect(driver.review).toHaveBeenNthCalledWith(2, "session-actions", false);
  expect(driver.review).toHaveBeenNthCalledWith(3, "session-actions", true);
  expect(driver.pressTurn).toHaveBeenCalledOnce();
  expect(driver.stopSession).toHaveBeenCalledOnce();
});

it("refuses foreign grants before requesting any review", async () => {
  const { driver } = fixture();
  vi.mocked(driver.rpc).mockResolvedValue([{ appId: "foreign", tier: "full", allowTyping: false }]);
  await expect(runSessionActions(driver)).rejects.toThrow("Unexpected session actions grant");
  expect(driver.review).not.toHaveBeenCalled();
});

it("stops at an untrusted review without retrying", async () => {
  const { driver } = fixture();
  const original = vi.mocked(driver.review).getMockImplementation()!;
  vi.mocked(driver.review).mockImplementation(async (...args) => ({
    ...(await original(...args)),
    trustedReview: false,
  }));
  await expect(runSessionActions(driver)).rejects.toThrow("receipt incomplete");
  expect(driver.review).toHaveBeenCalledOnce();
  expect(driver.pressTurn).not.toHaveBeenCalled();
});

it.each(["native-action", "lease", "missing-denial", "wrong-error"])(
  "refuses %s at the denied-action boundary",
  async (fault) => {
    const { driver, observed, failures } = fixture();
    const original = vi.mocked(driver.review).getMockImplementation()!;
    vi.mocked(driver.review).mockImplementation(async (...args) => {
      const review = await original(...args);
      if (args[0] === "session-actions" && !args[1]) {
        if (fault === "native-action")
          observed.operations.push({ op: "activateApp", outcome: "ok" });
        if (fault === "lease") observed.leaseObserved = true;
        if (fault === "missing-denial") failures.length = 0;
        if (fault === "wrong-error") failures[0]!.outcome = "OutcomeUnknown";
      }
      return review;
    });
    await expect(runSessionActions(driver)).rejects.toThrow("receipt incomplete");
    expect(driver.review).toHaveBeenCalledTimes(2);
    expect(driver.pressTurn).not.toHaveBeenCalled();
  },
);

it("never repeats an ambiguous approved action", async () => {
  const { driver } = fixture();
  const original = vi.mocked(driver.review).getMockImplementation()!;
  vi.mocked(driver.review).mockImplementation(async (...args) => {
    if (args[0] === "session-actions" && args[1]) throw new Error("OutcomeUnknown");
    return original(...args);
  });
  await expect(runSessionActions(driver)).rejects.toThrow("OutcomeUnknown");
  expect(driver.review).toHaveBeenCalledTimes(3);
  expect(driver.pressTurn).not.toHaveBeenCalled();
});

it("rejects next-turn reprompting instead of asking again", async () => {
  const { driver, observed } = fixture();
  const original = vi.mocked(driver.pressTurn).getMockImplementation()!;
  vi.mocked(driver.pressTurn).mockImplementation(async () => {
    await original();
    observed.accessRequests++;
  });
  await expect(runSessionActions(driver)).rejects.toThrow("receipt incomplete");
  expect(driver.checks.sessionActionsSurvivedTurn).toBe(false);
});

it("admits independent safe receipts and rejects stale, incomplete or broader execution", async () => {
  const { driver, observed, failures } = fixture();
  const sessionActionsObservation = await runSessionActions(driver);
  const raw = {
    runtimeMode: "approval-required",
    submittedRuntimeModes: Array(4).fill("approval-required"),
    composerSubmissions: 4,
    approvalModeVerifiedTurns: 4,
    sessionActionsObservation,
    nativeObservation: observed,
    fixtureObservation: {
      presses: 1,
      expectedSyntheticTextReceived: false,
      humanFinishAcknowledged: true,
    },
    sessionActionsFailures: failures,
    providerTailObserved: true,
    providerErrorCodes: ["NotGranted"],
  };
  expect(sessionActionsReceiptsComplete(raw)).toBe(true);
  for (const patch of [
    { runtimeMode: "full-access" },
    {
      submittedRuntimeModes: [
        "full-access",
        "approval-required",
        "approval-required",
        "approval-required",
      ],
    },
    { approvalModeVerifiedTurns: 3 },
    { composerSubmissions: 5 },
    { providerTailObserved: false },
    { providerErrorCodes: ["OutcomeUnknown"] },
    { sessionActionsFailures: [] },
    { fixtureObservation: { presses: 2, expectedSyntheticTextReceived: false } },
    {
      fixtureObservation: {
        presses: 1,
        expectedSyntheticTextReceived: false,
        humanFinishAcknowledged: false,
      },
    },
    { nativeObservation: { ...observed, held: true } },
    { nativeObservation: { ...observed, traceComplete: false } },
    { nativeObservation: { ...observed, pendingResponses: 1 } },
    { nativeObservation: { ...observed, sessionGenerationsObserved: 2 } },
    {
      nativeObservation: {
        ...observed,
        operations: [...observed.operations, { op: "type", outcome: "ok" }],
      },
    },
    { nativeObservation: { ...observed, accessAnswerSummaries: [] } },
    { sessionActionsObservation: { ...sessionActionsObservation, reviews: [] } },
  ])
    expect(sessionActionsReceiptsComplete({ ...raw, ...patch })).toBe(false);
});
