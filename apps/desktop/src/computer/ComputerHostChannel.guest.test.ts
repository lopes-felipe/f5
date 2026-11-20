import { PassThrough } from "node:stream";
import { BackendFrameDecoder, encodeBackendFrame } from "@t3tools/shared/backendFrames";
import { describe, expect, it, vi } from "vitest";
import { streamBackendChannel } from "./BackendChannel";
import { ChromeProcessSupervisor, type ChromeProcessIo } from "./ChromeProcessSupervisor";
import type { ComputerController } from "./ComputerController";
import { ComputerHostChannel } from "./ComputerHostChannel";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";

/** A guest backend (Linux VM profile): framed stdio, no host pid, every integration certified. */
function guest(
  openExternalUrl?: (
    profileId: string,
    url: string,
    options?: { preapproved?: boolean },
  ) => Promise<"opened">,
) {
  const controller = {
    disconnect: vi.fn(),
    setPaused: vi.fn(),
    updateGrants: vi.fn(),
    lease: new ComputerLeaseAuthority(),
    invoke: vi.fn(),
    cancel: vi.fn(),
    acquire: vi.fn(),
    inputIdleMs: () => 10_000,
    takeoverIdle: () => ({ idle: true }),
    isPaused: () => false,
    drainBackground: vi.fn(async () => () => {}),
    takeoverReadiness: vi.fn(async () => ({ idleMs: 10_000 })),
    nativeWorkConflicts: vi.fn((_scope: unknown) => false),
    setAdmissionCheck: vi.fn(),
    cooperationAvailable: () => false,
    cooperation: { yielded: new Map() },
    prepareAcquisition: vi.fn(async () => {}),
    waitForTarget: vi.fn(async () => ({
      available: true,
      timedOut: false,
      requiresFreshObservation: true,
    })),
    turnEnded: vi.fn(),
  };
  const io: ChromeProcessIo = {
    snapshot: async () => [],
    killGroup: vi.fn(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    now: () => 0,
  };
  const supervisor = new ChromeProcessSupervisor({ io });
  const register = vi.spyOn(supervisor, "register");
  const channel = new ComputerHostChannel(
    controller as unknown as ComputerController,
    () => ({ available: true }),
    vi.fn(),
    {
      certified: () => true,
      builtinCertified: () => true,
      supervisor,
      verifyAdoption: async () => "verified",
    },
    undefined,
    { background: () => ({ available: true }), ...(openExternalUrl ? { openExternalUrl } : {}) },
  );
  const fromGuest = new PassThrough();
  const toGuest = new PassThrough();
  channel.registerChannel(
    "guest",
    "incarnation",
    streamBackendChannel({ input: fromGuest, output: toGuest }),
  );
  const decoder = new BackendFrameDecoder();
  const sent: Array<Record<string, unknown>> = [];
  toGuest.on("data", (chunk: Buffer) =>
    sent.push(...(decoder.push(chunk) as Array<Record<string, unknown>>)),
  );
  const emit = (message: unknown) => fromGuest.write(encodeBackendFrame(message));
  emit({
    type: "hello",
    profileId: "guest",
    backendIncarnation: "incarnation",
    protocolVersion: 1,
    capabilities: [
      "chrome-calls-v1",
      "chrome-call-admission-v1",
      "chrome-shared-v1",
      "open-external-url-v1",
    ],
  });
  const response = (requestId: string) => sent.find((message) => message.requestId === requestId);
  return { channel, controller, emit, response, register, toGuest, fromGuest };
}

const notCertified = { error: { _tag: "Unavailable", reason: "not-certified" } };

describe("guest backend channel", () => {
  it("refuses Chrome leases, validation and restore without a host pid", async () => {
    const h = guest();
    const holder = {
      profileId: "guest",
      threadId: "t",
      sessionGeneration: "s",
      provider: "claude",
    };
    h.emit({ type: "chromeLeaseAcquire", requestId: "acquire", holder });
    h.emit({ type: "chromeLeaseValidate", requestId: "validate", holder });
    h.emit({ type: "chromeRestoreAcquire", requestId: "restore", holder });
    await vi.waitFor(() => expect(h.response("restore")).toMatchObject(notCertified));
    expect(h.response("acquire")).toMatchObject(notCertified);
    expect(h.response("validate")).toMatchObject(notCertified);
    expect(h.channel.chrome.current()).toBeNull();
  });

  it("refuses Chrome process registration and adoption without a host pid", async () => {
    const h = guest();
    const identity = {
      profileId: "guest",
      backendIncarnation: "incarnation",
      threadId: "t",
      sessionGeneration: "s",
    };
    h.emit({
      type: "chromeProcessRegister",
      requestId: "register",
      registration: {
        ...identity,
        launchToken: "a",
        integration: "codex-chrome",
        pid: 100,
        pgid: 100,
        startTime: 1,
      },
    });
    h.emit({
      type: "chromeProcessAdopt",
      requestId: "adopt",
      adoption: {
        ...identity,
        launchToken: "b",
        integration: "codex-chrome",
        parentPid: 100,
        executable: "/usr/bin/node_repl",
      },
    });
    await vi.waitFor(() => expect(h.response("adopt")).toBeDefined());
    expect(h.response("register")).toMatchObject(notCertified);
    expect(h.response("adopt")).toMatchObject(notCertified);
    expect(h.register).not.toHaveBeenCalled();
  });

  it("refuses Sky's foreground lease without a host pid", async () => {
    const h = guest();
    const holder = {
      profileId: "guest",
      threadId: "t",
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
    h.emit({ type: "builtinLeaseAcquire", requestId: "sky", holder });
    await vi.waitFor(() => expect(h.response("sky")).toMatchObject(notCertified));
    expect(h.controller.lease.holders()).toEqual([]);
  });

  it("always prompts before opening a URL for a guest, even when it claims preapproval", async () => {
    const openExternalUrl = vi.fn(async () => "opened" as const);
    const h = guest(openExternalUrl);
    h.emit({
      type: "openExternalUrlRequest",
      id: "full-access",
      url: "https://example.com",
      preapproved: true,
    });
    await vi.waitFor(() =>
      expect(openExternalUrl).toHaveBeenCalledWith("guest", "https://example.com"),
    );
    expect(openExternalUrl).not.toHaveBeenCalledWith("guest", "https://example.com", {
      preapproved: true,
    });
  });

  it("drops the backend when the guest stream ends", async () => {
    const h = guest();
    const holder = {
      profileId: "guest",
      threadId: "t",
      sessionGeneration: "s",
      provider: "claude",
    };
    h.fromGuest.end();
    await vi.waitFor(() => expect(h.controller.disconnect).toHaveBeenCalled());
    h.emit({ type: "chromeLeaseAcquire", requestId: "after", holder });
    expect(h.response("after")).toBeUndefined();
  });

  it("rejects a hello naming another profile or incarnation", async () => {
    const controller = { lease: new ComputerLeaseAuthority(), disconnect: vi.fn() };
    const channel = new ComputerHostChannel(
      controller as unknown as ComputerController,
      () => ({ available: true }),
      vi.fn(),
    );
    for (const hello of [
      { profileId: "other", backendIncarnation: "incarnation" },
      { profileId: "guest", backendIncarnation: "stale" },
    ]) {
      const fromGuest = new PassThrough();
      const toGuest = new PassThrough();
      const finished = new Promise<void>((resolve) => toGuest.once("finish", () => resolve()));
      toGuest.resume();
      channel.registerChannel(
        "guest",
        "incarnation",
        streamBackendChannel({ input: fromGuest, output: toGuest }),
      );
      fromGuest.write(encodeBackendFrame({ type: "hello", protocolVersion: 1, ...hello }));
      await finished;
    }
  });
});
