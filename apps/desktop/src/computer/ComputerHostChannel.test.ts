import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ChromeProcessSupervisor, type ChromeProcessIo } from "./ChromeProcessSupervisor";
import { ComputerHostChannel } from "./ComputerHostChannel";
import type { ComputerController } from "./ComputerController";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
function setup(
  certified = false,
  advertiseBackground?: boolean,
  options: {
    notification?: (
      profile: string,
      notice: import("@t3tools/contracts").DesktopScheduledNotification,
    ) => boolean;
    supervisor?: ChromeProcessSupervisor;
  } = {},
) {
  const { notification, supervisor } = options;
  const controller = {
    disconnect: vi.fn(),
    setPaused: vi.fn(),
    lease: new ComputerLeaseAuthority(),
    invoke: vi.fn(),
    cancel: vi.fn(),
    acquire: vi.fn(),
    inputIdleMs: () => 10_000,
    isPaused: () => false,
    drainBackground: vi.fn(async () => () => {}),
    takeoverReadiness: vi.fn(async () => ({ idleMs: 10_000 })),
    nativeWorkConflicts: vi.fn(() => false),
  };
  const channel = new ComputerHostChannel(
    controller as unknown as ComputerController,
    () => ({ available: true }),
    vi.fn(),
    { certified: () => certified, ...(supervisor ? { supervisor } : {}) },
    undefined,
    {
      ...(notification ? { notification } : {}),
      background: () => ({ available: true }),
      ...(advertiseBackground !== undefined ? { advertiseBackground } : {}),
    },
  );
  const process = Object.assign(new EventEmitter(), {
    pid: 50,
    connected: true,
    send: vi.fn(),
    disconnect: vi.fn(),
  });
  channel.register("profile", "incarnation", process as unknown as ChildProcess);
  const hello = (capabilities?: ReadonlyArray<string>) =>
    process.emit("message", {
      type: "hello",
      profileId: "profile",
      backendIncarnation: "incarnation",
      protocolVersion: 1,
      ...(capabilities ? { capabilities } : {}),
    });
  return { channel, controller, process, hello };
}
describe("private computer host channel", () => {
  it("keeps thumbnails private and sends other profiles only an anonymous lease", () => {
    const h = setup();
    h.hello();
    const other = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    h.channel.register("other", "other-incarnation", other as unknown as ChildProcess);
    other.emit("message", {
      type: "hello",
      profileId: "other",
      backendIncarnation: "other-incarnation",
      protocolVersion: 1,
    });
    h.process.send.mockClear();
    other.send.mockClear();
    const activity = {
      threadId: "secret-thread",
      backend: "native" as const,
      op: "click" as const,
      status: "completed" as const,
      thumbnailDataUrl: "data:image/jpeg;base64,PRIVATE",
    };
    h.channel.send("profile", { type: "activity", activity });
    expect(h.process.send).toHaveBeenCalledWith(
      { type: "activity", activity },
      expect.any(Function),
    );
    expect(other.send).not.toHaveBeenCalled();
    const holder = {
      profileId: "profile",
      threadId: "secret-thread",
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      threadTitle: "Private title",
      grantVersion: 1,
      grants: [],
      backend: "native" as const,
      scope: { kind: "foreground" as const },
      policyRevision: 0,
    };
    h.controller.lease.acquire(holder);
    h.channel.publishLeases();
    expect(h.process.send).toHaveBeenLastCalledWith(
      { type: "leaseChanged", holder, otherProfile: false },
      expect.any(Function),
    );
    expect(other.send).toHaveBeenLastCalledWith(
      { type: "leaseChanged", holder: null, otherProfile: true },
      expect.any(Function),
    );
    expect(JSON.stringify(other.send.mock.calls)).not.toContain("secret-thread");
    expect(JSON.stringify(other.send.mock.calls)).not.toContain("PRIVATE");
  });
  it("requires certification and preserves main's pause veto independently of the server", async () => {
    const holder = {
      profileId: "profile",
      threadId: "thread",
      sessionGeneration: "s",
      provider: "claude",
    };
    const closed = setup();
    closed.hello();
    closed.process.emit("message", { type: "chromeLeaseAcquire", requestId: "closed", holder });
    await vi.waitFor(() =>
      expect(closed.process.send).toHaveBeenCalledWith(
        {
          type: "response",
          requestId: "closed",
          error: { _tag: "Unavailable", reason: "not-certified" },
        },
        expect.any(Function),
      ),
    );
    expect(closed.channel.chrome.current()).toBeNull();
    const h = setup(true);
    h.hello();
    h.process.emit("message", { type: "chromeLeaseAcquire", requestId: "acquire", holder });
    await vi.waitFor(() => expect(h.channel.chrome.current()).toEqual(holder));
    h.channel.pauseChrome("profile", "thread", true);
    h.process.emit("message", { type: "chromeLeaseValidate", requestId: "validate", holder });
    await vi.waitFor(() =>
      expect(h.process.send).toHaveBeenCalledWith(
        {
          type: "response",
          requestId: "validate",
          error: { _tag: "Interrupted", cause: "paused" },
        },
        expect.any(Function),
      ),
    );
    h.process.emit("disconnect");
    expect(h.channel.chrome.current()).toBeNull();
  });
  it("registers only the backend's descendants and refuses a generation stopped by ⌃⌘Esc", async () => {
    const io: ChromeProcessIo = {
      snapshot: async () => [
        { pid: 50, ppid: 1, pgid: 50, startTime: 0, zombie: false },
        { pid: 100, ppid: 50, pgid: 100, startTime: 1_000, zombie: false },
        { pid: 200, ppid: 1, pgid: 200, startTime: 1_000, zombie: false },
      ],
      killGroup: vi.fn(),
      setTimeout: () => 0,
      clearTimeout: () => {},
      now: () => 0,
    };
    const supervisor = new ChromeProcessSupervisor({ io });
    const h = setup(true, undefined, { supervisor });
    h.hello();
    const registration = (pid: number, launchToken: string) => ({
      profileId: "profile",
      backendIncarnation: "incarnation",
      threadId: "thread",
      sessionGeneration: "s",
      launchToken,
      integration: "codex-chrome",
      pid,
      pgid: pid,
      startTime: 1_000,
    });
    const response = (requestId: string) =>
      h.process.send.mock.calls.find(([message]) => message.requestId === requestId)?.[0];
    h.process.emit("message", {
      type: "chromeProcessRegister",
      requestId: "foreign",
      registration: registration(200, "a"),
    });
    h.process.emit("message", {
      type: "chromeProcessRegister",
      requestId: "own",
      registration: registration(100, "b"),
    });
    await vi.waitFor(() => expect(response("own")).toMatchObject({ result: true }));
    expect(response("foreign")).toMatchObject({ error: { _tag: "Execution" } });

    supervisor.stop(() => true, "emergency");
    const holder = {
      profileId: "profile",
      threadId: "thread",
      sessionGeneration: "s",
      provider: "codex",
    };
    h.process.emit("message", { type: "chromeLeaseAcquire", requestId: "after-stop", holder });
    await vi.waitFor(() =>
      expect(response("after-stop")).toMatchObject({
        error: { _tag: "Interrupted", cause: "kill-switch" },
      }),
    );
    supervisor.resumed("profile", "thread");
    h.process.emit("message", { type: "chromeLeaseAcquire", requestId: "resumed", holder });
    await vi.waitFor(() => expect(response("resumed")).toMatchObject({ result: true }));
  });
  it("refuses Sky's foreground lease while codex-computer is uncertified", async () => {
    const h = setup(true);
    h.hello();
    const holder = {
      profileId: "profile",
      threadId: "thread",
      sessionGeneration: "s",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
      backend: "codex-builtin",
      threadTitle: "Thread",
      scope: { kind: "foreground" },
      policyRevision: 0,
    };
    h.process.emit("message", { type: "builtinLeaseAcquire", requestId: "sky", holder });
    await vi.waitFor(() =>
      expect(h.process.send).toHaveBeenCalledWith(
        {
          type: "response",
          requestId: "sky",
          error: { _tag: "Unavailable", reason: "not-certified" },
        },
        expect.any(Function),
      ),
    );
    expect(h.controller.lease.holders()).toEqual([]);
  });
  it("takes the restore lease without a certified record, keeping exclusion", async () => {
    const h = setup(false);
    h.hello();
    const holder = {
      profileId: "profile",
      threadId: "restore",
      sessionGeneration: "r",
      provider: "claude",
    };
    h.process.emit("message", { type: "chromeRestoreAcquire", requestId: "restore", holder });
    await vi.waitFor(() => expect(h.channel.chrome.current()).toEqual(holder));
    h.controller.nativeWorkConflicts.mockReturnValue(true);
    h.process.emit("message", {
      type: "chromeRestoreAcquire",
      requestId: "busy",
      holder: { ...holder, profileId: "profile", threadId: "other" },
    });
    await vi.waitFor(() =>
      expect(h.process.send).toHaveBeenCalledWith(
        { type: "response", requestId: "busy", error: { _tag: "Busy", holder: "same-profile" } },
        expect.any(Function),
      ),
    );
  });
  it("does not accept backend resume requests for native or Chrome control", async () => {
    const h = setup(true);
    h.hello();
    h.process.emit("message", { type: "pauseChanged", threadId: "thread", paused: true });
    h.controller.setPaused.mockClear();
    h.process.emit("message", { type: "resumeRequested", threadId: "thread" });
    h.process.emit("message", { type: "pauseChanged", threadId: "thread", paused: false });
    expect(h.controller.setPaused).not.toHaveBeenCalled();
    const holder = {
      profileId: "profile",
      threadId: "chrome-thread",
      sessionGeneration: "s",
      provider: "claude" as const,
    };
    h.channel.chrome.acquire(holder, null);
    h.channel.pauseChrome("profile", "chrome-thread", true);
    h.process.emit("message", { type: "resumeRequested", threadId: "chrome-thread" });
    h.process.emit("message", { type: "pauseChanged", threadId: "chrome-thread", paused: false });
    expect(() => h.channel.chrome.validate(holder)).toThrow();
    expect(h.controller.setPaused).not.toHaveBeenCalled();
  });
  it("redacts Chrome session ownership for another profile", () => {
    const h = setup(true);
    h.hello();
    const other = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    h.channel.register("other", "other-incarnation", other as unknown as ChildProcess);
    other.emit("message", {
      type: "hello",
      profileId: "other",
      backendIncarnation: "other-incarnation",
      protocolVersion: 1,
    });
    other.send.mockClear();
    h.channel.chrome.acquire(
      {
        profileId: "profile",
        threadId: "private-thread",
        sessionGeneration: "private-generation",
        provider: "claude",
      },
      null,
    );
    expect(other.send).toHaveBeenLastCalledWith(
      { type: "chromeLeaseChanged", holder: null, otherProfile: true },
      expect.any(Function),
    );
    expect(JSON.stringify(other.send.mock.calls)).not.toContain("private");
  });
  it("rejects mismatched hello before allowing registration", () => {
    const h = setup();
    h.process.emit("message", {
      type: "hello",
      profileId: "other",
      backendIncarnation: "incarnation",
      protocolVersion: 1,
    });
    expect(h.process.disconnect).toHaveBeenCalled();
    expect(h.process.send).not.toHaveBeenCalled();
  });
  it("rejects consent from another profile or incarnation and accepts each answer only once", () => {
    const h = setup();
    h.hello();
    h.process.emit("message", {
      type: "accessRequested",
      request: {
        requestId: "request",
        threadId: "thread",
        reason: "Edit Notes",
        kind: "apps",
        apps: [{ appId: "notes", name: "Notes", tier: "full" }],
      },
    });
    const answer = { requestId: "request", backendIncarnation: "incarnation", decisions: [] };
    expect(h.channel.accessRequest("profile", answer).apps).toEqual([
      { appId: "notes", name: "Notes", tier: "full" },
    ]);
    expect(() => h.channel.accessRequest("other", answer)).toThrow();
    expect(() =>
      h.channel.accessRequest("profile", { ...answer, backendIncarnation: "old" }),
    ).toThrow();
    expect(() => h.channel.answerAccess("other", answer)).toThrow();
    expect(() =>
      h.channel.answerAccess("profile", { ...answer, backendIncarnation: "old" }),
    ).toThrow();
    h.channel.answerAccess("profile", answer);
    expect(() => h.channel.accessRequest("profile", answer)).toThrow();
    expect(() => h.channel.answerAccess("profile", answer)).toThrow();
    expect(h.process.send).toHaveBeenCalledWith(
      { type: "accessAnswer", answer },
      expect.any(Function),
    );
  });
  it("revokes device authority on disconnect and on backend replacement", () => {
    const h = setup();
    h.hello();
    const replacement = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    h.channel.register("profile", "new", replacement as unknown as ChildProcess);
    expect(h.controller.disconnect).toHaveBeenCalledTimes(1);
    h.process.emit("disconnect");
    expect(h.controller.disconnect).toHaveBeenCalledTimes(1);
    replacement.emit("disconnect");
    expect(h.controller.disconnect).toHaveBeenCalledTimes(2);
  });
});

it("releases an unacknowledged acquisition when the backend times out, using the exact holder", () => {
  const h = setup();
  h.hello();
  const holder = {
    profileId: "profile",
    threadId: "t",
    sessionGeneration: "s",
    turnId: "turn",
    executionGeneration: 7,
    grantVersion: 1,
    grants: [],
    backend: "native" as const,
    threadTitle: "Thread",
  };
  const acquire = vi.fn(() => holder);
  const release = vi.fn();
  Object.assign(h.controller, { acquire, cancel: vi.fn() });
  Object.assign(h.controller.lease, { release });
  h.process.emit("message", {
    type: "leaseAcquire",
    requestId: "late",
    holder: { ...holder, executionGeneration: 1 },
  });
  h.process.emit("message", { type: "cancel", requestId: "late" });
  expect(release).toHaveBeenCalledExactlyOnceWith(holder);
  h.process.emit("message", { type: "cancel", requestId: "late" });
  expect(release).toHaveBeenCalledOnce();
  h.process.emit("message", { type: "leaseAcquire", requestId: "accepted", holder });
  h.process.emit("message", { type: "leaseAccepted", requestId: "accepted" });
  h.process.emit("message", { type: "cancel", requestId: "accepted" });
  expect(release).toHaveBeenCalledOnce();
});

describe("background capability negotiation", () => {
  const appHolder = {
    profileId: "profile",
    threadId: "t",
    sessionGeneration: "s",
    turnId: "turn",
    executionGeneration: 1,
    grantVersion: 1,
    grants: [],
    backend: "native" as const,
    threadTitle: "Thread",
    scope: { kind: "app" as const, appId: "com.apple.calculator" },
    policyRevision: 0,
  };
  const sent = (h: ReturnType<typeof setup>) =>
    h.process.send.mock.calls.map(([message]) => message as Record<string, unknown>);
  it("keeps legacy peers on single-holder leases and foreground-only status", () => {
    const h = setup();
    h.hello();
    expect(sent(h).map((message) => message.type)).toEqual(["status", "leaseChanged"]);
    expect(sent(h)[0]).toEqual({ type: "status", status: { available: true } });
    h.process.emit("message", { type: "leaseAcquire", requestId: "bg", holder: appHolder });
    expect(h.process.disconnect).toHaveBeenCalled();
  });
  it("never advertises background while the preview gate is closed", () => {
    const h = setup(false, false);
    h.hello(["background-ax-v1"]);
    // A capable backend still gets the legacy protocol: no background path runs.
    expect(sent(h).map((message) => message.type)).toEqual(["status", "leaseChanged"]);
    h.process.emit("message", { type: "leaseAcquire", requestId: "bg", holder: appHolder });
    expect(h.process.disconnect).toHaveBeenCalled();
  });
  it("advertises background to capable peers and requires an Electron session receipt", async () => {
    const h = setup();
    h.hello(["background-ax-v1"]);
    expect(sent(h).map((message) => message.type)).toEqual([
      "hostCapabilities",
      "status",
      "leasesChanged",
    ]);
    expect(sent(h)[1]).toEqual({
      type: "status",
      status: { available: true, background: { available: true } },
    });
    h.process.emit("message", { type: "leaseAcquire", requestId: "no-receipt", holder: appHolder });
    await vi.waitFor(() =>
      expect(sent(h).at(-1)).toMatchObject({
        type: "response",
        requestId: "no-receipt",
        error: { _tag: "NotGranted" },
      }),
    );
    expect(h.controller.acquire).not.toHaveBeenCalled();
    h.process.emit("message", {
      type: "accessRequested",
      request: {
        requestId: "session",
        threadId: "t",
        sessionGeneration: "s",
        reason: "Work in Calculator",
        kind: "session-actions",
        background: true,
        apps: [],
      },
    });
    h.channel.answerAccess("profile", {
      requestId: "session",
      backendIncarnation: "incarnation",
      decisions: [],
      allowSessionActions: true,
    });
    expect(sent(h).at(-1)).toMatchObject({
      type: "accessAnswer",
      answer: { allowSessionActions: true, sessionReceipt: expect.any(String) },
    });
    h.controller.acquire.mockReturnValue(appHolder);
    h.process.emit("message", { type: "leaseAcquire", requestId: "ok", holder: appHolder });
    expect(h.controller.acquire).toHaveBeenCalledOnce();
  });
  it("arms an approved takeover only after consent and keeps it across consent cleanup", async () => {
    const h = setup();
    h.hello(["background-ax-v1"]);
    h.process.emit("message", {
      type: "accessRequested",
      request: {
        requestId: "session",
        threadId: "t",
        sessionGeneration: "s",
        reason: "r",
        kind: "session-actions",
        background: true,
        apps: [],
      },
    });
    h.channel.answerAccess("profile", {
      requestId: "session",
      backendIncarnation: "incarnation",
      decisions: [],
      allowSessionActions: true,
    });
    h.process.emit("message", {
      type: "accessRequested",
      request: {
        requestId: "approval",
        threadId: "t",
        sessionGeneration: "s",
        reason: "Need to drag",
        kind: "foreground-takeover",
        takeover: {
          appId: "com.apple.calculator",
          threadId: "t",
          turnId: "turn",
          reason: "Need to drag",
        },
        apps: [],
      },
    });
    h.process.emit("message", {
      type: "foregroundTakeoverAcquire",
      requestId: "takeover",
      approvalRequestId: "approval",
      holder: {
        ...appHolder,
        scope: {
          kind: "takeover",
          appId: "com.apple.calculator",
          approvalReceipt: "approval",
        },
      },
    });
    expect(h.controller.lease.pendingTakeover()?.appId).toBe("com.apple.calculator");
    expect(sent(h).some((message) => message.requestId === "takeover")).toBe(false);
    h.channel.answerAccess("profile", {
      requestId: "approval",
      backendIncarnation: "incarnation",
      decisions: [],
      allowForegroundTakeover: true,
    });
    // The server's consent cleanup cancels only the consent record.
    h.process.emit("message", { type: "cancel", requestId: "approval" });
    await vi.waitFor(() =>
      expect(sent(h).find((message) => message.requestId === "takeover")).toMatchObject({
        type: "response",
        result: { scope: { kind: "takeover", appId: "com.apple.calculator" } },
      }),
    );
    const armed = h.controller.lease.takeover()!;
    expect(h.channel.execution.validTakeover(armed, "incarnation")).toBe(true);
    expect(h.channel.execution.validTakeover(armed, "other-incarnation")).toBe(false);
    h.process.emit("message", { type: "leaseRelease", requestId: "x", holder: armed });
    expect(h.channel.execution.validTakeover(armed, "incarnation")).toBe(false);
  });
  it("cancels a pending takeover on denial and on cancel without arming", async () => {
    const h = setup();
    h.hello(["background-ax-v1"]);
    h.channel.execution.approveSession({
      profileId: "profile",
      backendIncarnation: "incarnation",
      threadId: "t",
      sessionGeneration: "s",
      policyRevision: 0,
    });
    const takeover = (requestId: string) =>
      h.process.emit("message", {
        type: "foregroundTakeoverAcquire",
        requestId,
        approvalRequestId: `${requestId}-approval`,
        holder: {
          ...appHolder,
          scope: { kind: "takeover", appId: "com.apple.calculator", approvalReceipt: "x" },
        },
      });
    takeover("cancelled");
    h.process.emit("message", { type: "cancel", requestId: "cancelled" });
    expect(h.controller.lease.pendingTakeover()).toBeNull();
    takeover("denied");
    h.process.emit("message", {
      type: "accessRequested",
      request: {
        requestId: "denied-approval",
        threadId: "t",
        reason: "r",
        kind: "foreground-takeover",
        apps: [],
      },
    });
    h.channel.answerAccess("profile", {
      requestId: "denied-approval",
      backendIncarnation: "incarnation",
      decisions: [],
      allowForegroundTakeover: false,
    });
    await vi.waitFor(() =>
      expect(sent(h).find((message) => message.requestId === "denied")).toMatchObject({
        error: { _tag: "NotGranted" },
      }),
    );
    expect(h.controller.lease.holders()).toEqual([]);
    expect(h.controller.lease.pendingTakeover()).toBeNull();
  });
  it("rejects leases from an older policy revision after an invalidation", async () => {
    const h = setup();
    h.hello(["background-ax-v1"]);
    Object.assign(h.controller, { invalidateThread: vi.fn(async () => {}) });
    h.process.emit("message", {
      type: "observationInvalidate",
      requestId: "inv",
      threadId: "t",
      policyRevision: 3,
    });
    await vi.waitFor(() =>
      expect(sent(h).at(-1)).toEqual({ type: "response", requestId: "inv", result: true }),
    );
    h.process.emit("message", {
      type: "leaseAcquire",
      requestId: "stale",
      holder: { ...appHolder, scope: { kind: "foreground" }, policyRevision: 2 },
    });
    await vi.waitFor(() =>
      expect(sent(h).at(-1)).toMatchObject({
        requestId: "stale",
        error: { _tag: "Interrupted", cause: "access-changed" },
      }),
    );
  });
});

it.each([
  [[], []],
  [["background-ax-v1"], []],
  [["computer-agent-identity-v1"], ["computer-agent-identity-v1"]],
  [["computer-activity-correlation-v1"], ["computer-activity-correlation-v1"]],
  [
    ["background-ax-v1", "computer-agent-identity-v1", "computer-activity-correlation-v1"],
    ["computer-agent-identity-v1", "computer-activity-correlation-v1"],
  ],
])(
  "negotiates features independently with the background gate closed (%s)",
  (advertised, accepted) => {
    const h = setup(false, false);
    h.hello(advertised);
    const messages = h.process.send.mock.calls.map(
      ([message]) => message as Record<string, unknown>,
    );
    expect(messages.filter((message) => message.type === "hostCapabilities")).toEqual(
      accepted.length ? [{ type: "hostCapabilities", capabilities: accepted }] : [],
    );
    expect(messages.find((message) => message.type === "leasesChanged")).toBeUndefined();
  },
);

it("delivers and acknowledges scheduled notices without computer access, fencing stale incarnations", () => {
  const notify = vi.fn(() => true);
  const h = setup(false, false, { notification: notify });
  h.hello(["scheduled-notifications-v1"]);
  const notification = {
    id: "notice",
    title: "Task",
    body: "Finished",
    taskId: "task",
    threadId: "thread",
  };
  h.process.emit("message", { type: "scheduledNotification", notification });
  expect(notify).toHaveBeenCalledWith("profile", notification);
  expect(h.process.send).toHaveBeenCalledWith(
    { type: "scheduledNotificationAck", id: "notice" },
    expect.any(Function),
  );
  h.channel.register(
    "profile",
    "replacement",
    Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(),
      disconnect: vi.fn(),
    }) as unknown as ChildProcess,
  );
  h.process.emit("message", { type: "scheduledNotification", notification });
  expect(notify).toHaveBeenCalledTimes(1);
});
it("does not acknowledge notices when desktop presentation is unavailable", () => {
  const h = setup(false, false, { notification: () => false });
  h.hello(["scheduled-notifications-v1"]);
  h.process.send.mockClear();
  h.process.emit("message", {
    type: "scheduledNotification",
    notification: { id: "n", title: "T", body: "B", taskId: "t", threadId: null },
  });
  expect(h.process.send).not.toHaveBeenCalled();
});
