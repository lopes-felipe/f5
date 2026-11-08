import { describe, expect, it, vi } from "vitest";
import type {
  ComputerAccessRequested,
  ComputerAutomationError,
  ComputerLeaseHolder,
} from "@t3tools/contracts";
import { ComputerController } from "./ComputerController";
import { ComputerExecutionAuthority } from "./ComputerExecutionAuthority";
import type { ComputerHelper } from "./ComputerHelperClient";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
import { ComputerTakeoverCoordinator } from "./ComputerTakeoverCoordinator";

const holder: ComputerLeaseHolder = {
  profileId: "p",
  threadId: "t",
  sessionGeneration: "s",
  turnId: "turn",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [{ appId: "com.apple.TextEdit", tier: "full", allowTyping: false }],
  backend: "native",
  threadTitle: "Thread",
  scope: { kind: "takeover", appId: "com.apple.TextEdit", approvalReceipt: "approval" },
  policyRevision: 0,
};
const approval: ComputerAccessRequested = {
  requestId: "approval",
  threadId: "t",
  sessionGeneration: "s",
  reason: "Needs a drag",
  kind: "foreground-takeover",
  takeover: { appId: "com.apple.TextEdit", threadId: "t", turnId: "turn", reason: "Needs a drag" },
  apps: [],
} as unknown as ComputerAccessRequested;

function make(
  readiness: Array<{ inputSequence: number; lastUserInputAgeMs: number }>,
  cooperative = false,
) {
  let event: (message: Record<string, unknown>) => void = () => {};
  // Cooperative readiness the helper reports, natively or in heartbeats.
  const ready = {
    activityEpoch: 0,
    lastActivityAgeMs: -1,
    frontmost: false,
    monitorHealthy: true,
    inputSequence: 0,
    lastUserInputAgeMs: 60_000,
    inputHeld: false,
  };
  const helper: ComputerHelper = {
    status: () => ({ available: true, displays: [] }),
    request: vi.fn(async () => ({})),
    control: vi.fn(),
    suspend: vi.fn(async () => {}),
    onEvent: (callback) => {
      event = callback;
      return () => {};
    },
    capabilities: () =>
      cooperative ? ["background-ax-v1", "computer-cooperation-v1"] : ["background-ax-v1"],
    drain: vi.fn(async () => {}),
    readiness: vi.fn(
      async () => readiness.shift() ?? { inputSequence: 9, lastUserInputAgeMs: 5000 },
    ),
    ...(cooperative
      ? {
          watch: vi.fn(async () => ({ ...ready })),
          availability: vi.fn(async () => ({ ...ready })),
        }
      : {}),
  };
  const heartbeat = () =>
    event({
      type: "heartbeat",
      monitorHealthy: ready.monitorHealthy,
      inputSequence: ready.inputSequence,
      lastUserInputAgeMs: ready.lastUserInputAgeMs,
      inputHeld: ready.inputHeld,
    });
  const takeoverHolder = cooperative ? { ...holder, cooperative: true } : holder;
  const lease = new ComputerLeaseAuthority();
  const controller = new ComputerController(
    lease,
    helper,
    { show: vi.fn(), clear: vi.fn(), action: vi.fn(async () => {}), windowIds: () => [] },
    {
      f5Pids: () => [1],
      f5BundlePath: "F5",
      platform: "darwin",
      activity: vi.fn(),
      paused: vi.fn(),
      backgroundAvailable: () => true,
      takeoverValid: () => true,
      ...(cooperative ? { cooperationEnabled: () => true } : {}),
    },
  );
  const execution = new ComputerExecutionAuthority();
  execution.approveSession({
    profileId: "p",
    backendIncarnation: "b",
    threadId: "t",
    sessionGeneration: "s",
    policyRevision: 0,
  });
  const coordinator = new ComputerTakeoverCoordinator(controller, execution, { state: vi.fn() });
  const outcomes: Array<{ holder: ComputerLeaseHolder } | { error: ComputerAutomationError }> = [];
  coordinator.request("p", "b", "acquire", "approval", takeoverHolder, (outcome) =>
    outcomes.push(outcome),
  );
  return { coordinator, controller, helper, lease, outcomes, ready, heartbeat };
}

describe("foreground takeover coordinator", () => {
  it("reserves after earlier leases drain and emits no consent-ready event on cancellation", async () => {
    const h = make([]);
    h.coordinator.cancel("p", "acquire");
    h.outcomes.length = 0;
    const active = h.lease.acquire({ ...holder, threadId: "other", scope: { kind: "foreground" } });
    const reserved = vi.fn();
    const respond = vi.fn();
    try {
      h.coordinator.request("p", "b", "queued", "next-approval", holder, respond, {
        waitMs: 20_000,
        reserved,
      });
      await Promise.resolve();
      expect(h.coordinator.awaitingConsent("p", "next-approval")).toBe(false);
      expect(reserved).not.toHaveBeenCalled();
      h.lease.release(active);
      await vi.waitFor(() => expect(reserved).toHaveBeenCalledTimes(1));
      expect(h.coordinator.awaitingConsent("p", "next-approval")).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      h.coordinator.cancel("p", "queued");
      const blocking = h.lease.acquire({
        ...holder,
        threadId: "other",
        scope: { kind: "foreground" },
      });
      h.coordinator.request("p", "b", "cancelled", "unused", holder, respond, {
        waitMs: 20_000,
        reserved,
      });
      h.coordinator.cancel("p", "cancelled");
      h.lease.release(blocking);
      await Promise.resolve();
      await Promise.resolve();
      expect(reserved).toHaveBeenCalledTimes(1);
      expect(h.lease.pendingTakeover()).toBeNull();
    } finally {
      h.coordinator.close();
      h.controller.close();
    }
  });
  it("never mints a receipt when the answered dialog names another app or turn", () => {
    for (const mismatch of [
      { takeover: { ...approval.takeover!, appId: "com.apple.Terminal" } },
      { takeover: { ...approval.takeover!, turnId: "other-turn" } },
      { threadId: "other-thread" },
      { sessionGeneration: "other-session" },
    ]) {
      const h = make([]);
      try {
        h.coordinator.answered("p", { ...approval, ...mismatch } as ComputerAccessRequested, true);
        expect(h.outcomes).toEqual([{ error: { _tag: "NotGranted", needed: "click" } }]);
        expect(h.lease.pendingTakeover()).toBeNull();
      } finally {
        h.coordinator.close();
        h.controller.close();
      }
    }
  });
  it("arms only after the helper itself reports idle input and binds resume to that sequence", async () => {
    vi.useFakeTimers();
    // The heartbeat-derived idle time says idle, but the helper saw input 200 ms ago.
    const h = make([
      { inputSequence: 4, lastUserInputAgeMs: 200 },
      { inputSequence: 5, lastUserInputAgeMs: 2000 },
    ]);
    try {
      h.coordinator.answered("p", approval, true);
      await vi.advanceTimersByTimeAsync(150);
      expect(h.helper.readiness).toHaveBeenCalledTimes(1);
      expect(h.outcomes).toEqual([]);
      // The helper's report restarts the 1.5 s idle window.
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.helper.readiness).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(h.outcomes).toHaveLength(1);
      const armed = (h.outcomes[0] as { holder: ComputerLeaseHolder }).holder;
      expect(armed.scope.kind).toBe("takeover");
      expect(h.helper.control).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "resume",
          executionGeneration: armed.executionGeneration,
          inputSequence: 5,
        }),
      );
    } finally {
      h.coordinator.close();
      h.controller.close();
      vi.useRealTimers();
    }
  });
  it("times out with input-held while a key reads as held with no physical input", async () => {
    vi.useFakeTimers();
    const h = make([], true);
    try {
      h.ready.inputHeld = true;
      h.heartbeat();
      h.coordinator.answered("p", approval, true);
      await vi.advanceTimersByTimeAsync(30_200);
      expect(h.outcomes).toEqual([
        { error: { _tag: "TargetBlocked", kind: "user-active", detail: "input-held" } },
      ]);
      // The cached sample blocks arming without a native readiness round trip.
      expect(h.helper.availability).not.toHaveBeenCalled();
      expect(h.lease.pendingTakeover()).toBeNull();
    } finally {
      h.coordinator.close();
      h.controller.close();
      vi.useRealTimers();
    }
  });
  it("arms on the next poll once held input clears, without returning to the idle wait", async () => {
    vi.useFakeTimers();
    const h = make([], true);
    try {
      h.ready.inputHeld = true;
      h.heartbeat();
      h.coordinator.answered("p", approval, true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.outcomes).toEqual([]);
      h.ready.inputHeld = false;
      h.heartbeat();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.outcomes).toHaveLength(1);
      expect((h.outcomes[0] as { holder: ComputerLeaseHolder }).holder.scope.kind).toBe("takeover");
      // One native re-check while arming: the arm agreed with the wait and did not bounce.
      expect(h.helper.availability).toHaveBeenCalledTimes(1);
    } finally {
      h.coordinator.close();
      h.controller.close();
      vi.useRealTimers();
    }
  });
  it("times out with recent-input while the user keeps using the computer", async () => {
    vi.useFakeTimers();
    const h = make([], true);
    try {
      h.ready.lastUserInputAgeMs = 0;
      h.heartbeat();
      const typing = setInterval(() => h.heartbeat(), 250);
      h.coordinator.answered("p", approval, true);
      await vi.advanceTimersByTimeAsync(30_200);
      clearInterval(typing);
      expect(h.outcomes).toEqual([
        { error: { _tag: "TargetBlocked", kind: "user-active", detail: "recent-input" } },
      ]);
    } finally {
      h.coordinator.close();
      h.controller.close();
      vi.useRealTimers();
    }
  });
});
