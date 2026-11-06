import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ComputerAuthorization,
  ComputerAutomationRequest,
  ComputerLeaseHolder,
} from "@t3tools/contracts";
import { computerRequestPayload } from "@t3tools/shared/computerControl";
import { ComputerController } from "./ComputerController";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
import type { ComputerHelper } from "./ComputerHelperClient";
const auth: ComputerAuthorization = {
  profileId: "p",
  threadId: "t",
  sessionGeneration: "s",
  turnId: "turn",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
};
const holder: ComputerLeaseHolder = {
  ...auth,
  backend: "native",
  threadTitle: "Thread",
  scope: { kind: "foreground" },
  policyRevision: 0,
};
function make(platform: "darwin" | "win32" = "darwin") {
  let event: (message: Record<string, unknown>) => void = () => {};
  const request = vi.fn(
    async (_request: ComputerAutomationRequest): Promise<unknown> => ({ ok: true }),
  );
  const helper: ComputerHelper = {
    status: vi.fn(
      (): ReturnType<ComputerHelper["status"]> => ({
        available: true,
        displays: [
          {
            displayId: "d",
            geometryGeneration: "g",
            primary: true,
            nativeBounds: { x: -100, y: 0, width: 100, height: 100 },
            pixelSize: { width: 200, height: 200 },
            modelSize: { width: 200, height: 200 },
            rotation: 0,
          },
        ],
      }),
    ),
    request,
    control: vi.fn(),
    suspend: vi.fn(async () => {}),
    onEvent: (callback) => {
      event = callback;
      return () => {};
    },
  };
  const lease = new ComputerLeaseAuthority();
  const paused = vi.fn();
  const activity = vi.fn();
  const overlay = {
    show: vi.fn(),
    clear: vi.fn(),
    action: vi.fn(async () => {}),
    windowIds: () => [],
  };
  const controller = new ComputerController(lease, helper, overlay, {
    f5Pids: () => [1],
    f5BundlePath: "F5",
    platform,
    activity,
    paused,
  });
  controller.updateGrants(auth);
  const held = controller.acquire(holder);
  return {
    controller,
    helper,
    request,
    lease,
    paused,
    activity,
    overlay,
    held,
    event: (message: Record<string, unknown>) => event(message),
  };
}
function envelope(id: string, authorization = auth, extras: Record<string, unknown> = {}) {
  const value = {
    requestId: id,
    authorization,
    deadlineAtMs: Date.now() + 10000,
    agent: { provider: "claude", threadTitle: "Thread" },
    op: "type",
    text: "Hello",
    ...extras,
  } as Omit<ComputerAutomationRequest, "payloadHash">;
  return {
    ...value,
    payloadHash: createHash("sha256").update(computerRequestPayload(value)).digest("hex"),
  } as ComputerAutomationRequest;
}
describe("main computer controller", () => {
  it("releases a cancelled helper wait and ignores its late result", async () => {
    const h = make();
    let finish: (value: unknown) => void = () => {};
    h.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    try {
      const pending = h.controller.invoke(envelope("old-helper"));
      // The helper already received it: the outcome is unknown, never "interrupted".
      const interrupted = expect(pending).rejects.toMatchObject({
        error: { _tag: "OutcomeUnknown" },
      });
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
      h.controller.stop();
      await interrupted;
      // The unknown outcome enters recovery: only a local resume clears it.
      expect(h.controller.resumeTarget("p", "t")).toMatchObject({
        pauseCause: "outcome-unknown",
        recovery: true,
      });
      h.controller.setPaused("p", "t", false);
      // The helper has not answered: the released lease must not hand control to anyone.
      expect(() => h.controller.acquire(holder)).toThrow(/foreground-busy/);
      finish({ ok: true });
      await vi.waitFor(() => expect(() => h.controller.acquire(holder)).not.toThrow());
      const next = h.lease.holders().find((entry) => entry.threadId === holder.threadId)!;
      await h.controller.invoke(
        envelope("next-helper", { ...auth, executionGeneration: next.executionGeneration }),
      );
      expect(h.request).toHaveBeenCalledTimes(2);
      expect(
        h.activity.mock.calls.filter(([, action]) => action.status === "completed"),
      ).toHaveLength(1);
    } finally {
      h.controller.close();
    }
  });
  it("frees a stalled overlay job on Stop and never dispatches it after Resume", async () => {
    const h = make();
    let finish = () => {};
    const draw = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.overlay.action.mockReturnValueOnce(draw);
    try {
      const pending = h.controller.invoke(envelope("stalled"));
      const interrupted = expect(pending).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "paused" },
      });
      h.controller.stop();
      await interrupted;
      h.controller.setPaused("p", "t", false);
      const next = h.controller.acquire(holder);
      await h.controller.invoke(
        envelope("new", { ...auth, executionGeneration: next.executionGeneration }),
      );
      expect(h.request).toHaveBeenCalledTimes(1);
      finish();
      await Promise.resolve();
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.request.mock.calls[0]?.[0]).toMatchObject({ requestId: "new" });
    } finally {
      h.controller.close();
    }
  });
  it("times out a hung overlay while retaining input authorization", async () => {
    vi.useFakeTimers();
    const h = make();
    h.overlay.action.mockReturnValueOnce(new Promise(() => {}));
    try {
      const pending = h.controller.invoke(envelope("bounded"));
      await vi.advanceTimersByTimeAsync(280);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(h.request).toHaveBeenCalledTimes(1);
    } finally {
      h.controller.close();
      vi.useRealTimers();
    }
  });
  it("rejects acquisition when the shortcut observer immediately revokes the lease", () => {
    const h = make();
    h.lease.release(h.held);
    const off = h.lease.subscribe((holders) => {
      if (holders.length) h.controller.stop();
    });
    try {
      expect(() => h.controller.acquire(holder)).toThrow();
      expect(h.lease.holders()).toEqual([]);
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      off();
      h.controller.close();
    }
  });
  it("resumes preview-only pauses with an unavailable helper", () => {
    const h = make();
    try {
      h.controller.setPaused("p", "preview-only", true);
      vi.mocked(h.helper.status).mockReturnValue({ available: false, reason: "helper-missing" });
      expect(h.controller.requiresLocalResume("p", "preview-only")).toBe(false);
      expect(() => h.controller.setPaused("p", "preview-only", false)).not.toThrow();
      h.controller.stop();
      expect(h.controller.requiresLocalResume("p", "t")).toBe(true);
      expect(() => h.controller.setPaused("p", "t", false)).toThrow();
    } finally {
      h.controller.close();
    }
  });
  it("refuses foreground acquisition during recent input without latching a pause", () => {
    const h = make();
    const next = { ...holder, threadId: "next-thread" };
    try {
      h.event({ type: "physicalInput" });
      h.paused.mockClear();
      expect(() => h.controller.acquire(next)).toThrow(
        expect.objectContaining({ error: { _tag: "TargetBlocked", kind: "user-active" } }),
      );
      expect(h.lease.holders()).toEqual([]);
      expect(h.paused).not.toHaveBeenCalled();
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
      try {
        // Acquisition is non-latching: once the user is idle the agent may proceed.
        expect(h.controller.acquire(next).threadId).toBe("next-thread");
      } finally {
        clock.mockRestore();
      }
    } finally {
      h.controller.close();
    }
  });
  it("replays authorization into a replacement suspended helper", async () => {
    const h = make();
    try {
      h.controller.stop();
      vi.mocked(h.helper.control).mockClear();
      h.event({ type: "hello", protocolVersion: 1 });
      expect(h.helper.control).toHaveBeenCalledWith({ type: "grantsChanged", authorization: auth });
      expect(h.helper.control).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "resume" }),
      );
      h.controller.setPaused("p", "t", false);
      const next = h.controller.acquire(holder);
      await h.controller.invoke(
        envelope("after-restart", { ...auth, executionGeneration: next.executionGeneration }),
      );
    } finally {
      h.controller.close();
    }
  });
  it("ignores pre-resume heartbeats and old-generation expiry", () => {
    const h = make();
    try {
      h.event({ type: "heartbeat", suspended: true });
      h.event({ type: "permitExpired", executionGeneration: h.held.executionGeneration - 1 });
      expect(h.lease.holders()).toEqual([h.held]);
      h.event({ type: "permitExpired", executionGeneration: h.held.executionGeneration });
      expect(h.lease.holders()).toEqual([]);
      expect(h.paused).toHaveBeenCalledWith(h.held, "permit-expired");
    } finally {
      h.controller.close();
    }
  });
  it("does not perform timed stop round trips for repeated idle unavailable status", () => {
    const h = make();
    try {
      h.controller.stop();
      vi.mocked(h.helper.suspend).mockClear();
      vi.mocked(h.helper.status).mockReturnValue({
        available: false,
        reason: "missing-permissions",
      });
      for (let i = 0; i < 8; i++) h.event({ type: "status" });
      expect(h.helper.suspend).not.toHaveBeenCalled();
    } finally {
      h.controller.close();
    }
  });
  it("associates action thumbnails with the authorizing profile", async () => {
    const h = make();
    try {
      await h.controller.invoke(envelope("activity"));
      expect(h.activity).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ status: "completed", threadId: "t" }),
      );
    } finally {
      h.controller.close();
    }
  });
  it("recognizes the kill chord after its first physical modifier has already paused input", () => {
    const h = make();
    const at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      h.event({ type: "physicalInput" });
      expect(h.lease.holders()).toEqual([]);
      clock.mockReturnValue(at + 5000);
      h.event({ type: "killSwitch" });
      expect(h.paused).toHaveBeenLastCalledWith(h.held, "kill-switch");
      expect(h.paused.mock.calls.map((call) => call[1])).toEqual(["user-input", "kill-switch"]);
    } finally {
      clock.mockRestore();
      h.controller.close();
    }
  });
  it("does not attribute the kill chord to a stopped generation older than five seconds", () => {
    const h = make();
    const at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      h.event({ type: "physicalInput" });
      clock.mockReturnValue(at + 5001);
      h.event({ type: "killSwitch" });
      expect(h.paused.mock.calls.map((call) => call[1])).toEqual(["user-input"]);
    } finally {
      clock.mockRestore();
      h.controller.close();
    }
  });
  it("deduplicates concurrent retries and rejects payload mismatch", async () => {
    const h = make();
    try {
      const value = envelope("same");
      const a = h.controller.invoke(value);
      const b = h.controller.invoke(value);
      expect(a).toBe(b);
      await a;
      expect(h.request).toHaveBeenCalledTimes(1);
      await expect(
        h.controller.invoke(envelope("same", auth, { text: "different" })),
      ).rejects.toMatchObject({ error: { _tag: "PayloadMismatch" } });
    } finally {
      h.controller.close();
    }
  });
  it("stops locally with a hung renderer and backend", async () => {
    const h = make();
    try {
      let finish: (value: unknown) => void = () => {};
      h.request.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const action = h.controller.invoke(envelope("active"));
      await vi.waitFor(() => expect(h.request).toHaveBeenCalled());
      const queued = h.controller.invoke(envelope("queued"));
      h.event({ type: "killSwitch" });
      // Sent to the helper without confirmation: unknown. Still queued: interrupted.
      await expect(action).rejects.toMatchObject({ error: { _tag: "OutcomeUnknown" } });
      await expect(queued).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "kill-switch" },
      });
      expect(h.lease.holders()).toEqual([]);
      expect(h.helper.suspend).toHaveBeenCalled();
      expect(h.activity).toHaveBeenLastCalledWith(
        "p",
        expect.objectContaining({ status: "interrupted", threadId: "t" }),
      );
      expect(() => h.controller.acquire(holder)).toThrow();
      finish({ ok: true });
    } finally {
      h.controller.close();
    }
  });
  it("refuses stale grants, stale geometry and exclusive coordinate bounds", async () => {
    const h = make();
    try {
      await expect(
        h.controller.invoke(envelope("stale", { ...auth, grantVersion: 0 })),
      ).rejects.toMatchObject({ error: { _tag: "Interrupted", cause: "access-changed" } });
      await expect(
        h.controller.invoke(
          envelope("geometry", auth, {
            op: "move",
            displayId: "d",
            geometryGeneration: "old",
            x: 0,
            y: 0,
          }),
        ),
      ).rejects.toMatchObject({ error: { _tag: "GeometryChanged" } });
      await expect(
        h.controller.invoke(
          envelope("edge", auth, {
            op: "move",
            displayId: "d",
            geometryGeneration: "g",
            x: 200,
            y: 0,
          }),
        ),
      ).rejects.toThrow();
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      h.controller.close();
    }
  });
  it("keeps evicted request ids as tombstones", async () => {
    const h = make();
    try {
      const original = envelope("0");
      await h.controller.invoke(original);
      for (let i = 1; i < 65; i++) await h.controller.invoke(envelope(String(i)));
      await expect(h.controller.invoke(original)).rejects.toMatchObject({
        error: { _tag: "ReplayRejected" },
      });
      expect(h.request).toHaveBeenCalledTimes(65);
    } finally {
      h.controller.close();
    }
  });
  it("revocation cancels pending input before a late helper completion", async () => {
    const h = make();
    try {
      let finish: (value: unknown) => void = () => {};
      h.request.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const action = h.controller.invoke(envelope("active"));
      await vi.waitFor(() => expect(h.request).toHaveBeenCalled());
      h.controller.updateGrants({ ...auth, grantVersion: 2 });
      await expect(action).rejects.toMatchObject({ error: { _tag: "OutcomeUnknown" } });
      expect(h.helper.control).toHaveBeenCalledWith({ type: "cancel", requestId: "active" });
      finish({ ok: true });
    } finally {
      h.controller.close();
    }
  });
});

it("bounds observation concurrency and drains observations on local stop", async () => {
  const h = make();
  const completions: Array<(result: unknown) => void> = [];
  h.request.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
  const observations = Array.from({ length: 6 }, (_, index) =>
    h.controller.invoke(envelope(`observe-${index}`, auth, { op: "listApps" })).then(
      () => "completed",
      (error) => error.error._tag,
    ),
  );
  try {
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    await expect(
      h.controller.invoke(envelope("overflow", auth, { op: "listApps" })),
    ).rejects.toMatchObject({ error: { _tag: "Busy" } });
    h.controller.stop("kill-switch");
    expect(await Promise.all(observations)).toEqual(Array(6).fill("Interrupted"));
    completions.forEach((resolve) => resolve([]));
    expect(h.request).toHaveBeenCalledTimes(2);
  } finally {
    h.controller.close();
  }
});
it("rejects an expired deadline and old execution generation before input", async () => {
  const h = make();
  try {
    await expect(
      h.controller.invoke(envelope("expired", auth, { deadlineAtMs: Date.now() - 1 })),
    ).rejects.toMatchObject({ error: { _tag: "Execution" } });
    h.lease.release(h.held);
    const newHolder = h.controller.acquire(holder);
    expect(newHolder.executionGeneration).toBeGreaterThan(h.held.executionGeneration);
    await expect(h.controller.invoke(envelope("old", auth))).rejects.toMatchObject({
      error: { _tag: "ReplayRejected" },
    });
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    h.controller.close();
  }
});

it("blocks capture and inspection while paused, including when there is no lease", async () => {
  const h = make();
  try {
    h.controller.setPaused("p", "t", true);
    for (const op of ["screenshot", "zoom", "inspect"])
      await expect(
        h.controller.invoke(envelope(`paused-${op}`, auth, { op, appId: "com.apple.TextEdit" })),
      ).rejects.toMatchObject({ error: { _tag: "Interrupted", cause: "paused" } });
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    h.controller.close();
  }
});

it("forwards subtree inspection on Windows without silently inspecting the whole window", async () => {
  const h = make("win32");
  await expect(
    h.controller.invoke(
      envelope("subtree", auth, {
        op: "inspect",
        appId: "one",
        maxNodes: 400,
        snapshotId: "s",
        elementRef: "e1",
      }),
    ),
  ).resolves.toEqual({ ok: true });
  expect(h.request).toHaveBeenCalledWith(
    expect.objectContaining({
      op: "inspect",
      appId: "one",
      snapshotId: "s",
      elementRef: "e1",
    }),
    expect.anything(),
  );
  h.controller.close();
});
