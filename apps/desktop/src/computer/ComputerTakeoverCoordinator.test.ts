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

function make(readiness: Array<{ inputSequence: number; lastUserInputAgeMs: number }>) {
  const helper: ComputerHelper = {
    status: () => ({ available: true, displays: [] }),
    request: vi.fn(async () => ({})),
    control: vi.fn(),
    suspend: vi.fn(async () => {}),
    onEvent: () => () => {},
    capabilities: () => ["background-ax-v1"],
    drain: vi.fn(async () => {}),
    readiness: vi.fn(
      async () => readiness.shift() ?? { inputSequence: 9, lastUserInputAgeMs: 5000 },
    ),
  };
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
  coordinator.request("p", "b", "acquire", "approval", holder, (outcome) => outcomes.push(outcome));
  return { coordinator, controller, helper, lease, outcomes };
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
});
