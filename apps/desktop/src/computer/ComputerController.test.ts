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
const holder: ComputerLeaseHolder = { ...auth, backend: "native", threadTitle: "Thread" };
function make() {
  let event: (message: Record<string, unknown>) => void = () => {};
  const request = vi.fn(async (): Promise<unknown> => ({ ok: true }));
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
  const controller = new ComputerController(
    lease,
    helper,
    { show: vi.fn(), clear: vi.fn(), action: vi.fn(async () => {}), windowIds: () => [] },
    { f5Pids: () => [1], f5BundlePath: "F5", platform: "darwin", activity, paused },
  );
  controller.updateGrants(auth);
  const held = controller.acquire(holder);
  return {
    controller,
    helper,
    request,
    lease,
    paused,
    activity,
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
      expect(h.lease.current()).toEqual(h.held);
      h.event({ type: "permitExpired", executionGeneration: h.held.executionGeneration });
      expect(h.lease.current()).toBeNull();
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
    try {
      h.event({ type: "physicalInput" });
      expect(h.lease.current()).toBeNull();
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
      try {
        h.event({ type: "killSwitch" });
      } finally {
        clock.mockRestore();
      }
      expect(h.paused).toHaveBeenLastCalledWith(h.held, "kill-switch");
      expect(h.paused.mock.calls.map((call) => call[1])).toEqual(["user-input", "kill-switch"]);
    } finally {
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
      await expect(action).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "kill-switch" },
      });
      await expect(queued).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
      expect(h.lease.current()).toBeNull();
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
      await expect(action).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "access-changed" },
      });
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
