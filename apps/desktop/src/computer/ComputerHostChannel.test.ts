import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ChromeProcessSupervisor, type ChromeProcessIo } from "./ChromeProcessSupervisor";
import { ComputerHostChannel } from "./ComputerHostChannel";
import { ComputerGrantAuthority } from "./ComputerGrantAuthority";
import { ComputerConsentStore } from "./ComputerConsentStore";
import type { ComputerController } from "./ComputerController";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
import { claudeTerminalTargets, type AlwaysAllowableIntegration } from "./IntegrationConsentStore";
function setup(
  certified = false,
  advertiseBackground?: boolean,
  options: {
    notification?: (
      profile: string,
      notice: import("@t3tools/contracts").DesktopScheduledNotification,
    ) => boolean;
    supervisor?: ChromeProcessSupervisor;
    verifyAdoption?: (parentPid: number, runtimePid: number) => Promise<string | undefined>;
    openExternalUrl?: (
      profileId: string,
      url: string,
    ) => Promise<import("@t3tools/contracts").OpenExternalUrlStatus>;
    cancelBrowserOpen?: (profileId: string) => void;
    alwaysAllowed?: (profileId: string, integration: AlwaysAllowableIntegration) => boolean;
    grants?: ComputerGrantAuthority;
    consents?: ComputerConsentStore;
    cooperation?: boolean;
    grantForgetFailed?: (profileId: string, message: string) => void;
  } = {},
) {
  const { notification, supervisor, verifyAdoption, alwaysAllowed } = options;
  const attention = vi.fn();
  const controller = {
    disconnect: vi.fn(),
    setPaused: vi.fn(),
    updateGrants: vi.fn(),
    lease: new ComputerLeaseAuthority(),
    invoke: vi.fn(),
    cancel: vi.fn(),
    acquire: vi.fn(),
    inputIdleMs: () => 10_000,
    isPaused: () => false,
    drainBackground: vi.fn(async () => () => {}),
    takeoverReadiness: vi.fn(async () => ({ idleMs: 10_000 })),
    nativeWorkConflicts: vi.fn(() => false),
    cooperationAvailable: () => options.cooperation === true,
    cooperation: { yielded: new Map() },
    prepareAcquisition: vi.fn(async () => {}),
    turnEnded: vi.fn(),
  };
  const channel = new ComputerHostChannel(
    controller as unknown as ComputerController,
    () => ({ available: true }),
    attention,
    {
      certified: () => certified,
      ...(supervisor ? { supervisor } : {}),
      ...(verifyAdoption ? { verifyAdoption } : {}),
      ...(alwaysAllowed ? { alwaysAllowed } : {}),
    },
    options.grants,
    {
      ...(options.openExternalUrl ? { openExternalUrl: options.openExternalUrl } : {}),
      ...(options.cancelBrowserOpen ? { cancelBrowserOpen: options.cancelBrowserOpen } : {}),
      ...(notification ? { notification } : {}),
      ...(options.grantForgetFailed ? { grantForgetFailed: options.grantForgetFailed } : {}),
      ...(options.consents ? { consents: options.consents } : {}),
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
  return { channel, controller, process, hello, attention };
}
describe("private computer host channel", () => {
  it("publishes new waiting states only to cooperative peers, including foreground-only peers", () => {
    const update = { threadId: "t", sessionGeneration: "s", state: "waiting-user" as const };
    const legacy = setup(false, true);
    const modern = setup(false, false, { cooperation: true });
    try {
      legacy.hello(["background-ax-v1"]);
      modern.hello(["computer-cooperation-v1"]);
      legacy.channel.sendExecutionState("profile", update);
      modern.channel.sendExecutionState("profile", update);
      expect(legacy.process.send).toHaveBeenLastCalledWith(
        {
          type: "executionStateChanged",
          ...update,
          state: "paused",
        },
        expect.any(Function),
      );
      expect(modern.process.send).toHaveBeenLastCalledWith(
        {
          type: "executionStateChanged",
          ...update,
        },
        expect.any(Function),
      );
      legacy.channel.sendExecutionState("profile", { ...update, state: "waiting-agent" });
      expect(legacy.process.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "waiting-idle",
        }),
        expect.any(Function),
      );
    } finally {
      legacy.channel.close();
      modern.channel.close();
    }
  });
  it("strips cooperative labels from unnegotiated holders and prepares native watches before acquisition", async () => {
    const holder = {
      profileId: "profile",
      threadId: "t",
      sessionGeneration: "s",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [],
      backend: "native" as const,
      threadTitle: "Thread",
      scope: { kind: "foreground" as const },
      policyRevision: 0,
    };
    for (const capable of [false, true]) {
      const h = setup(false, false, { cooperation: capable });
      try {
        h.hello(capable ? ["computer-cooperation-v1"] : []);
        h.controller.acquire.mockReturnValue({
          ...holder,
          ...(capable ? { cooperative: true } : {}),
        });
        h.process.emit("message", {
          type: "leaseAcquire",
          requestId: "acquire",
          cooperative: true,
          holder: { ...holder, cooperative: true },
        });
        await vi.waitFor(() => expect(h.controller.acquire).toHaveBeenCalled());
        expect(h.controller.acquire).toHaveBeenCalledWith({
          ...holder,
          ...(capable ? { cooperative: true } : {}),
        });
        expect(h.controller.prepareAcquisition).toHaveBeenCalledTimes(capable ? 1 : 0);
        if (capable)
          expect(h.controller.prepareAcquisition.mock.invocationCallOrder[0]).toBeLessThan(
            h.controller.acquire.mock.invocationCallOrder[0]!,
          );
      } finally {
        h.channel.close();
      }
    }
  });
  function rememberedHarness() {
    let contents: string | undefined;
    let failing = false;
    const io = {
      read: () => contents,
      write: (value: string) => {
        if (failing) throw new Error("disk full");
        contents = value;
      },
      remove: () => {
        if (failing) throw new Error("read-only");
        contents = undefined;
      },
    };
    const store = new ComputerConsentStore(io, () => Buffer.alloc(32, 7));
    const grants = new ComputerGrantAuthority("darwin", store);
    const h = setup(false, true, { grants, consents: store });
    h.hello([
      "background-ax-v1",
      "computer-remembered-consent-v1",
      "computer-session-lifecycle-v1",
    ]);
    const base = {
      projectId: "project",
      threadId: "thread",
      sessionGeneration: "session",
      reason: "Edit",
      apps: [],
    };
    const receive = (request: import("@t3tools/contracts").ComputerAccessRequested) =>
      h.process.emit("message", { type: "accessRequested", request });
    const answers = () =>
      h.process.send.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "accessAnswer")
        .map((message) => message.answer);
    return {
      ...h,
      store,
      grants,
      io,
      base,
      receive,
      answers,
      fail: () => {
        failing = true;
      },
    };
  }
  it("restores native app decisions after restart with fresh receipts and no notification", () => {
    const h = rememberedHarness();
    const policy = {
      version: 1 as const,
      kind: "app-access" as const,
      projectId: "project",
      appId: "com.apple.TextEdit",
      tier: "full" as const,
      allowTyping: false,
      policyVersion: 1 as const,
    };
    const request = {
      ...h.base,
      requestId: "native",
      kind: "apps" as const,
      apps: [{ appId: policy.appId, name: "TextEdit", tier: "full" as const }],
    };
    h.receive(request);
    h.channel.answerAccess(
      "profile",
      {
        requestId: "native",
        backendIncarnation: "incarnation",
        decisions: [{ appId: policy.appId, allow: true, allowTyping: false, remember: true }],
      },
      [policy],
    );
    const first = h.answers()[0]!;
    expect(first.persistence).toBe("durable");
    h.channel.close();
    const store = new ComputerConsentStore(h.io, () => Buffer.alloc(32, 7));
    const grants = new ComputerGrantAuthority("darwin", store);
    const restarted = setup(false, true, { grants, consents: store });
    restarted.hello(["background-ax-v1", "computer-remembered-consent-v1"]);
    restarted.process.emit("message", {
      type: "accessRequested",
      request: {
        ...request,
        requestId: "restored",
        threadId: "sibling",
        sessionGeneration: "new",
      },
    });
    const restored = restarted.process.send.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "accessAnswer").answer;
    expect(restored.decisions[0].receipt).toBeTruthy();
    expect(restored.decisions[0].receipt).not.toBe(first.decisions[0].receipt);
    expect(restarted.attention).not.toHaveBeenCalled();
    restarted.process.emit("message", {
      type: "grantsRemembered",
      requestId: "load",
      projectId: "project",
      profileId: "untrusted-other",
    });
    // Unknown extra fields are ignored by the decoder; identity remains the authenticated profile.
    expect(restarted.process.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "response",
        requestId: "load",
        result: [
          expect.objectContaining({
            projectId: "project",
            receipt: restored.decisions[0].receipt,
          }),
        ],
      }),
      expect.any(Function),
    );
    restarted.channel.close();
  });
  it("revokes an active app receipt and cancels its open native review before a failed disk removal", () => {
    const h = rememberedHarness();
    const policy = {
      version: 1 as const,
      kind: "app-access" as const,
      projectId: "project",
      appId: "com.apple.Terminal",
      tier: "click" as const,
      allowTyping: false,
      policyVersion: 1 as const,
    };
    const request = {
      ...h.base,
      requestId: "app",
      kind: "apps" as const,
      apps: [{ appId: policy.appId, name: "Terminal", tier: policy.tier }],
    };
    h.receive(request);
    h.channel.answerAccess(
      "profile",
      {
        requestId: "app",
        backendIncarnation: "incarnation",
        decisions: [{ appId: policy.appId, allow: true, allowTyping: false, remember: true }],
      },
      [policy],
    );
    const authorization = {
      profileId: "profile",
      projectId: "project",
      threadId: "thread",
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: h.grants.listRemembered("profile", "project"),
    };
    expect(h.grants.validate(authorization).grants).toHaveLength(1);
    h.receive({ ...request, requestId: "typing-review", typingRequested: true });
    const offered = {
      requestId: "typing-review",
      backendIncarnation: "incarnation",
      decisions: [],
    };
    expect(h.channel.accessRequest("profile", offered)).toMatchObject({
      requestId: "typing-review",
    });
    h.fail();
    expect(() => h.channel.revokeRemembered("profile", policy)).toThrow("restart could restore");
    expect(h.grants.validate(authorization).grants).toEqual([]);
    expect(h.controller.updateGrants).toHaveBeenCalledWith(expect.objectContaining({ grants: [] }));
    expect(() => h.channel.accessRequest("profile", offered)).toThrow("expired");
    expect(
      h.answers().find((answer) => answer.requestId === "typing-review")?.decisions[0].allow,
    ).toBe(false);
    h.channel.close();
  });
  it("auto-answers only covered project sessions and mints a separate session receipt", () => {
    const h = rememberedHarness();
    h.store.allow("profile", {
      version: 1,
      kind: "session-actions",
      projectId: "project",
      background: false,
      policyVersion: 1,
    });
    h.receive({ ...h.base, requestId: "foreground", kind: "session-actions" });
    expect(h.answers()).toHaveLength(1);
    expect(h.answers()[0].allowSessionActions).toBe(true);
    h.receive({
      ...h.base,
      requestId: "background-denied",
      kind: "session-actions",
      background: true,
    });
    expect(h.attention).toHaveBeenCalledTimes(1);
    h.store.allow("profile", {
      version: 1,
      kind: "session-actions",
      projectId: "project",
      background: true,
      policyVersion: 1,
    });
    h.channel.answerPendingRemembered("profile");
    expect(h.answers()[1].sessionReceipt).toBeTruthy();
    expect(
      h.channel.execution.hasSessionApproval("profile", "incarnation", "thread", "session"),
    ).toBe(true);
    h.process.emit("message", {
      type: "computerSessionClosed",
      threadId: "thread",
      sessionGeneration: "session",
    });
    expect(
      h.channel.execution.hasSessionApproval("profile", "incarnation", "thread", "session"),
    ).toBe(false);
    h.channel.close();
  });
  it("applies profile-wide session policy only to Full access background requests", () => {
    const h = rememberedHarness();
    h.store.allow("profile", { version: 1, kind: "full-access-session", policyVersion: 1 });
    for (const [requestId, fullAccess, background] of [
      ["normal", false, true],
      ["foreground", true, false],
      ["full", true, true],
    ] as const)
      h.receive({ ...h.base, requestId, fullAccess, background, kind: "session-actions" });
    expect(h.answers().map((answer) => answer.requestId)).toEqual(["full"]);
    expect(h.answers()[0].sessionReceipt).toBeTruthy();
    expect(h.attention).toHaveBeenCalledTimes(2);
    h.channel.close();
  });
  it("auto-answers Full access takeover policy only after its reservation exists", () => {
    const h = rememberedHarness();
    h.store.allow("profile", {
      version: 1,
      kind: "takeover",
      projectId: "project",
      appId: "com.apple.TextEdit",
      policyVersion: 1,
    });
    const takeover = {
      appId: "com.apple.TextEdit",
      threadId: "thread",
      turnId: "turn",
      reason: "Drag",
    };
    h.receive({
      ...h.base,
      requestId: "unreserved",
      kind: "foreground-takeover",
      fullAccess: true,
      takeover,
    });
    expect(h.answers()).toEqual([]);
    h.channel.execution.approveSession({
      profileId: "profile",
      backendIncarnation: "incarnation",
      threadId: "thread",
      sessionGeneration: "session",
      policyRevision: 0,
    });
    h.process.emit("message", {
      type: "foregroundTakeoverAcquire",
      requestId: "takeover",
      approvalRequestId: "reserved",
      holder: {
        profileId: "profile",
        projectId: "project",
        threadId: "thread",
        sessionGeneration: "session",
        turnId: "turn",
        executionGeneration: 1,
        grantVersion: 1,
        grants: [],
        backend: "native",
        threadTitle: "Thread",
        scope: { kind: "takeover", appId: "com.apple.TextEdit", approvalReceipt: "reserved" },
        policyRevision: 0,
      },
    });
    expect(h.channel.takeovers.awaitingConsent("profile", "reserved")).toBe(true);
    h.receive({
      ...h.base,
      requestId: "reserved",
      kind: "foreground-takeover",
      fullAccess: true,
      takeover,
    });
    expect(h.answers()).toEqual([
      expect.objectContaining({
        requestId: "reserved",
        allowForegroundTakeover: true,
      }),
    ]);
    expect(h.attention).toHaveBeenCalledTimes(1);
    h.channel.close();
  });
  it("keeps a failed write run-only and revokes it immediately even if deletion also fails", () => {
    const h = rememberedHarness();
    const policy = {
      version: 1 as const,
      kind: "session-actions" as const,
      projectId: "project",
      background: true,
      policyVersion: 1 as const,
    };
    h.receive({ ...h.base, requestId: "run-only", kind: "session-actions", background: true });
    h.fail();
    h.channel.answerAccess(
      "profile",
      {
        requestId: "run-only",
        backendIncarnation: "incarnation",
        decisions: [],
        allowSessionActions: true,
      },
      [policy],
    );
    expect(h.answers()[0]).toMatchObject({
      allowSessionActions: true,
      persistence: "session-only",
      persistenceReason: expect.any(String),
      sessionReceipt: expect.any(String),
    });
    expect(h.channel.rememberedConsents("profile")[0]?.persistence).toBe("session-only");
    h.receive({ ...h.base, requestId: "dialog", threadId: "normal", kind: "session-actions" });
    expect(() => h.channel.revokeRemembered("profile", policy)).toThrow("restart could restore");
    expect(
      h.channel.execution.hasSessionApproval("profile", "incarnation", "thread", "session"),
    ).toBe(false);
    expect(h.controller.setPaused).toHaveBeenCalledWith("profile", "thread", true);
    expect(h.process.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rememberedChanged",
        revokedSessions: expect.arrayContaining([
          { threadId: "thread", sessionGeneration: "session" },
        ]),
      }),
      expect.any(Function),
    );
    h.receive({ ...h.base, requestId: "after-revoke", kind: "session-actions", background: true });
    expect(h.answers().some((answer) => answer.requestId === "after-revoke")).toBe(false);
    h.channel.close();
  });
  it("reports a failed revocation without throwing out of the authenticated IPC listener", () => {
    let contents: string | undefined;
    let failing = false;
    const store = new ComputerConsentStore(
      {
        read: () => contents,
        write: (value) => {
          if (failing) throw new Error("disk full");
          contents = value;
        },
        remove: () => {
          if (failing) throw new Error("read-only");
          contents = undefined;
        },
      },
      () => Buffer.alloc(32, 7),
    );
    store.allow("profile", {
      version: 1,
      kind: "app-access",
      projectId: "project",
      appId: "com.apple.TextEdit",
      tier: "full",
      allowTyping: false,
      policyVersion: 1,
    });
    const grants = new ComputerGrantAuthority("darwin", store);
    const grantForgetFailed = vi.fn();
    const h = setup(false, false, { grants, grantForgetFailed });
    h.hello(["computer-grant-forget-v1"]);
    failing = true;
    const message = { type: "grantForget", projectId: "project", appId: "com.apple.TextEdit" };
    expect(() => h.process.emit("message", { ...message, requestId: "forget" })).not.toThrow();
    expect(h.process.send).toHaveBeenCalledWith(
      {
        type: "response",
        requestId: "forget",
        error: { _tag: "Execution", message: expect.stringContaining("restart could restore") },
      },
      expect.any(Function),
    );
    expect(grants.listRemembered("profile")).toEqual([]);
    expect(() => h.process.emit("message", message)).not.toThrow();
    expect(grantForgetFailed).toHaveBeenCalledWith(
      "profile",
      expect.stringContaining("restart could restore"),
    );
    failing = false;
    h.process.emit("message", { ...message, requestId: "retry" });
    expect(h.process.send).toHaveBeenCalledWith(
      {
        type: "response",
        requestId: "retry",
        result: {},
      },
      expect.any(Function),
    );
  });
  it("settles a failed multi-app issuance without retaining partial receipts", () => {
    const grants = new ComputerGrantAuthority("darwin");
    const request = {
      requestId: "limit",
      threadId: "thread",
      projectId: "project",
      sessionGeneration: "session",
      reason: "Test",
      kind: "apps" as const,
      apps: [{ appId: "com.apple.TextEdit", name: "TextEdit", tier: "full" as const }],
    };
    const decision = {
      appId: "com.apple.TextEdit",
      allow: true,
      allowTyping: false,
      remember: true,
    };
    const answer = { requestId: "limit", backendIncarnation: "incarnation", decisions: [decision] };
    for (let index = 0; index < 9999; index++)
      grants.issue("profile", { ...request, projectId: "project-" + index }, answer);
    const h = setup(false, false, { grants });
    h.hello();
    h.process.emit("message", {
      type: "accessRequested",
      request: {
        ...request,
        apps: [...request.apps, { appId: "com.apple.Notes", name: "Notes", tier: "full" }],
      },
    });
    expect(() =>
      h.channel.answerAccess("profile", {
        ...answer,
        decisions: [decision, { ...decision, appId: "com.apple.Notes" }],
      }),
    ).toThrow("limit");
    expect(grants.listRemembered("profile")).toHaveLength(9999);
    expect(h.process.send).toHaveBeenCalledWith(
      {
        type: "accessAnswer",
        answer: {
          ...answer,
          decisions: [
            { ...decision, allow: false, allowTyping: false, remember: false },
            {
              ...decision,
              appId: "com.apple.Notes",
              allow: false,
              allowTyping: false,
              remember: false,
            },
          ],
        },
      },
      expect.any(Function),
    );
    expect(() => h.channel.accessRequest("profile", answer)).toThrow("expired");
  });

  it("reclaims session receipts through negotiated host messages, retaining other sessions", () => {
    const grants = new ComputerGrantAuthority("darwin");
    const h = setup(false, false, { grants });
    h.hello(["computer-session-lifecycle-v1"]);
    const request = {
      requestId: "r",
      threadId: "thread",
      projectId: "project",
      sessionGeneration: "session",
      reason: "Test",
      kind: "apps" as const,
      apps: [{ appId: "com.apple.TextEdit", name: "TextEdit", tier: "full" as const }],
    };
    const answer = {
      requestId: "r",
      backendIncarnation: "incarnation",
      decisions: [
        { appId: "com.apple.TextEdit", allow: true, allowTyping: false, remember: false },
      ],
    };
    const issued = grants.issue("profile", request, answer);
    const grant = {
      appId: "com.apple.TextEdit",
      tier: "full" as const,
      allowTyping: false,
      receipt: issued.decisions[0]!.receipt!,
    };
    const authorization = {
      profileId: "profile",
      threadId: "thread",
      projectId: "project",
      sessionGeneration: "session",
      turnId: "turn",
      executionGeneration: 1,
      grantVersion: 1,
      grants: [grant],
    };
    expect(grants.validate(authorization).grants).toHaveLength(1);
    h.process.emit("message", {
      type: "computerSessionClosed",
      threadId: "thread",
      sessionGeneration: "old",
    });
    expect(grants.validate(authorization).grants).toHaveLength(1);
    h.process.emit("message", {
      type: "computerSessionClosed",
      threadId: "thread",
      sessionGeneration: "session",
    });
    expect(grants.validate(authorization).grants).toEqual([]);
  });
  it("negotiates browser opening and routes the correlated result to its owning backend", async () => {
    const openExternalUrl = vi.fn(async () => "opened" as const);
    const cancelBrowserOpen = vi.fn();
    const h = setup(false, false, { openExternalUrl, cancelBrowserOpen });
    h.hello(["open-external-url-v1"]);
    expect(h.process.send).toHaveBeenCalledWith(
      {
        type: "hostCapabilities",
        capabilities: ["open-external-url-v1"],
      },
      expect.any(Function),
    );
    h.process.emit("message", {
      type: "openExternalUrlRequest",
      id: "login",
      url: "https://example.com",
    });
    await vi.waitFor(() =>
      expect(h.process.send).toHaveBeenCalledWith(
        {
          type: "openExternalUrlResult",
          id: "login",
          status: "opened",
        },
        expect.any(Function),
      ),
    );
    expect(openExternalUrl).toHaveBeenCalledWith("profile", "https://example.com");
    h.process.emit("message", {
      type: "openExternalUrlRequest",
      id: "full-access",
      url: "https://example.com",
      preapproved: true,
    });
    await vi.waitFor(() =>
      expect(openExternalUrl).toHaveBeenLastCalledWith("profile", "https://example.com", {
        preapproved: true,
      }),
    );
    h.process.emit("disconnect");
    expect(cancelBrowserOpen).toHaveBeenCalledWith("profile");
  });
  it("never forwards an unnegotiated browser request", () => {
    const openExternalUrl = vi.fn(async () => "opened" as const);
    const h = setup(false, false, { openExternalUrl });
    h.hello();
    h.process.emit("message", {
      type: "openExternalUrlRequest",
      id: "login",
      url: "https://example.com",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
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
  it("adopts Codex's node_repl for its own backend and stops it on request", async () => {
    const NODE_REPL = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl";
    const killGroup = vi.fn();
    const io: ChromeProcessIo = {
      snapshot: async () => [
        { pid: 50, ppid: 1, pgid: 50, startTime: 0, zombie: false, command: "/bin/server" },
        { pid: 60, ppid: 50, pgid: 60, startTime: 0, zombie: false, command: "/bin/codex" },
        { pid: 70, ppid: 60, pgid: 70, startTime: 1_000, zombie: false, command: NODE_REPL },
      ],
      killGroup,
      setTimeout: (run) => {
        run();
        return 0;
      },
      clearTimeout: () => {},
      now: () => 0,
    };
    const supervisor = new ChromeProcessSupervisor({ io });
    const verifyAdoption = vi.fn(async () => undefined);
    const h = setup(true, undefined, { supervisor, verifyAdoption });
    h.hello();
    const adoption = {
      profileId: "profile",
      backendIncarnation: "incarnation",
      threadId: "thread",
      sessionGeneration: "s",
      launchToken: "adopted",
      integration: "codex-chrome",
      parentPid: 60,
      executable: NODE_REPL,
    };
    const response = (requestId: string) =>
      h.process.send.mock.calls.find(([message]) => message.requestId === requestId)?.[0];
    h.process.emit("message", { type: "chromeProcessAdopt", requestId: "adopt", adoption });
    await vi.waitFor(() =>
      expect(response("adopt")).toMatchObject({ result: { pid: 70, pgid: 70 } }),
    );
    expect(verifyAdoption).toHaveBeenCalledWith(60, 70);
    // Another incarnation's token stops nothing; the backend's own does.
    h.process.emit("message", { type: "chromeProcessStop", launchToken: "other" });
    expect(killGroup).not.toHaveBeenCalled();
    h.process.emit("message", { type: "chromeProcessStop", launchToken: "adopted" });
    await vi.waitFor(() => expect(killGroup).toHaveBeenCalledWith(70, "SIGTERM"));
  });
  it("gives an idle or turned-off runtime the graceful stop", async () => {
    const NODE_REPL = "/node_repl";
    const timers: Array<{ run: () => void; ms: number }> = [];
    const killGroup = vi.fn();
    const io: ChromeProcessIo = {
      snapshot: async () => [
        { pid: 50, ppid: 1, pgid: 50, startTime: 0, zombie: false, command: "/bin/server" },
        { pid: 60, ppid: 50, pgid: 60, startTime: 0, zombie: false, command: "codex" },
        { pid: 70, ppid: 60, pgid: 70, startTime: 1_000, zombie: false, command: NODE_REPL },
      ],
      killGroup,
      setTimeout: (run, ms) => {
        timers.push({ run, ms });
        return timers.length;
      },
      clearTimeout: () => {},
      now: () => 0,
    };
    const supervisor = new ChromeProcessSupervisor({ io });
    const h = setup(true, undefined, { supervisor, verifyAdoption: async () => undefined });
    h.hello();
    h.process.emit("message", {
      type: "chromeProcessAdopt",
      requestId: "adopt",
      adoption: {
        profileId: "profile",
        backendIncarnation: "incarnation",
        threadId: "thread",
        sessionGeneration: "s",
        launchToken: "adopted",
        integration: "codex-chrome",
        parentPid: 60,
        executable: NODE_REPL,
      },
    });
    await vi.waitFor(() => expect(supervisor.registrations()).toHaveLength(1));
    h.process.emit("message", {
      type: "chromeProcessStop",
      launchToken: "adopted",
      reason: "release",
    });
    // The graceful window comes first: nothing is signalled yet.
    await vi.waitFor(() => expect(timers.some((timer) => timer.ms === 2_000)).toBe(true));
    expect(killGroup).not.toHaveBeenCalled();
  });
  it("refuses adoption while Codex Chrome is uncertified", async () => {
    const supervisor = new ChromeProcessSupervisor();
    const h = setup(false, undefined, { supervisor, verifyAdoption: async () => undefined });
    h.hello();
    h.process.emit("message", {
      type: "chromeProcessAdopt",
      requestId: "adopt",
      adoption: {
        profileId: "profile",
        backendIncarnation: "incarnation",
        threadId: "thread",
        sessionGeneration: "s",
        launchToken: "adopted",
        integration: "codex-chrome",
        parentPid: 60,
        executable: "/node_repl",
      },
    });
    await vi.waitFor(() =>
      expect(h.process.send).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "adopt",
          error: { _tag: "Unavailable", reason: "not-certified" },
        }),
        expect.any(Function),
      ),
    );
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
  describe("idle Chrome leases in other profiles' banners", () => {
    const holder = {
      profileId: "profile",
      threadId: "private-thread",
      sessionGeneration: "private-generation",
      provider: "codex" as const,
    };
    const calls = (running: boolean | null, threadId = holder.threadId) => ({
      type: "chromeCallsChanged",
      threadId,
      sessionGeneration: holder.sessionGeneration,
      running,
    });
    const twoProfiles = (supervisor?: ChromeProcessSupervisor, capabilities = true) => {
      const h = setup(true, undefined, supervisor ? { supervisor } : {});
      h.hello(capabilities ? ["chrome-call-activity-v1"] : undefined);
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
        capabilities: ["chrome-call-activity-v1"],
      });
      const leases = () =>
        other.send.mock.calls
          .map(([message]) => message as { type: string; otherProfile?: boolean })
          .filter((message) => message.type === "chromeLeaseChanged")
          .map((message) => message.otherProfile);
      return { ...h, other, leases };
    };

    it("echoes the capability only to backends that advertise it", () => {
      const h = twoProfiles();
      expect(h.process.send).toHaveBeenCalledWith(
        { type: "hostCapabilities", capabilities: ["chrome-call-activity-v1"] },
        expect.any(Function),
      );
      const legacy = setup(true);
      legacy.hello();
      expect(
        legacy.process.send.mock.calls.some(
          ([message]) => (message as { type: string }).type === "hostCapabilities",
        ),
      ).toBe(false);
    });

    it("counts an unreported lease as control, and an idle one as none", () => {
      const h = twoProfiles();
      h.channel.chrome.acquire(holder, null);
      expect(h.leases()).toEqual([true]);
      h.process.emit("message", calls(false));
      expect(h.leases()).toEqual([true, false]);
      h.process.emit("message", calls(true));
      expect(h.leases()).toEqual([true, false, true]);
      // An unchanged answer republishes nothing.
      h.process.emit("message", calls(true));
      expect(h.leases()).toEqual([true, false, true]);
      h.process.emit("message", calls(null));
      expect(h.leases()).toEqual([true, false, true]);
      expect(JSON.stringify(h.other.send.mock.calls)).not.toContain("private");
    });

    it("applies a report made before the lease is acquired", () => {
      const h = twoProfiles();
      h.process.emit("message", calls(false));
      expect(h.leases()).toEqual([]);
      h.channel.chrome.acquire(holder, null);
      expect(h.leases()).toEqual([false]);
    });

    it("ignores reports for other threads and from other profiles", () => {
      const h = twoProfiles();
      h.channel.chrome.acquire(holder, null);
      h.process.emit("message", calls(false, "another-thread"));
      h.other.emit("message", calls(false));
      expect(h.leases()).toEqual([true]);
    });

    it("forgets a report when its lease ends or its backend disconnects", () => {
      const h = twoProfiles();
      h.process.emit("message", calls(false));
      h.channel.chrome.acquire(holder, null);
      h.channel.chrome.release(holder);
      h.channel.chrome.acquire(holder, null);
      expect(h.leases()).toEqual([false, false, true]);
      h.channel.chrome.release(holder);
      // A report waiting for its lease goes with its backend.
      h.process.emit("message", calls(false));
      h.process.emit("disconnect");
      h.channel.chrome.acquire(holder, null);
      expect(h.leases()).toEqual([false, false, true, false, true]);
    });

    it("ignores reports from a backend that didn't negotiate them", () => {
      const h = twoProfiles(undefined, false);
      h.channel.chrome.acquire(holder, null);
      h.process.emit("message", calls(false));
      expect(h.leases()).toEqual([true]);
      expect(h.process.disconnect).not.toHaveBeenCalled();
    });

    /** A registered group that outlives its release: the lease drains. */
    const lingeringGroup = () => {
      const alive = { value: true };
      const supervisor = {
        alive: () => alive.value,
        stop: vi.fn(),
        recoveryRequired: () => false,
        invalidated: () => false,
      } as unknown as ChromeProcessSupervisor;
      return { alive, supervisor };
    };

    it("shows a draining lease as control once its backend is gone", () => {
      const group = lingeringGroup();
      const h = twoProfiles(group.supervisor);
      h.channel.chrome.acquire(holder, null);
      h.process.emit("message", calls(false));
      expect(h.leases()).toEqual([true, false]);
      h.process.emit("disconnect");
      // Still draining with nothing left to gate it: unknown, so busy.
      expect(h.channel.chrome.current()).not.toBeNull();
      expect(h.leases()).toEqual([true, false, true]);
      group.alive.value = false;
      h.channel.chrome.processExited();
      expect(h.leases()).toEqual([true, false, true, false]);
    });

    it("keeps an idle lease hidden while its owner's own release drains", () => {
      // The owner's banner hides the idle runtime while it exits, so other profiles do too.
      const group = lingeringGroup();
      const h = twoProfiles(group.supervisor);
      h.channel.chrome.acquire(holder, null);
      h.process.emit("message", calls(false));
      h.process.emit("message", {
        type: "chromeLeaseRelease",
        requestId: "release",
        holder,
      });
      expect(h.channel.chrome.current()).not.toBeNull();
      expect(h.leases()).toEqual([true, false]);
      group.alive.value = false;
      h.channel.chrome.processExited();
      expect(h.leases()).toEqual([true, false, false]);
    });
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
  it("answers a session request the profile always allows, and asks for everything else", () => {
    const alwaysAllowed = vi.fn(
      (profileId: string, integration: string) =>
        profileId === "profile" && integration === "codex-chrome",
    );
    const h = setup(false, undefined, { alwaysAllowed });
    h.hello();
    const session = (requestId: string, integration: "codex-chrome" | "codex-computer") => ({
      type: "accessRequested",
      request: {
        requestId,
        threadId: "t",
        sessionGeneration: "s",
        reason: "Allow this provider integration for this session?",
        kind: "chrome-session",
        chromeSession: { integration },
        apps: [],
      },
    });
    h.process.emit("message", session("chrome", "codex-chrome"));
    expect(sent(h).at(-1)).toEqual({
      type: "accessAnswer",
      answer: {
        requestId: "chrome",
        backendIncarnation: "incarnation",
        decisions: [],
        allowChromeSession: true,
      },
    });
    expect(h.attention).not.toHaveBeenCalled();
    h.process.emit("message", session("computer", "codex-computer"));
    expect(h.attention).toHaveBeenCalledOnce();
    // Other kinds never consult the grant.
    h.process.emit("message", {
      type: "accessRequested",
      request: {
        requestId: "setup",
        threadId: "t",
        reason: "r",
        kind: "chrome-setup",
        apps: [],
      },
    });
    expect(h.attention).toHaveBeenCalledTimes(2);
    // Only Codex Chrome can be always allowed: Computer Use never consults the grant.
    expect(alwaysAllowed).toHaveBeenCalledTimes(1);
  });
  it("answers a Claude in Chrome setup request the profile always allows", () => {
    let allowed: AlwaysAllowableIntegration | undefined;
    const h = setup(false, undefined, {
      alwaysAllowed: (_profile, integration) => integration === allowed,
    });
    h.hello();
    const setupRequest = (
      requestId: string,
      provider: "claude" | "codex",
      previousTargets = [claudeTerminalTargets()[0]!],
    ) => ({
      type: "accessRequested",
      request: {
        requestId,
        threadId: requestId,
        sessionGeneration: "s",
        reason: "r",
        kind: "chrome-setup",
        chromeSetup: { provider, previousTargets, targetPath: "/f5/wrapper" },
        apps: [],
      },
    });
    // A Codex Chrome grant doesn't cover Claude's setup.
    allowed = "codex-chrome";
    h.process.emit("message", setupRequest("before", "claude"));
    expect(h.attention).toHaveBeenCalledOnce();
    allowed = "claude-chrome";
    h.process.emit("message", setupRequest("claude", "claude"));
    expect(sent(h).at(-1)).toEqual({
      type: "accessAnswer",
      answer: {
        requestId: "claude",
        backendIncarnation: "incarnation",
        decisions: [],
        allowChromeSetup: true,
      },
    });
    // Ticking the box answers the one already waiting.
    h.channel.answerPendingAlwaysAllowed("profile");
    expect(
      sent(h)
        .filter((message) => message.type === "accessAnswer")
        .map((message) => (message as { answer: { requestId: string } }).answer.requestId),
    ).toEqual(["claude", "before"]);
    // Replacing another F5 profile's registration always asks, grant or not.
    h.process.emit(
      "message",
      setupRequest("other-profile", "claude", ["/other-profile/claude/chrome/chrome-native-host"]),
    );
    expect(h.attention).toHaveBeenCalledTimes(2);
    h.channel.answerPendingAlwaysAllowed("profile");
    expect(sent(h).filter((message) => message.type === "accessAnswer")).toHaveLength(2);
  });
  it("answers the profile's waiting Codex Chrome requests once it chooses always allow", () => {
    let allowed = false;
    const h = setup(false, undefined, { alwaysAllowed: () => allowed });
    h.hello();
    const session = (requestId: string, integration: "codex-chrome" | "codex-computer") => ({
      type: "accessRequested",
      request: {
        requestId,
        threadId: requestId,
        sessionGeneration: "s",
        reason: "r",
        kind: "chrome-session",
        chromeSession: { integration },
        apps: [],
      },
    });
    h.process.emit("message", session("a", "codex-chrome"));
    h.process.emit("message", session("b", "codex-chrome"));
    h.process.emit("message", session("c", "codex-computer"));
    expect(h.attention).toHaveBeenCalledTimes(3);
    allowed = true;
    h.channel.answerPendingAlwaysAllowed("profile");
    const answered = sent(h)
      .filter((message) => message.type === "accessAnswer")
      .map((message) => (message as { answer: { requestId: string } }).answer.requestId);
    expect(answered).toEqual(["a", "b"]);
    // Answered once: a repeat finds nothing waiting.
    h.channel.answerPendingAlwaysAllowed("profile");
    expect(sent(h).filter((message) => message.type === "accessAnswer")).toHaveLength(2);
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
