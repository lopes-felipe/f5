import { expect, it, vi } from "vitest";
import { WS_METHODS } from "@t3tools/contracts";
import { runGrantMemory, grantMemoryReceiptsComplete, type GrantMemoryDriver } from "./grantMemory";

// Sequencing fakes only; these receipts are never admitted as real human/OS proof.
function fixture() {
  let remembered = false;
  let granted = false;
  let active = false;
  const observed = {
    accessRequests: 0,
    accessAnswersForwarded: 0,
    accessAnswerSummaries: [] as { appCount: number; allowed: number; remembered: number }[],
    sessionGenerationsObserved: 0,
    grantChanges: 0,
    lastGrantCount: 0,
    traceComplete: true,
    pendingResponses: 0,
    leaseObserved: false,
    operations: [] as Record<string, string | number | boolean>[],
  };
  const begin = () => {
    if (!active) {
      active = true;
      observed.sessionGenerationsObserved++;
    }
  };
  const change = () => {
    observed.grantChanges++;
    observed.lastGrantCount = granted ? 1 : 0;
  };
  const grant = { appId: "fixture", tier: "full", allowTyping: false };
  const driver: GrantMemoryDriver = {
    appId: "fixture",
    threadId: "thread",
    projectId: "project",
    checks: {},
    stage: vi.fn(),
    rpc: vi.fn(async (method) => {
      if (method === WS_METHODS.computerAccessList) return granted ? [grant] : [];
      if (method === WS_METHODS.computerAccessListRemembered)
        return remembered ? [{ ...grant, projectId: "project" }] : [];
      if (method === WS_METHODS.computerAccessRevoke) {
        granted = false;
        change();
        return undefined;
      }
      if (method === WS_METHODS.computerAccessForgetRemembered) {
        remembered = false;
        granted = false;
        change();
        return undefined;
      }
      throw new Error("Unexpected API");
    }),
    observer: async () => observed,
    review: vi.fn(async ({ allow, remember, repeat }) => {
      begin();
      observed.accessRequests++;
      observed.accessAnswersForwarded++;
      observed.accessAnswerSummaries.push({
        appCount: 1,
        allowed: allow ? 1 : 0,
        remembered: allow && remember ? 1 : 0,
      });
      for (let i = 0; i < repeat; i++)
        observed.operations.push({ op: "resolveApps", outcome: "ok" });
      granted = allow;
      remembered ||= allow && remember;
      change();
      return true;
    }),
    rememberedTurn: vi.fn(async () => {
      begin();
      granted = remembered;
      change();
      observed.operations.push({ op: "resolveApps", outcome: "ok" });
    }),
    stopSession: vi.fn(async () => {
      active = false;
      granted = false;
      change();
    }),
    waitFor: async (condition) => {
      if (!(await condition())) throw new Error("Missing receipt");
    },
  };
  return { driver, observed };
}

it("orders genuine reviews, narrowing and two restarts without executing native input", async () => {
  const { driver } = fixture();
  expect(await runGrantMemory(driver)).toMatchObject({
    reviews: 3,
    forwardedAnswers: 3,
    sessionGenerations: 3,
  });
  expect(Object.values(driver.checks).every(Boolean)).toBe(true);
  expect(driver.review).toHaveBeenNthCalledWith(1, { allow: false, remember: false, repeat: 2 });
  expect(driver.review).toHaveBeenNthCalledWith(2, { allow: true, remember: true, repeat: 1 });
  expect(driver.review).toHaveBeenNthCalledWith(3, { allow: false, remember: false, repeat: 1 });
  expect(driver.stopSession).toHaveBeenCalledTimes(3);
  expect(
    vi
      .mocked(driver.rpc)
      .mock.calls.every(([method]) =>
        new Set<string>([
          WS_METHODS.computerAccessList,
          WS_METHODS.computerAccessListRemembered,
          WS_METHODS.computerAccessRevoke,
          WS_METHODS.computerAccessForgetRemembered,
        ]).has(method),
      ),
  ).toBe(true);
});

it("stops at an untrusted review without automatically asking again", async () => {
  const { driver } = fixture();
  vi.mocked(driver.review).mockResolvedValue(false);
  await expect(runGrantMemory(driver)).rejects.toThrow("receipt incomplete");
  expect(driver.review).toHaveBeenCalledOnce();
  expect(driver.rememberedTurn).not.toHaveBeenCalled();
  expect(driver.checks.grantMemoryTrustedDenial).toBe(false);
});

it("rejects foreign grant records before any consent prompt", async () => {
  const { driver } = fixture();
  vi.mocked(driver.rpc).mockResolvedValue([{ appId: "foreign", tier: "full", allowTyping: false }]);
  await expect(runGrantMemory(driver)).rejects.toThrow("Unexpected grant");
  expect(driver.review).not.toHaveBeenCalled();
});

it("does not replay a failed grant mutation", async () => {
  const { driver } = fixture();
  const original = vi.mocked(driver.rpc).getMockImplementation()!;
  vi.mocked(driver.rpc).mockImplementation(async (method, body) => {
    if (method === WS_METHODS.computerAccessForgetRemembered) throw new Error("OutcomeUnknown");
    return original(method, body);
  });
  await expect(runGrantMemory(driver)).rejects.toThrow("OutcomeUnknown");
  expect(
    vi
      .mocked(driver.rpc)
      .mock.calls.filter(([method]) => method === WS_METHODS.computerAccessForgetRemembered),
  ).toHaveLength(1);
  expect(driver.review).toHaveBeenCalledTimes(2);
});

it("rejects a remembered restart that unexpectedly prompts again", async () => {
  const { driver, observed } = fixture();
  const turn = vi.mocked(driver.rememberedTurn).getMockImplementation()!;
  vi.mocked(driver.rememberedTurn).mockImplementation(async () => {
    await turn();
    observed.accessRequests++;
  });
  await expect(runGrantMemory(driver)).rejects.toThrow("receipt incomplete");
  expect(driver.checks.grantMemoryRestoredWithoutPrompt).toBe(false);
});

it.each(["native-action", "pending-response", "lost-trace"])(
  "refuses %s evidence",
  async (failure) => {
    const { driver, observed } = fixture();
    if (failure === "native-action") observed.operations.push({ op: "type", outcome: "ok" });
    if (failure === "pending-response") observed.pendingResponses = 1;
    if (failure === "lost-trace") observed.traceComplete = false;
    await expect(runGrantMemory(driver)).rejects.toThrow("receipt incomplete");
    expect(driver.checks.grantMemoryNoNativeActions).toBe(false);
  },
);

it("admits complete content-free receipts and rejects flags without independent outcomes", async () => {
  const { driver, observed } = fixture();
  const grantMemoryObservation = await runGrantMemory(driver);
  const raw = {
    grantMemoryObservation,
    nativeObservation: observed,
    providerTailObserved: true,
    providerErrorCodes: [],
    grantMemoryConsentReceipts: [false, true, false].map((allowed) => ({
      appCount: 1,
      trustedReview: true,
      visible: true,
      settled: true,
      allowed,
      rememberRequested: allowed,
    })),
  };
  expect(grantMemoryReceiptsComplete(raw)).toBe(true);
  for (const patch of [
    { grantMemoryObservation: undefined },
    { nativeObservation: undefined },
    { nativeObservation: { ...observed, sessionGenerationsObserved: 2 } },
    { nativeObservation: { ...observed, pendingResponses: 1 } },
    {
      nativeObservation: {
        ...observed,
        operations: [...observed.operations, { op: "type", outcome: "ok" }],
      },
    },
    {
      nativeObservation: {
        ...observed,
        accessAnswerSummaries: [{ appCount: 1, allowed: 1, remembered: 1 }],
      },
    },
    {
      grantMemoryConsentReceipts: raw.grantMemoryConsentReceipts.map((receipt) => ({
        ...receipt,
        trustedReview: false,
      })),
    },
    { providerTailObserved: false },
    { providerErrorCodes: ["OutcomeUnknown"] },
  ])
    expect(grantMemoryReceiptsComplete({ ...raw, ...patch })).toBe(false);
});
