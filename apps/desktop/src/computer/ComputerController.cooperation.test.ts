import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ComputerAutomationRequest,
  ComputerLeaseHolder,
  ComputerTargetReadiness,
} from "@t3tools/contracts";
import { ComputerControlError, computerRequestPayload } from "@t3tools/shared/computerControl";
import { ComputerController } from "./ComputerController";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
import type { ComputerHelper } from "./ComputerHelperClient";

function fixture(
  scope: ComputerLeaseHolder["scope"] = { kind: "app", appId: "app" },
  cooperative = true,
) {
  let event: (message: Record<string, unknown>) => void = () => {};
  const ready: { -readonly [Key in keyof ComputerTargetReadiness]: ComputerTargetReadiness[Key] } =
    {
      activityEpoch: 0,
      lastActivityAgeMs: -1,
      frontmost: false,
      monitorHealthy: true,
      inputSequence: 0,
      lastUserInputAgeMs: -1,
      inputHeld: false,
    };
  const request = vi.fn(
    async (request: ComputerAutomationRequest): Promise<unknown> =>
      request.op === "inspect"
        ? { accessible: true, snapshotId: request.requestId, nodes: [] }
        : { ok: true },
  );
  const helper: ComputerHelper = {
    status: () => ({
      available: true,
      displays: [
        {
          displayId: "d",
          geometryGeneration: "g",
          primary: true,
          nativeBounds: { x: 0, y: 0, width: 100, height: 100 },
          modelSize: { width: 100, height: 100 },
          pixelSize: { width: 100, height: 100 },
          rotation: 0,
        },
      ],
    }),
    request,
    control: vi.fn(),
    suspend: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    capabilities: () => ["background-ax-v1", "computer-cooperation-v1"],
    watch: vi.fn(async () => ({ ...ready })),
    availability: vi.fn(async () => ({ ...ready })),
    onEvent: (callback) => {
      event = callback;
      return () => {};
    },
  };
  const paused = vi.fn();
  const state = vi.fn();
  const yielded = vi.fn();
  const overlay = {
    show: vi.fn(),
    clear: vi.fn(),
    action: vi.fn(async () => {}),
    windowIds: () => [],
    waiting: vi.fn(),
  };
  const lease = new ComputerLeaseAuthority();
  const controller = new ComputerController(lease, helper, overlay, {
    platform: "darwin",
    f5Pids: () => [],
    f5BundlePath: "F5",
    paused,
    activity: vi.fn(),
    backgroundAvailable: () => true,
    cooperationEnabled: () => true,
    executionState: state,
    targetYielded: yielded,
    takeoverValid: () => true,
  });
  const holder: ComputerLeaseHolder = {
    profileId: "p",
    threadId: "t",
    sessionGeneration: "s",
    turnId: "turn",
    executionGeneration: 1,
    grantVersion: 1,
    grants: [{ appId: "app", tier: "full", allowTyping: false }],
    backend: "native",
    threadTitle: "Thread",
    scope,
    policyRevision: 0,
    cooperative,
  };
  controller.updateGrants(holder);
  const acquire = async (input = holder) => {
    await controller.prepareAcquisition(input);
    return controller.acquire(input);
  };
  return {
    holder,
    controller,
    lease,
    helper,
    request,
    ready,
    paused,
    state,
    yielded,
    overlay,
    acquire,
    event: (message: Record<string, unknown>) => event(message),
  };
}
it("arms a new takeover after an app yield without inheriting the old yielded generation", async () => {
  const h = fixture();
  try {
    const held = await h.acquire();
    h.event({
      type: "targetInterrupted",
      cause: "frontmost",
      executionGeneration: held.executionGeneration,
    });
    await vi.waitFor(() => expect(h.lease.holders()).toEqual([]));
    const takeover = {
      ...h.holder,
      scope: { kind: "takeover" as const, appId: "app", approvalReceipt: "approval" },
    };
    const armed = h.lease.armTakeover(h.lease.reserveTakeover(takeover), "receipt");
    expect(h.controller.cooperation.yielded.size).toBe(0);
    expect(h.helper.control).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permit",
        executionGeneration: armed.executionGeneration,
      }),
    );
  } finally {
    h.controller.close();
  }
});
it("clears retained foreground waiting state when its lease is released", async () => {
  const h = fixture({ kind: "foreground" });
  try {
    const held = await h.acquire();
    h.event({
      type: "physicalInput",
      cause: "move",
      executionGeneration: held.executionGeneration,
    });
    h.lease.release(held);
    expect(h.controller.cooperation.yielded.size).toBe(0);
    expect(h.state).toHaveBeenLastCalledWith("p", expect.objectContaining({ state: null }));
  } finally {
    h.controller.close();
  }
});
it("does not shorten native activity dwell when the wall clock jumps forward", async () => {
  const h = fixture();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const held = await h.acquire();
    h.ready.lastActivityAgeMs = 0;
    await h.controller.prepareAcquisition(held);
    const wall = Date.now();
    clock = vi.spyOn(Date, "now").mockReturnValue(wall + 60_000);
    expect(() => h.controller.acquire(h.holder)).toThrow(
      expect.objectContaining({ error: { _tag: "TargetBlocked", kind: "user-active" } }),
    );
  } finally {
    clock?.mockRestore();
    h.controller.close();
  }
});
it.each([
  ["native", true],
  ["native", false],
  ["codex-builtin", false],
  ["claude-builtin", false],
] as const)(
  "idle sweep respects holder lifecycle: backend=%s yielded=%s",
  async (backend, yielded) => {
    vi.useFakeTimers();
    const h = fixture({ kind: "foreground" });
    try {
      const held =
        backend === "native" ? await h.acquire() : h.lease.acquire({ ...h.holder, backend });
      if (yielded) {
        h.event({
          type: "physicalInput",
          cause: "pointer",
          executionGeneration: held.executionGeneration,
        });
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(10_001);
      const queued = { ...h.holder, threadId: "waiting" };
      h.controller.updateGrants(queued);
      const pending = h.controller.admitWhenFree({
        kind: "lease",
        holder: queued,
        profileId: "p",
        requestId: "idle-sweep",
        waitMs: 20_000,
        admit: () => h.lease.acquire(queued),
      });
      const outcome = pending.then(
        () => "admitted",
        () => "blocked",
      );
      await vi.advanceTimersByTimeAsync(250);
      if (yielded || backend !== "native") {
        expect(h.lease.holders()).toEqual([held]);
        expect(h.controller.cooperation.yielded.size).toBe(yielded ? 1 : 0);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await outcome).toBe("blocked");
        await vi.advanceTimersByTimeAsync(30_000);
        if (backend === "native") expect(h.lease.holders()).toEqual([]);
        else {
          expect(h.lease.holders()).toEqual([held]);
          h.lease.release(held);
          expect(h.lease.acquire(queued).threadId).toBe("waiting");
        }
        expect(h.paused).not.toHaveBeenCalled();
      } else {
        expect(await outcome).toBe("admitted");
        expect(h.lease.holders()[0]?.threadId).toBe("waiting");
      }
    } finally {
      h.controller.close();
      vi.useRealTimers();
    }
  },
);
it("pauses a queued thread without suspending the current holder's placeholder generation", async () => {
  const h = fixture();
  try {
    const active = await h.acquire();
    const queued = { ...h.holder, threadId: "waiting", executionGeneration: 1 };
    h.controller.updateGrants(queued);
    await h.controller.prepareAcquisition(queued);
    const pending = h.controller.admitWhenFree({
      kind: "lease",
      holder: queued,
      profileId: "p",
      requestId: "queued",
      waitMs: 20_000,
      admit: () => h.controller.acquire(queued),
    });
    const rejected = expect(pending).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
    h.controller.setPaused("p", queued.threadId, true);
    await rejected;
    expect(h.controller.isPaused("p", queued.threadId)).toBe(true);
    expect(h.controller.isPaused("p", active.threadId)).toBe(false);
    expect(h.lease.holders()).toEqual([active]);
    expect(h.helper.suspend).not.toHaveBeenCalledWith(active.executionGeneration);
  } finally {
    h.controller.close();
  }
});
function action(
  holder: ComputerLeaseHolder,
  op: "type" | "inspect" | "screenshot" | "click" = "type",
): ComputerAutomationRequest {
  const payload = {
    requestId: crypto.randomUUID(),
    authorization: holder,
    deadlineAtMs: Date.now() + 10_000,
    agent: { provider: "claude" as const, threadTitle: "Thread" },
    op,
    ...(holder.scope.kind === "app"
      ? { delivery: "background" as const, appId: holder.scope.appId }
      : {}),
    ...(op === "type" ? { text: "hello" } : {}),
    ...(op === "inspect" ? { appId: "app" } : {}),
    ...(op === "click"
      ? { x: 1, y: 1, displayId: "d", geometryGeneration: "g", button: "left" }
      : {}),
  };
  return {
    ...payload,
    payloadHash: createHash("sha256")
      .update(computerRequestPayload(payload as Omit<ComputerAutomationRequest, "payloadHash">))
      .digest("hex"),
  } as ComputerAutomationRequest;
}
describe("cooperative computer control", () => {
  it.each(["pointer", "key", "scroll", "drag", "frontmost"])(
    "yields a background target on %s and requires a fresh observation",
    async (cause) => {
      const h = fixture();
      try {
        const held = await h.acquire();
        h.event({
          type: "targetInterrupted",
          cause,
          executionGeneration: held.executionGeneration,
        });
        await vi.waitFor(() => expect(h.lease.holders()).toEqual([]));
        expect(h.paused).not.toHaveBeenCalled();
        expect(h.state).toHaveBeenCalledWith(
          "p",
          expect.objectContaining({ state: "waiting-user" }),
        );
        h.ready.activityEpoch++;
        h.ready.lastActivityAgeMs = 2000;
        const next = await h.acquire();
        await expect(h.controller.invoke(action(next))).rejects.toMatchObject({
          error: { _tag: "TargetBlocked", kind: "user-active" },
        });
        await h.controller.invoke(action(next, "inspect"));
        await expect(h.controller.invoke(action(next))).resolves.toEqual({ ok: true });
      } finally {
        h.controller.close();
      }
    },
  );
  it.each([
    "monitor",
    "input-overflow",
    "unresolved",
    "readiness",
    "activation",
    "permit-expired",
    undefined,
  ])("latches background input with cause %s", async (cause) => {
    const h = fixture();
    try {
      const held = await h.acquire();
      h.event({ type: "targetInterrupted", cause, executionGeneration: held.executionGeneration });
      expect(h.controller.isPaused("p", "t")).toBe(true);
      expect(h.paused).toHaveBeenCalled();
    } finally {
      h.controller.close();
    }
  });
  it("keeps cooperative foreground ownership, blocks held input, and needs a screenshot for coordinates", async () => {
    const h = fixture({ kind: "foreground" });
    try {
      const held = await h.acquire();
      h.event({
        type: "physicalInput",
        cause: "move",
        executionGeneration: held.executionGeneration,
      });
      // Idle telemetry while the native generation is suspended must not latch a pause.
      h.event({ type: "physicalInput", idle: true });
      expect(h.controller.isPaused("p", "t")).toBe(false);
      expect(h.lease.holders()).toHaveLength(1);
      h.ready.inputSequence++;
      h.ready.lastUserInputAgeMs = 4000;
      h.ready.inputHeld = true;
      await expect(h.acquire(held)).rejects.toMatchObject({ error: { kind: "user-active" } });
      h.ready.inputHeld = false;
      const next = await h.acquire(held);
      expect(next.executionGeneration).not.toBe(held.executionGeneration);
      await h.controller.invoke(action(next, "inspect"));
      await expect(h.controller.invoke(action(next, "type"))).resolves.toEqual({ ok: true });
      await expect(h.controller.invoke(action(next, "click"))).rejects.toMatchObject({
        error: { kind: "user-active" },
      });
      await h.controller.invoke(action(next, "screenshot"));
      await expect(h.controller.invoke(action(next, "click"))).resolves.toEqual({ ok: true });
    } finally {
      h.controller.close();
    }
  });
  it("still latches ordinary foreground input", async () => {
    const h = fixture({ kind: "foreground" }, false);
    try {
      const held = await h.acquire();
      h.event({
        type: "physicalInput",
        cause: "pointer",
        executionGeneration: held.executionGeneration,
      });
      expect(h.controller.isPaused("p", "t")).toBe(true);
    } finally {
      h.controller.close();
    }
  });
  it("settles a pre-write native interruption as contention and keeps confirmed actions successful", async () => {
    const h = fixture();
    try {
      const held = await h.acquire();
      h.request.mockRejectedValueOnce(
        new ComputerControlError({
          _tag: "Interrupted",
          cause: "user-input",
          actionStarted: false,
        }),
      );
      await expect(h.controller.invoke(action(held))).rejects.toMatchObject({
        error: { _tag: "TargetBlocked", kind: "user-active" },
      });
      await vi.waitFor(() => expect(h.lease.holders()).toEqual([]));
      h.ready.activityEpoch++;
      h.ready.lastActivityAgeMs = 2000;
      const next = await h.acquire();
      await h.controller.invoke(action(next, "inspect"));
      h.request.mockImplementationOnce(async (request) => {
        h.event({ type: "actionConfirmed", requestId: request.requestId });
        h.event({
          type: "physicalInput",
          cause: "pointer",
          executionGeneration: next.executionGeneration,
        });
        throw new ComputerControlError({
          _tag: "Interrupted",
          cause: "user-input",
          actionStarted: true,
        });
      });
      await expect(h.controller.invoke(action(next))).resolves.toMatchObject({
        actionCompleted: true,
      });
      expect(h.paused).not.toHaveBeenCalled();
    } finally {
      h.controller.close();
    }
  });
  it("times out without screenshots or mutation slots and cancels promptly on Stop", async () => {
    const h = fixture();
    try {
      const held = await h.acquire();
      h.event({
        type: "targetInterrupted",
        cause: "scroll",
        executionGeneration: held.executionGeneration,
      });
      h.ready.frontmost = true;
      const timeout = await h.controller.waitForTarget("timeout", held, "app", 100);
      expect(timeout).toMatchObject({ available: false, timedOut: true, reason: "user-active" });
      expect(h.request).not.toHaveBeenCalled();
      const pending = h.controller.waitForTarget("cancel", held, "app", 30_000);
      h.controller.stop("kill-switch");
      await expect(pending).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
      expect(h.controller.isPaused("p", "t")).toBe(true);
    } finally {
      h.controller.close();
    }
  });
  it("reports a takeover wait available only when the takeover could arm", async () => {
    const h = fixture({ kind: "foreground" });
    try {
      h.ready.inputHeld = true;
      await expect(h.controller.waitForTarget("held", h.holder, undefined, 300)).resolves.toEqual({
        available: false,
        timedOut: true,
        reason: "user-active",
        detail: "input-held",
        requiresFreshObservation: true,
      });
      h.ready.inputHeld = false;
      h.ready.lastUserInputAgeMs = 0;
      await expect(
        h.controller.waitForTarget("recent", h.holder, undefined, 300),
      ).resolves.toMatchObject({ available: false, reason: "user-active", detail: "recent-input" });
      h.ready.monitorHealthy = false;
      await expect(
        h.controller.waitForTarget("monitor", h.holder, undefined, 300),
      ).resolves.toMatchObject({ detail: "monitor-unhealthy" });
      h.ready.monitorHealthy = true;
      h.ready.lastUserInputAgeMs = 5000;
      await expect(h.controller.waitForTarget("idle", h.holder, undefined, 300)).resolves.toEqual({
        available: true,
        timedOut: false,
        requiresFreshObservation: true,
      });
    } finally {
      h.controller.close();
    }
  });
  it("still reports foreground-busy ahead of user activity for a takeover wait", async () => {
    const h = fixture({ kind: "foreground" });
    try {
      h.lease.acquire({ ...h.holder, threadId: "other", scope: { kind: "foreground" } });
      h.ready.inputHeld = true;
      await expect(
        h.controller.waitForTarget("busy", h.holder, undefined, 300),
      ).resolves.toMatchObject({ available: false, timedOut: false, reason: "foreground-busy" });
    } finally {
      h.controller.close();
    }
  });
  it("the kill chord latches every yielded thread, including more than sixteen", async () => {
    const h = fixture();
    try {
      for (let index = 0; index < 20; index++) {
        const appId = "app-" + index;
        const holder = {
          ...h.holder,
          threadId: "thread-" + index,
          scope: { kind: "app" as const, appId },
          grants: [{ appId, tier: "full" as const, allowTyping: false }],
        };
        h.controller.updateGrants(holder);
        const held = await h.acquire(holder);
        h.event({
          type: "targetInterrupted",
          cause: "pointer",
          executionGeneration: held.executionGeneration,
        });
        await Promise.resolve();
      }
      expect(h.controller.cooperation.yielded.size).toBe(20);
      h.controller.stop("kill-switch");
      expect(h.paused).toHaveBeenCalledTimes(20);
      for (let index = 0; index < 20; index++)
        expect(h.controller.isPaused("p", "thread-" + index)).toBe(true);
      expect(h.controller.cooperation.yielded.size).toBe(0);
    } finally {
      h.controller.close();
    }
  });
  it("a partly posted foreground interruption requires recovery", async () => {
    const h = fixture({ kind: "foreground" });
    try {
      const held = await h.acquire();
      h.request.mockRejectedValueOnce(
        new ComputerControlError({
          _tag: "Interrupted",
          cause: "user-input",
          actionStarted: true,
        }),
      );
      await expect(h.controller.invoke(action(held))).rejects.toMatchObject({
        error: { _tag: "OutcomeUnknown" },
      });
      expect(h.controller.isPaused("p", "t")).toBe(true);
      expect(h.state).toHaveBeenCalledWith("p", expect.objectContaining({ state: "recovery" }));
    } finally {
      h.controller.close();
    }
  });
});
