import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { computerRequestPayload } from "@t3tools/shared/computerControl";
import { describe, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder, DesktopComputerHostMessage } from "@t3tools/contracts";
import {
  ComputerAutomationBrokerRuntime,
  type ComputerInvocationContext,
} from "./ComputerAutomationBroker";
import { DesktopComputerHost } from "./DesktopComputerHost";

class Ipc extends EventEmitter {
  connected = true;
  messages: DesktopComputerHostMessage[] = [];
  holdRequests = false;
  appResults: unknown[] | undefined;
  inspectResults: unknown[] = [];
  busy = false;
  send(raw: unknown, callback: (error: Error | null) => void) {
    const message = raw as DesktopComputerHostMessage;
    this.messages.push(message);
    callback(null);
    if (message.type === "hello")
      queueMicrotask(() =>
        this.emit("message", {
          type: "status",
          status: { available: true, passwordMaskingSupported: true },
        }),
      );
    if (message.type === "leaseAcquire")
      queueMicrotask(() =>
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ...(this.busy
            ? { error: { _tag: "Busy", holder: "other-profile" } }
            : {
                result: { ...message.holder, executionGeneration: 7 } satisfies ComputerLeaseHolder,
              }),
        }),
      );
    if (message.type === "observationInvalidate")
      queueMicrotask(() =>
        this.emit("message", { type: "response", requestId: message.requestId, result: {} }),
      );
    if (message.type === "request" && !this.holdRequests)
      queueMicrotask(() =>
        this.emit("message", {
          type: "response",
          requestId: message.request.requestId,
          result:
            message.request.op === "inspect" && this.inspectResults.length
              ? this.inspectResults.shift()
              : message.request.op === "resolveApps" && this.appResults
                ? this.appResults
                : { ok: true },
        }),
      );
    return true;
  }
  finish(result: unknown = { ok: true }) {
    const request = this.messages.findLast((message) => message.type === "request");
    if (request?.type === "request")
      this.emit("message", {
        type: "response",
        requestId: request.request.requestId,
        result,
      });
  }
}
async function harness() {
  const ipc = new Ipc();
  const host = new DesktopComputerHost("p", "backend", ipc, true);
  let context: ComputerInvocationContext = {
    threadId: "t",
    sessionGeneration: "s",
    projectId: "project",
    turnId: "turn",
    provider: "claude",
    runtimeMode: "full-access",
    interactionMode: "default",
    threadTitle: "Thread",
    policy: {
      previewAutomation: true,
      externalHosts: [],
      computerUse: true,
      claudeInChrome: false,
      codexChrome: false,
    },
  };
  const broker = new ComputerAutomationBrokerRuntime(host, {
    resolve: async (_thread, generation) => ({ ...context, sessionGeneration: generation }),
    platform: "darwin",
    storage: {
      load: async () => [
        { projectId: "project", appId: "com.apple.TextEdit", tier: "full", allowTyping: false },
      ],
      save: async () => {},
    },
  });
  await broker.initialize();
  broker.bindSession("t", "s", "claude");
  await Promise.resolve();
  return {
    broker,
    ipc,
    set: (patch: Partial<ComputerInvocationContext>) => {
      context = { ...context, ...patch };
    },
  };
}
describe("computer broker safety boundaries", () => {
  it("keeps action success but discards a late capture after a masking change", async () => {
    const h = await harness();
    try {
      h.ipc.holdRequests = true;
      const pending = h.broker.invoke("t", "s", { op: "type", text: "x", screenshot: true });
      await vi.waitFor(() => expect(h.ipc.messages.some((m) => m.type === "request")).toBe(true));
      const ctx = await h.broker.context("t", "s");
      await h.broker.policyTransition(async () => {
        h.set({ policy: { ...ctx.policy, computerUsePasswordMasking: "conservative" } });
      });
      h.ipc.finish({ actionCompleted: true, screenshot: { data: "old-policy-image" } });
      await expect(pending).resolves.toEqual({
        actionCompleted: true,
        screenshotError: "Interrupted",
      });
      expect(h.ipc.messages.filter((m) => m.type === "request")).toHaveLength(1);
    } finally {
      h.broker.close();
    }
  });
  it("omits masking policy for legacy helpers, including caller-supplied overrides", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", { type: "status", status: { available: true } });
      await h.broker.invoke("t", "s", {
        op: "screenshot",
        displayId: "d",
        passwordMasking: "fast",
      });
      const message = h.ipc.messages.findLast((m) => m.type === "request");
      if (message?.type !== "request") throw new Error("missing request");
      expect(message.request).not.toHaveProperty("passwordMasking");
    } finally {
      h.broker.close();
    }
  });
  it.each(["fast", "conservative"] as const)(
    "injects user masking policy before hashing every capture path (%s)",
    async (mode) => {
      const h = await harness();
      try {
        if (mode === "conservative") {
          const ctx = await h.broker.context("t", "s");
          h.set({ policy: { ...ctx.policy, computerUsePasswordMasking: mode } });
        }
        for (const input of [
          { op: "screenshot", displayId: "d" },
          { op: "zoom", displayId: "d", rect: { x: 0, y: 0, width: 10, height: 10 } },
          { op: "type", text: "x", screenshot: true },
        ] as const) {
          await h.broker.invoke("t", "s", {
            ...input,
            passwordMasking: mode === "fast" ? "conservative" : "fast",
          });
          const message = h.ipc.messages.findLast((m) => m.type === "request");
          if (message?.type !== "request") throw new Error("missing request");
          const { payloadHash, ...request } = message.request;
          expect(request.passwordMasking).toBe(mode);
          expect(payloadHash).toBe(
            createHash("sha256").update(computerRequestPayload(request)).digest("hex"),
          );
          expect(payloadHash).not.toBe(
            createHash("sha256")
              .update(
                computerRequestPayload({
                  ...request,
                  passwordMasking: mode === "fast" ? "conservative" : "fast",
                }),
              )
              .digest("hex"),
          );
        }
      } finally {
        h.broker.close();
      }
    },
  );
  it("discards old observations and applies a masking change without restarting", async () => {
    const h = await harness();
    const events = vi.fn();
    h.broker.subscribe(events);
    try {
      h.ipc.holdRequests = true;
      const pending = h.broker.invoke("t", "s", { op: "screenshot", displayId: "d" });
      const rejected = expect(pending).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "access-changed" },
      });
      await vi.waitFor(() => expect(h.ipc.messages.some((m) => m.type === "request")).toBe(true));
      const ctx = await h.broker.context("t", "s");
      await h.broker.policyTransition(async () => {
        h.set({ policy: { ...ctx.policy, computerUsePasswordMasking: "conservative" } });
      });
      expect(
        events.mock.calls.some(([event]) => event.channel === "computer.observations.invalidated"),
      ).toBe(true);
      expect(h.ipc.messages.some((m) => m.type === "cancel")).toBe(true);
      h.ipc.finish();
      await rejected;
      h.ipc.holdRequests = false;
      await h.broker.invoke("t", "s", { op: "screenshot", displayId: "d" });
      expect(h.ipc.messages.findLast((m) => m.type === "request")).toMatchObject({
        request: { passwordMasking: "conservative" },
      });
      // Refreshing unchanged policy must not revoke it again.
      events.mockClear();
      await h.broker.refreshPolicies();
      expect(
        events.mock.calls.some(([event]) => event.channel === "computer.observations.invalidated"),
      ).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("reports full-tier typing rights without changing the stored click-tier flag", async () => {
    const h = await harness();
    h.ipc.appResults = [
      {
        appId: "com.apple.TextEdit",
        name: "TextEdit",
        tier: "full",
        running: true,
        frontmost: false,
      },
    ];
    try {
      const result = await h.broker.requestAccess(
        "t",
        "s",
        ["com.apple.TextEdit"],
        "Synthetic typing test",
        true,
      );
      expect(result).toMatchObject({
        grants: [
          { appId: "com.apple.TextEdit", tier: "full", allowTyping: false, typingAllowed: true },
        ],
        apps: [{ status: "already-granted" }],
      });
      expect(h.broker.access.grants("t")).toEqual([
        { appId: "com.apple.TextEdit", tier: "full", allowTyping: false },
      ]);
      expect(h.ipc.messages.some((message) => message.type === "accessRequested")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("publishes tool-boundary outcome codes only for the matching session", async () => {
    const h = await harness();
    const events = vi.fn();
    h.broker.subscribe(events);
    try {
      h.broker.reportToolFailure("t", "old-session", "elementAction", "app-resolution-failed");
      expect(events).not.toHaveBeenCalled();
      h.broker.reportToolFailure("t", "s", "elementAction", "app-resolution-failed");
      expect(events).toHaveBeenCalledExactlyOnceWith({
        channel: "computer.activity",
        data: {
          threadId: "t",
          backend: "native",
          source: "tool",
          op: "elementAction",
          status: "failed",
          outcome: "app-resolution-failed",
        },
      });
    } finally {
      h.broker.close();
    }
  });
  it("allows remote preview resume when computer tools were installed but never used", async () => {
    const h = await harness();
    try {
      h.broker.setPaused("t", true);
      h.ipc.emit("message", {
        type: "status",
        status: { available: false, reason: "helper-missing" },
      });
      expect(() => h.broker.assertRemoteResumeAllowed("t")).not.toThrow();
      expect(() => h.broker.setPaused("t", false)).not.toThrow();
    } finally {
      h.broker.close();
    }
  });
  it("returns turn-ended when a session is released during context resolution", async () => {
    const h = await harness();
    try {
      const pending = h.broker.invoke("t", "s", { op: "listApps" });
      h.broker.releaseSession("t", "s");
      await expect(pending).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "turn-ended" },
      });
      expect(h.broker.access.grants("t")).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("keeps native pause authoritative and refuses remote resume", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", { type: "pauseChanged", threadId: "t", paused: true });
      expect(() => h.broker.assertRemoteResumeAllowed("t")).toThrow("computer running F5");
      expect(() => h.broker.setPaused("t", false)).toThrow("computer running F5");
      expect(h.broker.pause.has("t")).toBe(true);
      expect(h.ipc.messages.some((message) => message.type === "resumeRequested")).toBe(false);
      h.ipc.emit("message", { type: "pauseChanged", threadId: "t", paused: false });
      expect(h.broker.pause.has("t")).toBe(false);
      expect(() => h.broker.assertRemoteResumeAllowed("preview-only")).not.toThrow();
    } finally {
      h.broker.close();
    }
  });
  it("rejects keyboard mutation before acquiring a lease when no grant permits typing", async () => {
    const h = await harness();
    try {
      await h.broker.invoke("t", "s", { op: "listApps" });
      h.broker.access.revoke("t", "com.apple.TextEdit");
      for (const input of [
        { op: "type" as const, text: "x" },
        { op: "key" as const, chords: ["ENTER"] },
      ])
        await expect(h.broker.invoke("t", "s", input)).rejects.toMatchObject({
          error: { _tag: "NotGranted", needed: "type" },
        });
      expect(h.ipc.messages.some((message) => message.type === "leaseAcquire")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("does not prompt for ambiguous app matches or grant every fuzzy match", async () => {
    const h = await harness();
    try {
      h.ipc.appResults = [
        { appId: "code", name: "Code", tier: "click", running: true, frontmost: false },
        { appId: "xcode", name: "Xcode", tier: "click", running: true, frontmost: false },
      ];
      const result = await h.broker.requestAccess("t", "s", ["co"], "Edit code");
      expect(result).toMatchObject({
        apps: [
          { query: "co", status: "ambiguous", matches: [{ appId: "code" }, { appId: "xcode" }] },
        ],
      });
      expect(h.ipc.messages.some((message) => message.type === "accessRequested")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("keeps Chrome consent separate from computer grants and rechecks its own policy", async () => {
    const h = await harness();
    try {
      h.set({
        policy: {
          previewAutomation: true,
          externalHosts: [],
          computerUse: false,
          claudeInChrome: true,
          codexChrome: false,
        },
      });
      const consent = h.broker.requestChromeSetup("t", "s", {
        provider: "claude",
        previousTargets: ["old"],
        targetPath: "new",
      });
      const request = h.ipc.messages.findLast((m) => m.type === "accessRequested");
      if (request?.type !== "accessRequested") throw new Error("missing setup request");
      await h.broker.refreshPolicies();
      h.ipc.emit("message", {
        type: "accessAnswer",
        answer: {
          requestId: request.request.requestId,
          backendIncarnation: "old",
          decisions: [],
          allowChromeSetup: true,
        },
      });
      expect(
        h.ipc.messages.some(
          (m) => m.type === "cancel" && m.requestId === request.request.requestId,
        ),
      ).toBe(false);
      h.ipc.emit("message", {
        type: "accessAnswer",
        answer: {
          requestId: request.request.requestId,
          backendIncarnation: "backend",
          decisions: [],
          allowChromeSetup: true,
          allowSessionActions: true,
        },
      });
      expect(await consent).toBe(true);
      expect(h.broker.access.actionsApproved("t")).toBe(false);
      const next = h.broker.requestChromeSetup("t", "s", {
        provider: "claude",
        previousTargets: [],
        targetPath: "new",
      });
      h.set({
        policy: {
          previewAutomation: true,
          externalHosts: [],
          computerUse: false,
          claudeInChrome: false,
          codexChrome: false,
        },
      });
      await h.broker.refreshPolicies();
      expect(await next).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("disposing native tools leaves the Chrome lease to the provider exit finalizer", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", {
        type: "chromeLeaseChanged",
        holder: { profileId: "p", threadId: "t", sessionGeneration: "s", provider: "claude" },
      });
      h.broker.releaseSession("t", "s");
      expect(h.ipc.messages.some((message) => message.type === "chromeLeaseRelease")).toBe(false);
      expect(h.broker.snapshot().chromeHolder?.threadId).toBe("t");
    } finally {
      h.broker.close();
    }
  });
  it("restores anonymous contention and paused controls in a reconnect snapshot", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", { type: "leaseChanged", holder: null, otherProfile: true });
      h.broker.setPaused("t", true);
      expect(h.broker.snapshot()).toMatchObject({
        holders: [],
        computerUse: { holders: [], otherProfile: true },
        otherProfile: true,
        pausedThreads: ["t"],
      });
    } finally {
      h.broker.close();
    }
  });
  it("ignores a kill notification for an older session or completed turn", async () => {
    const h = await harness();
    const events: unknown[] = [];
    const off = h.broker.subscribe((event) => events.push(event));
    try {
      await h.broker.invoke("t", "s", { op: "type", text: "x" });
      events.length = 0;
      h.ipc.emit("message", {
        type: "killSwitch",
        threadId: "t",
        sessionGeneration: "old",
        turnId: "turn",
      });
      expect(events).toEqual([]);
      h.broker.endTurn("t", "turn", "s");
      events.length = 0;
      h.ipc.emit("message", {
        type: "killSwitch",
        threadId: "t",
        sessionGeneration: "s",
        turnId: "turn",
      });
      expect(events).toEqual([]);
    } finally {
      off();
      h.broker.close();
    }
  });
  it("rechecks live policy, plan mode and pause before acquiring the device", async () => {
    const h = await harness();
    try {
      h.set({ interactionMode: "plan" });
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toThrow(
        "plan mode",
      );
      await expect(h.broker.invoke("t", "s", { op: "listApps" })).resolves.toEqual({ ok: true });
      h.set({ interactionMode: "default" });
      h.broker.setPaused("t", true);
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Interrupted" },
      });
      expect(h.ipc.messages.filter((m) => m.type === "leaseAcquire")).toHaveLength(0);
    } finally {
      h.broker.close();
    }
  });
  it("reports cross-profile contention without sending input", async () => {
    const h = await harness();
    try {
      h.ipc.busy = true;
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Busy", holder: "other-profile" },
      });
      expect(h.ipc.messages.some((m) => m.type === "request")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("turn completion cancels before release, retains grants and rejects a late invocation", async () => {
    const h = await harness();
    try {
      await h.broker.invoke("t", "s", { op: "type", text: "x" });
      h.broker.endTurn("t", "old", "s");
      expect(h.ipc.messages.some((m) => m.type === "leaseRelease")).toBe(false);
      h.broker.endTurn("t", "turn", "s");
      expect(h.ipc.messages.some((m) => m.type === "leaseRelease")).toBe(true);
      expect(h.broker.access.grants("t")).toHaveLength(1);
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "turn-ended" },
      });
      h.broker.bindSession("t", "new", "codex");
      h.broker.releaseSession("t", "s");
      expect(h.broker.generation("t")).toBe("new");
    } finally {
      h.broker.close();
    }
  });
  it("a queued semantic action revalidates a revoked app grant", async () => {
    const h = await harness();
    try {
      h.ipc.holdRequests = true;
      const first = h.broker.invoke("t", "s", { op: "type", text: "x" });
      await vi.waitFor(() => expect(h.ipc.messages.some((m) => m.type === "request")).toBe(true));
      const second = h.broker.invoke("t", "s", {
        op: "elementAction",
        appId: "com.apple.TextEdit",
        snapshotId: "snapshot",
        elementRef: "element",
        action: "press",
      });
      h.broker.access.revoke("t", "com.apple.TextEdit");
      h.ipc.finish();
      await first;
      await expect(second).rejects.toMatchObject({ error: { _tag: "NotGranted" } });
      expect(h.ipc.messages.filter((m) => m.type === "request")).toHaveLength(1);
    } finally {
      h.broker.close();
    }
  });
});

describe("background delivery", () => {
  async function backgroundHarness() {
    const h = await harness();
    h.set({
      policy: {
        previewAutomation: true,
        externalHosts: [],
        computerUse: true,
        claudeInChrome: false,
        codexChrome: false,
        computerUseExecutionMode: "background",
      },
    });
    h.ipc.emit("message", { type: "hostCapabilities", capabilities: ["background-ax-v1"] });
    h.ipc.emit("message", {
      type: "status",
      status: { available: true, background: { available: true } },
    });
    return h;
  }
  async function approveBackgroundSession(h: Awaited<ReturnType<typeof harness>>) {
    await vi.waitFor(() =>
      expect(h.ipc.messages.some((m) => m.type === "accessRequested")).toBe(true),
    );
    const request = h.ipc.messages.findLast((m) => m.type === "accessRequested");
    if (request?.type !== "accessRequested") throw new Error("missing session request");
    expect(request.request).toMatchObject({ kind: "session-actions", background: true });
    h.ipc.emit("message", {
      type: "accessAnswer",
      answer: {
        requestId: request.request.requestId,
        backendIncarnation: "backend",
        decisions: [],
        allowSessionActions: true,
        sessionReceipt: "receipt",
      },
    });
  }
  it("stays foreground until the policy prefers background and every peer negotiated it", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", {
        type: "status",
        status: { available: true, background: { available: true } },
      });
      await expect(h.broker.classify("t", "s", "type", "com.apple.TextEdit", {})).resolves.toBe(
        "foreground",
      );
      h.set({
        policy: {
          previewAutomation: true,
          externalHosts: [],
          computerUse: true,
          claudeInChrome: false,
          codexChrome: false,
          computerUseExecutionMode: "background",
        },
      });
      // No hostCapabilities answer: the desktop is a legacy peer.
      await expect(
        h.broker.classify("t", "s", "type", "com.apple.TextEdit", {}),
      ).rejects.toMatchObject({ error: { _tag: "Execution" } });
      h.ipc.emit("message", { type: "hostCapabilities", capabilities: ["background-ax-v1"] });
      await expect(h.broker.classify("t", "s", "type", "com.apple.TextEdit", {})).resolves.toBe(
        "background",
      );
    } finally {
      h.broker.close();
    }
  });
  it("needs a native session approval, then acquires an app-scoped lease", async () => {
    const h = await backgroundHarness();
    try {
      const typed = h.broker.invoke("t", "s", {
        op: "type",
        text: "x",
        appId: "com.apple.TextEdit",
      });
      await approveBackgroundSession(h);
      await typed;
      const acquire = h.ipc.messages.find((m) => m.type === "leaseAcquire");
      expect(acquire).toMatchObject({
        holder: {
          scope: { kind: "app", appId: "com.apple.TextEdit" },
          policyRevision: expect.any(Number),
        },
      });
      const request = h.ipc.messages.findLast((m) => m.type === "request");
      expect(request).toMatchObject({
        request: { op: "type", appId: "com.apple.TextEdit", delivery: "background" },
      });
      expect(request?.type === "request" && "executionMode" in request.request).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("requires an app and refuses coordinate input in background", async () => {
    const h = await backgroundHarness();
    try {
      await expect(h.broker.invoke("t", "s", { op: "type", text: "x" })).rejects.toMatchObject({
        error: { _tag: "Execution", message: "Specify app: the app to act in." },
      });
      await expect(
        h.broker.invoke("t", "s", { op: "click", x: 1, y: 1, appId: "com.apple.TextEdit" }),
      ).rejects.toMatchObject({
        error: { _tag: "ForegroundRequired", reason: "unsupported-in-background" },
      });
      await expect(
        h.broker.invoke("t", "s", {
          op: "elementAction",
          appId: "com.apple.TextEdit",
          snapshotId: "snapshot",
          elementRef: "element",
          action: "press",
          executionMode: "foreground",
        }),
      ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
      expect(h.ipc.messages.filter((m) => m.type === "leaseAcquire")).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("drops a released holder's active state but keeps paused and recovery states", async () => {
    const h = await backgroundHarness();
    try {
      const holder = {
        profileId: "p",
        threadId: "t",
        sessionGeneration: "s",
        turnId: "turn",
        executionGeneration: 3,
        grantVersion: 1,
        grants: [],
        backend: "native",
        threadTitle: "Thread",
        scope: { kind: "app", appId: "com.apple.TextEdit" },
        policyRevision: 1,
      };
      h.ipc.emit("message", { type: "leasesChanged", holders: [holder], otherProfile: false });
      h.ipc.emit("message", {
        type: "executionStateChanged",
        threadId: "t",
        sessionGeneration: "s",
        state: "active",
        delivery: "background",
        appId: "com.apple.TextEdit",
      });
      expect(h.broker.computerUse().holders).toMatchObject([{ threadId: "t", state: "active" }]);
      h.ipc.emit("message", { type: "leasesChanged", holders: [], otherProfile: false });
      expect(h.broker.computerUse().holders).toEqual([]);
      h.ipc.emit("message", {
        type: "executionStateChanged",
        threadId: "t",
        sessionGeneration: "s",
        state: "recovery",
        pauseCause: "outcome-unknown",
      });
      h.ipc.emit("message", { type: "leasesChanged", holders: [], otherProfile: false });
      expect(h.broker.computerUse().holders).toMatchObject([
        { threadId: "t", state: "recovery", pauseCause: "outcome-unknown" },
      ]);
      h.broker.releaseSession("t", "s");
      expect(h.broker.computerUse().holders).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("arms a natively approved takeover and refuses a declined one", async () => {
    const h = await backgroundHarness();
    h.ipc.appResults = [
      {
        appId: "com.apple.TextEdit",
        name: "TextEdit",
        tier: "full",
        running: true,
        frontmost: false,
      },
    ];
    try {
      const typed = h.broker.invoke("t", "s", {
        op: "type",
        text: "x",
        appId: "com.apple.TextEdit",
      });
      await approveBackgroundSession(h);
      await typed;
      const answerTakeover = async (allow: boolean) => {
        await vi.waitFor(() =>
          expect(
            h.ipc.messages.some(
              (m) => m.type === "accessRequested" && m.request.kind === "foreground-takeover",
            ),
          ).toBe(true),
        );
        const request = h.ipc.messages.findLast(
          (m) => m.type === "accessRequested" && m.request.kind === "foreground-takeover",
        );
        const acquire = h.ipc.messages.findLast((m) => m.type === "foregroundTakeoverAcquire");
        if (request?.type !== "accessRequested" || acquire?.type !== "foregroundTakeoverAcquire")
          throw new Error("missing takeover exchange");
        expect(acquire.approvalRequestId).toBe(request.request.requestId);
        expect(request.request.takeover).toMatchObject({
          appId: "com.apple.TextEdit",
          threadId: "t",
          turnId: "turn",
        });
        h.ipc.messages.length = 0;
        h.ipc.emit("message", {
          type: "accessAnswer",
          answer: {
            requestId: request.request.requestId,
            backendIncarnation: "backend",
            decisions: [],
            allowForegroundTakeover: allow,
          },
        });
        if (allow)
          h.ipc.emit("message", {
            type: "response",
            requestId: acquire.requestId,
            result: { ...acquire.holder, executionGeneration: 9 },
          });
        return acquire.requestId;
      };
      const declined = h.broker.requestForeground("t", "s", "TextEdit", "Needs a drag");
      const declinedId = await answerTakeover(false);
      await expect(declined).rejects.toMatchObject({ error: { _tag: "NotGranted" } });
      expect(h.ipc.messages).toContainEqual({ type: "cancel", requestId: declinedId });
      const approved = h.broker.requestForeground("t", "s", "TextEdit", "Needs a drag");
      await answerTakeover(true);
      await expect(approved).resolves.toMatchObject({
        foreground: true,
        appId: "com.apple.TextEdit",
      });
      expect(h.broker.computerUse().holders).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it("continues the policy revision when a thread's session is replaced", async () => {
    const h = await backgroundHarness();
    try {
      await h.broker.policyTransition(async () => undefined);
      const invalidated = h.ipc.messages.findLast((m) => m.type === "observationInvalidate");
      if (invalidated?.type !== "observationInvalidate") throw new Error("no invalidation");
      // Provider restart: a new session generation for the same thread.
      h.broker.bindSession("t", "s2", "claude");
      h.ipc.messages.length = 0;
      const typed = h.broker.invoke("t", "s2", {
        op: "type",
        text: "x",
        appId: "com.apple.TextEdit",
      });
      await approveBackgroundSession(h);
      await typed;
      const acquire = h.ipc.messages.find((m) => m.type === "leaseAcquire");
      if (acquire?.type !== "leaseAcquire") throw new Error("no acquire");
      // Electron keeps its per-thread minimum; the new binding must not fall below it.
      expect(acquire.holder.policyRevision).toBeGreaterThanOrEqual(invalidated.policyRevision);
    } finally {
      h.broker.close();
    }
  });
  it("asks for the background session approval when a takeover comes first", async () => {
    const h = await backgroundHarness();
    h.ipc.appResults = [
      {
        appId: "com.apple.TextEdit",
        name: "TextEdit",
        tier: "full",
        running: true,
        frontmost: false,
      },
    ];
    try {
      const pending = h.broker.requestForeground("t", "s", "TextEdit", "Needs a drag");
      await approveBackgroundSession(h);
      await vi.waitFor(() =>
        expect(h.ipc.messages.some((m) => m.type === "foregroundTakeoverAcquire")).toBe(true),
      );
      h.broker.close();
      await pending.catch(() => undefined);
    } finally {
      h.broker.close();
    }
  });
  it("closes admissions and bumps the revision during a policy transition", async () => {
    const h = await backgroundHarness();
    try {
      const typed = h.broker.invoke("t", "s", {
        op: "type",
        text: "x",
        appId: "com.apple.TextEdit",
      });
      await approveBackgroundSession(h);
      await typed;
      let applied = false;
      const transition = h.broker.policyTransition(async () => {
        applied = true;
        h.set({
          policy: {
            previewAutomation: true,
            externalHosts: [],
            computerUse: true,
            claudeInChrome: false,
            codexChrome: false,
            computerUseExecutionMode: "foreground",
          },
        });
      });
      // Admitted only after the change applies; it then runs under the new mode.
      const queued = h.broker.classify("t", "s", "type", "com.apple.TextEdit", {});
      await transition;
      expect(applied).toBe(true);
      await expect(queued).resolves.toBe("foreground");
      // The session approval for background was revoked with the policy change.
      expect(h.broker.access.backgroundApproved("t")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
});

it("refuses screenshots, zoom and inspection while paused", async () => {
  const h = await harness();
  try {
    h.broker.setPaused("t", true);
    for (const op of ["screenshot", "zoom", "inspect"] as const)
      await expect(h.broker.invoke("t", "s", { op })).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "paused" },
      });
    expect(h.ipc.messages.filter((message) => message.type === "request")).toEqual([]);
  } finally {
    h.broker.close();
  }
});

describe("computer_wait", () => {
  it("cancels while initial context resolution is still held", async () => {
    const h = await harness();
    const original = h.broker.context.bind(h.broker);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.broker, "context").mockImplementation(async (...args) => {
      await held;
      return original(...args);
    });
    try {
      const pending = h.broker.wait("t", "s", { deadlineMs: performance.now() + 10_000 });
      const rejected = expect(pending).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "turn-ended" },
      });
      h.broker.endTurn("t", "turn", "s");
      await rejected;
      release();
      await expect(
        h.broker.wait("t", "s", { deadlineMs: performance.now() + 100 }),
      ).rejects.toMatchObject({ error: { _tag: "Interrupted", cause: "turn-ended" } });
    } finally {
      release();
      h.broker.close();
    }
  });

  it("settles once under a monotonic deadline and rejects concurrent waits", async () => {
    const h = await harness();
    const events: string[] = [];
    h.broker.subscribe((event) => {
      if (event.channel === "computer.activity" && event.data.op === "wait")
        events.push(event.data.status);
    });
    try {
      const wait = h.broker.wait("t", "s", { deadlineMs: performance.now() + 100 });
      await expect(
        h.broker.wait("t", "s", { deadlineMs: performance.now() + 100 }),
      ).rejects.toMatchObject({ error: { _tag: "Busy" } });
      expect(await wait).toMatchObject({ waitedMs: expect.any(Number) });
      expect(events).toEqual(["started", "completed"]);
    } finally {
      h.broker.close();
    }
  });
  it.each(["paused", "turn-ended", "released", "policy-changed"] as const)(
    "cancels promptly on %s and never carries a loop into a replacement turn",
    async (cause) => {
      const h = await harness();
      try {
        const wait = h.broker.wait("t", "s", { deadlineMs: performance.now() + 10_000 });
        const rejected = expect(wait).rejects.toMatchObject({
          error: { _tag: "Interrupted", cause: cause === "released" ? "turn-ended" : cause },
        });
        await vi.waitFor(() => expect(h.broker.matchesTurn("t", "s", "turn")).toBe(true));
        const startedAt = performance.now();
        if (cause === "paused") h.broker.pause.set("t", true);
        else if (cause === "turn-ended") h.broker.endTurn("t", "turn", "s");
        else if (cause === "released") h.broker.releaseSession("t", "s");
        else await h.broker.policyTransition(async () => {});
        await rejected;
        expect(performance.now() - startedAt).toBeLessThan(50);
      } finally {
        h.broker.close();
      }
    },
  );
  it("rejects without an active turn and matches partial trees with bounded inspections", async () => {
    const h = await harness();
    try {
      h.set({ turnId: "observation" });
      await expect(
        h.broker.wait("t", "s", { deadlineMs: performance.now() + 100 }),
      ).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
      h.set({ turnId: "turn" });
      h.ipc.appResults = [{ appId: "com.apple.TextEdit", name: "TextEdit" }];
      h.ipc.inspectResults = [
        {
          accessible: true,
          snapshotId: "snapshot",
          nodes: [{ elementRef: "one", role: "AXButton", name: "Ready" }],
        },
      ];
      const result = await h.broker.wait("t", "s", {
        deadlineMs: performance.now() + 500,
        condition: { app: "TextEdit", role: "AXButton", name: "Ready" },
      });
      expect(result).toMatchObject({ matched: true, snapshotId: "snapshot", elementRefs: ["one"] });
      const inspections = h.ipc.messages.filter(
        (message) => message.type === "request" && message.request.op === "inspect",
      );
      expect(inspections).toHaveLength(1);
      expect(inspections[0]).toMatchObject({ request: { maxNodes: 100 } });
    } finally {
      h.broker.close();
    }
  });
  it("uses a single deadline even when resolution never replies and cancels its native request", async () => {
    const h = await harness();
    h.ipc.holdRequests = true;
    try {
      const result = await h.broker.wait("t", "s", {
        deadlineMs: performance.now() + 100,
        condition: { app: "TextEdit", name: "Ready" },
      });
      expect(result).toMatchObject({ timedOut: true, matched: false });
      expect(result.waitedMs).toBeLessThan(200);
      expect(h.ipc.messages.some((message) => message.type === "cancel")).toBe(true);
    } finally {
      h.broker.close();
    }
  });
});

it("suppresses stale and legacy thumbnails while preserving correlated current activity", async () => {
  const h = await harness();
  const activity: unknown[] = [];
  h.broker.subscribe((event) => {
    if (event.channel === "computer.activity") activity.push(event.data);
  });
  try {
    h.ipc.holdRequests = true;
    const invocation = h.broker.invoke("t", "s", { op: "type", text: "test" });
    await vi.waitFor(() =>
      expect(h.ipc.messages.some((message) => message.type === "request")).toBe(true),
    );
    const request = h.ipc.messages.findLast((message) => message.type === "request");
    if (request?.type !== "request") throw new Error("missing request");
    const completed = {
      type: "activity",
      activity: {
        threadId: "t",
        backend: "native",
        op: "type",
        status: "completed",
        requestId: request.request.requestId,
        sessionGeneration: "s",
        thumbnailDataUrl: "capture",
      },
    };
    h.ipc.emit("message", completed);
    expect(activity.at(-1)).not.toHaveProperty("thumbnailDataUrl");
    h.ipc.emit("message", {
      type: "hostCapabilities",
      capabilities: ["computer-activity-correlation-v1"],
    });
    h.ipc.emit("message", completed);
    expect(activity.at(-1)).toHaveProperty("thumbnailDataUrl", "capture");
    h.broker.setPaused("t", true);
    h.ipc.emit("message", completed);
    expect(activity.at(-1)).not.toHaveProperty("thumbnailDataUrl");
    h.ipc.finish();
    await invocation;
  } finally {
    h.broker.close();
  }
});

it("preserves observations on an idle turn completion", async () => {
  const h = await harness();
  try {
    await h.broker.invoke("t", "s", { op: "status" });
    const invalidated: unknown[] = [];
    h.broker.subscribe((event) => {
      if (event.channel === "computer.observations.invalidated") invalidated.push(event);
    });
    h.broker.endTurn("t", "turn", "s");
    expect(invalidated).toHaveLength(0);
  } finally {
    h.broker.close();
  }
});

it("ignores a late previous turn completion while the next wait is resolving context", async () => {
  const h = await harness();
  const original = h.broker.context.bind(h.broker);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    h.broker.beginTurn("t", "previous");
    h.broker.beginTurn("t", "next");
    h.set({ turnId: "next" });
    vi.spyOn(h.broker, "context").mockImplementation(async (...args) => {
      await held;
      return original(...args);
    });
    const pending = h.broker.wait("t", "s", { deadlineMs: performance.now() + 100 });
    h.broker.endTurn("t", "previous", "s");
    release();
    await expect(pending).resolves.toMatchObject({ waitedMs: expect.any(Number) });
  } finally {
    release();
    h.broker.close();
  }
});

it("rejects a lease acquisition that outlives two turn transitions", async () => {
  const h = await harness();
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const original = h.broker.host.correlated.bind(h.broker.host);
  const spy = vi
    .spyOn(h.broker.host, "correlated")
    .mockImplementation(async (message, timeout, mutating) => {
      const result = await original(message, timeout, mutating);
      if (message.type === "leaseAcquire") {
        acquired();
        await held;
      }
      return result;
    });
  try {
    h.broker.beginTurn("t", "turn");
    const pending = h.broker.invoke("t", "s", { op: "type", text: "must not dispatch" });
    const rejected = expect(pending).rejects.toMatchObject({
      error: { _tag: "Interrupted", cause: "turn-ended" },
    });
    await started;
    h.broker.beginTurn("t", "next");
    h.broker.endTurn("t", "next", "s");
    release();
    await rejected;
    expect(
      h.ipc.messages.some((message) => message.type === "request" && message.request.op === "type"),
    ).toBe(false);
    expect(h.ipc.messages.some((message) => message.type === "leaseRelease")).toBe(true);
  } finally {
    release();
    spy.mockRestore();
    h.broker.close();
  }
});
