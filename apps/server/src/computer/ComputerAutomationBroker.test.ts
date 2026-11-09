import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  ComputerControlError,
  computerRequestPayload,
  CHROME_OWN_STOPPING_MESSAGE,
} from "@t3tools/shared/computerControl";
import { describe, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder, DesktopComputerHostMessage } from "@t3tools/contracts";
import {
  CHROME_OTHER_PROFILE_LINGER_MS,
  COMPUTER_TARGET_WAIT_DESKTOP_MARGIN_MS,
  ComputerAutomationBrokerRuntime,
  type ComputerInvocationContext,
} from "./ComputerAutomationBroker";
import { DesktopComputerHost } from "./DesktopComputerHost";
import * as computerApps from "@t3tools/shared/computerApps";

class Ipc extends EventEmitter {
  connected = true;
  messages: DesktopComputerHostMessage[] = [];
  holdRequests = false;
  holdAcquires = false;
  requestErrors: Array<{ _tag: "TargetBlocked"; kind: "foreground-busy" | "user-active" }> = [];
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
    if (message.type === "leaseAcquire" && !this.holdAcquires)
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
          ...(this.requestErrors.length ? { error: this.requestErrors.shift() } : {}),
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
async function harness(platform: "darwin" | "win32" = "darwin") {
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
    threadTitle: async (threadId) => (threadId === "chrome-thread" ? "Chrome work" : undefined),
    platform,
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
  it("waits for its own Codex handoff before dispatching native work", async () => {
    const h = await harness();
    try {
      let release!: () => void;
      const native = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      h.broker.registerCodexHandoff("t", "s", {
        native,
        browser: async () => {},
        status: () => ({ state: "ready" }),
      });
      const pending = h.broker.invoke("t", "s", { op: "type", text: "sunflower" });
      await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
      expect(h.ipc.messages.some((m) => m.type === "leaseAcquire" || m.type === "request")).toBe(
        false,
      );
      release();
      await pending;
      expect(h.ipc.messages.some((m) => m.type === "leaseAcquire")).toBe(true);
    } finally {
      h.broker.close();
    }
  });

  it("does not dispatch native work after pause during handoff", async () => {
    const h = await harness();
    try {
      let release!: () => void;
      const native = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      h.broker.registerCodexHandoff("t", "s", {
        native,
        browser: async () => {},
        status: () => ({ state: "ready" }),
      });
      const pending = h.broker.invoke("t", "s", { op: "type", text: "sunflower" });
      const refused = expect(pending).rejects.toMatchObject({
        error: { _tag: "Interrupted", cause: "paused" },
      });
      await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
      h.broker.setPaused("t", true);
      h.broker.setPaused("t", false);
      release();
      await refused;
      expect(h.ipc.messages.some((m) => m.type === "leaseAcquire" || m.type === "request")).toBe(
        false,
      );
    } finally {
      h.broker.close();
    }
  });

  it("exposes parked Chrome separately from backend availability without changing grants", async () => {
    const h = await harness();
    try {
      h.broker.registerCodexHandoff("t", "s", {
        native: async () => {},
        browser: async () => {},
        status: () => ({ state: "parked-for-native", nextAction: "browser_resume" }),
      });
      await h.broker.invoke("t", "s", { op: "status" });
      const grants = h.broker.access.grants("t");
      expect(await h.broker.invoke("t", "s", { op: "status" })).toMatchObject({
        available: true,
        control: { chrome: { state: "parked-for-native", nextAction: "browser_resume" } },
      });
      expect(h.broker.access.grants("t")).toEqual(grants);
    } finally {
      h.broker.close();
    }
  });

  it("waits for desktop lease release rather than trusting the stop request", async () => {
    const h = await harness();
    try {
      const holder = { profileId: "p", threadId: "t", sessionGeneration: "s", provider: "codex" };
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder });
      await expect(
        h.broker.waitForChromeRelease("t", "s", performance.now() + 5, async () => {}),
      ).rejects.toThrow(CHROME_OWN_STOPPING_MESSAGE);
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder: null });
      await h.broker.waitForChromeRelease("t", "s", performance.now() + 100, async () => {});
    } finally {
      h.broker.close();
    }
  });
  it("releases a Chrome reservation if pause arrives with the acquire reply", async () => {
    const h = await harness();
    try {
      const original = h.ipc.send.bind(h.ipc);
      vi.spyOn(h.ipc, "send").mockImplementation((raw, callback) => {
        const message = raw as DesktopComputerHostMessage;
        if (message.type !== "chromeLeaseAcquire") return original(raw, callback);
        h.ipc.messages.push(message);
        callback(null);
        queueMicrotask(() => {
          h.broker.setPaused("t", true);
          h.ipc.emit("message", { type: "response", requestId: message.requestId, result: true });
        });
        return true;
      });
      await expect(
        h.broker.prepareCodexBrowser("t", "s", performance.now() + 1000, async () => {
          if (h.broker.pause.has("t")) throw new Error("paused");
        }),
      ).rejects.toThrow("paused");
      expect(h.ipc.messages.some((m) => m.type === "chromeLeaseRelease")).toBe(true);
    } finally {
      h.broker.close();
    }
  });

  it("does not dispatch a mutation when context consumes its absolute batch deadline", async () => {
    const h = await harness();
    try {
      const handle = await h.broker.beginBatch("t", "s", "foreground");
      const original = h.broker.context.bind(h.broker);
      vi.spyOn(h.broker, "context").mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return original(...args);
      });
      const start = performance.now();
      await expect(
        h.broker.invoke("t", "s", { op: "type", text: "x" }, 30_000, {
          batch: handle,
          deadlineMs: start + 30,
        }),
      ).rejects.toMatchObject({ error: { _tag: "Execution" } });
      expect(performance.now() - start).toBeLessThan(90);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(h.ipc.messages.some((message) => message.type === "request")).toBe(false);
      handle.release();
    } finally {
      h.broker.close();
    }
  });
  it("bounds slow resolution before any native dispatch", async () => {
    const h = await harness();
    try {
      const original = h.broker.context.bind(h.broker);
      vi.spyOn(h.broker, "context").mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return original(...args);
      });
      const start = performance.now();
      await expect(
        h.broker.invoke("t", "s", { op: "resolveApps", queries: ["TextEdit"] }, 50),
      ).rejects.toMatchObject({ error: { _tag: "Execution" } });
      expect(performance.now() - start).toBeLessThan(120);
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(h.ipc.messages.some((message) => message.type === "request")).toBe(false);
    } finally {
      h.broker.close();
    }
  });
  it("waits for the desktop outcome when an already dispatched batch mutation is aborted", async () => {
    const h = await harness();
    try {
      const handle = await h.broker.beginBatch("t", "s", "foreground");
      h.ipc.holdRequests = true;
      let finished = false;
      const pending = h.broker
        .invoke("t", "s", { op: "type", text: "x" }, 1000, {
          batch: handle,
          signal: handle.controller.signal,
        })
        .finally(() => {
          finished = true;
        });
      const rejected = expect(pending).rejects.toMatchObject({ error: { _tag: "OutcomeUnknown" } });
      await vi.waitFor(() =>
        expect(h.ipc.messages.some((message) => message.type === "request")).toBe(true),
      );
      h.broker.setPaused("t", true);
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(handle.controller.signal.reason).toMatchObject({
        error: { _tag: "Interrupted", cause: "paused" },
      });
      const request = h.ipc.messages.findLast((message) => message.type === "request");
      if (request?.type !== "request") throw new Error("Missing request");
      h.ipc.emit("message", {
        type: "response",
        requestId: request.request.requestId,
        error: { _tag: "OutcomeUnknown" },
      });
      await rejected;
      handle.release();
    } finally {
      h.broker.close();
    }
  });
  it.each(["end", "pause", "policy", "release"] as const)(
    "revokes a batch across %s transitions",
    async (transition) => {
      const h = await harness();
      try {
        const handle = await h.broker.beginBatch("t", "s", "foreground");
        if (transition === "end") h.broker.endTurn("t", "turn", "s");
        if (transition === "pause") {
          h.broker.setPaused("t", true);
          h.broker.setPaused("t", false);
        }
        if (transition === "policy") await h.broker.policyTransition(async () => {});
        if (transition === "release") h.broker.releaseSession("t", "s");
        expect(handle.controller.signal.aborted).toBe(true);
        expect(() => h.broker.assertBatchLive(handle)).toThrow();
        await expect(
          h.broker.invoke("t", "s", { op: "type", text: "x" }, 1000, { batch: handle }),
        ).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
        expect(h.ipc.messages.some((message) => message.type === "request")).toBe(false);
        handle.release();
      } finally {
        h.broker.close();
      }
    },
  );
  it("settles only after a complete tree remains stable and returns the latest snapshot", async () => {
    const h = await harness();
    const tree = (snapshotId: string, name: string, truncated = false) => ({
      accessible: true,
      appId: "com.apple.TextEdit",
      snapshotId,
      truncated,
      nodes: [
        { elementRef: "one", role: "AXButton", name, actions: [], enabled: true, focused: false },
      ],
    });
    h.ipc.inspectResults = [tree("a", "A"), tree("b", "B"), tree("c", "B"), tree("d", "B")];
    try {
      const start = performance.now();
      const result = await h.broker.wait("t", "s", {
        deadlineMs: start + 2000,
        settle: { appId: "com.apple.TextEdit", maxNodes: 400, onPartial: "return" },
      });
      expect(result).toMatchObject({ settled: true, tree: { snapshotId: "d" } });
      expect(performance.now() - start).toBeGreaterThanOrEqual(750);
    } finally {
      h.broker.close();
    }
  });
  it.each(["wait", "return"] as const)(
    "never settles a truncated prefix (%s)",
    async (onPartial) => {
      const h = await harness();
      h.ipc.inspectResults = [
        {
          accessible: true,
          snapshotId: "partial",
          truncated: true,
          nodes: [{ elementRef: "one", role: "AXButton", name: "A" }],
        },
      ];
      try {
        const start = performance.now();
        const result = await h.broker.wait("t", "s", {
          deadlineMs: start + 150,
          settle: { appId: "com.apple.TextEdit", maxNodes: 400, onPartial },
        });
        expect(result).toMatchObject({ settled: false, reason: "partial-tree" });
        if (onPartial === "wait") expect(performance.now() - start).toBeGreaterThanOrEqual(140);
      } finally {
        h.broker.close();
      }
    },
  );
  it("holds the mutation queue until the batch releases and rejects forged handles", async () => {
    const h = await harness();
    h.set({ runtimeMode: "full-access" });
    try {
      const handle = await h.broker.beginBatch("t", "s", "foreground");
      expect(() => h.broker.assertBatchLive({ ...handle })).toThrow();
      const pending = h.broker.invoke("t", "s", { op: "type", text: "x" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.ipc.messages.some((message) => message.type === "request")).toBe(false);
      handle.release();
      handle.release();
      await pending;
      expect(() => h.broker.assertBatchLive(handle)).toThrow();
    } finally {
      h.broker.close();
    }
  });
  it("awaits main's correlated forget result and surfaces persistence failure to Settings", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", {
        type: "hostCapabilities",
        capabilities: ["computer-grant-forget-v1"],
      });
      const forget = h.broker.access.forgetRemembered("project", "com.apple.TextEdit");
      const rejected = expect(forget).rejects.toThrow("could not save revocation");
      await vi.waitFor(() =>
        expect(
          h.ipc.messages.some((message) => message.type === "grantForget" && message.requestId),
        ).toBe(true),
      );
      const request = h.ipc.messages.findLast((message) => message.type === "grantForget");
      if (request?.type !== "grantForget") throw new Error("Missing forget request");
      h.ipc.emit("message", {
        type: "response",
        requestId: request.requestId,
        error: { _tag: "Execution", message: "could not save revocation" },
      });
      await rejected;
    } finally {
      h.broker.close();
    }
  });
  it.each([false, true])(
    "notifies capable hosts on actual session release, capable=%s",
    async (capable) => {
      const h = await harness();
      try {
        if (capable)
          h.ipc.emit("message", {
            type: "hostCapabilities",
            capabilities: ["computer-session-lifecycle-v1"],
          });
        h.broker.releaseSession("t", "obsolete");
        expect(
          h.ipc.messages.filter((message) => message.type === "computerSessionClosed"),
        ).toEqual([]);
        h.broker.releaseSession("t", "s");
        expect(
          h.ipc.messages.filter((message) => message.type === "computerSessionClosed"),
        ).toEqual(
          capable ? [{ type: "computerSessionClosed", threadId: "t", sessionGeneration: "s" }] : [],
        );
      } finally {
        h.broker.close();
      }
    },
  );
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
  it("tells an idle Chrome runtime's lease from one running a browser call", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", {
        type: "chromeLeaseChanged",
        holder: { profileId: "p", threadId: "t", sessionGeneration: "s", provider: "codex" },
      });
      const chrome = () => h.broker.computerUse().holders.find((holder) => holder.threadId === "t");
      // A session that doesn't report its calls: unknown, but still marked as Chrome.
      expect(chrome()?.browser).toBe("unknown");
      h.broker.reportChromeCalls("t", "s", false);
      expect(chrome()?.browser).toBe("idle");
      h.broker.reportChromeCalls("t", "s", true);
      expect(chrome()?.browser).toBe("working");
      // Another generation's report neither applies to nor clears the current one.
      h.broker.reportChromeCalls("t", "old", false);
      h.broker.reportChromeCalls("t", "old", undefined);
      expect(chrome()?.browser).toBe("working");
      h.broker.reportChromeCalls("t", "s", undefined);
      expect(chrome()?.browser).toBe("unknown");
    } finally {
      h.broker.close();
    }
  });
  it("drops a Chrome call report when its lease ends, without the session's help", async () => {
    const h = await harness();
    try {
      const holder = { profileId: "p", threadId: "t", sessionGeneration: "s", provider: "codex" };
      const chrome = () =>
        h.broker.computerUse().holders.find((entry) => entry.threadId === "t")?.browser;
      // Reported before acquiring: the announced lease is idle at once.
      h.broker.reportChromeCalls("t", "s", false);
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder });
      expect(chrome()).toBe("idle");
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder: null });
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder });
      expect(chrome()).toBe("unknown");
      h.broker.reportChromeCalls("t", "s", true);
      h.ipc.emit("message", {
        type: "status",
        status: { available: false, reason: "no-host" },
      });
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder });
      expect(chrome()).toBe("unknown");
    } finally {
      h.broker.close();
    }
  });
  it("tells a capable desktop whether its Chrome session runs a call", async () => {
    const h = await harness();
    try {
      const sent = () => h.ipc.messages.filter((message) => message.type === "chromeCallsChanged");
      // A legacy desktop would disconnect on the unknown message: nothing is sent.
      h.broker.reportChromeCalls("t", "s", false);
      h.broker.reportChromeCalls("t", "other", true);
      expect(sent()).toEqual([]);
      // The handshake answer replays what was reported before it.
      h.ipc.emit("message", {
        type: "hostCapabilities",
        capabilities: ["chrome-call-activity-v1"],
      });
      expect(sent()).toEqual([
        { type: "chromeCallsChanged", threadId: "t", sessionGeneration: "s", running: false },
        { type: "chromeCallsChanged", threadId: "t", sessionGeneration: "other", running: true },
      ]);
      h.broker.reportChromeCalls("t", "s", true);
      h.broker.reportChromeCalls("t", "s", true);
      h.broker.reportChromeCalls("t", "other", undefined);
      expect(sent().slice(2)).toEqual([
        { type: "chromeCallsChanged", threadId: "t", sessionGeneration: "s", running: true },
        { type: "chromeCallsChanged", threadId: "t", sessionGeneration: "other", running: null },
      ]);
    } finally {
      h.broker.close();
    }
  });
  it("holds another profile's Chrome control in the banner briefly, but not native control", async () => {
    const h = await harness();
    vi.useFakeTimers();
    try {
      const other = () => h.broker.computerUse().otherProfile;
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder: null, otherProfile: true });
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder: null, otherProfile: false });
      expect(other()).toBe(true);
      vi.advanceTimersByTime(CHROME_OTHER_PROFILE_LINGER_MS - 1);
      // Back to busy within the window: no flicker, and the earlier timer can't end it.
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder: null, otherProfile: true });
      vi.advanceTimersByTime(CHROME_OTHER_PROFILE_LINGER_MS);
      expect(other()).toBe(true);
      h.ipc.emit("message", { type: "chromeLeaseChanged", holder: null, otherProfile: false });
      vi.advanceTimersByTime(CHROME_OTHER_PROFILE_LINGER_MS - 1);
      expect(other()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(other()).toBe(false);
      // Native control ends at once.
      h.ipc.emit("message", { type: "leasesChanged", holders: [], otherProfile: true });
      h.ipc.emit("message", { type: "leasesChanged", holders: [], otherProfile: false });
      expect(other()).toBe(false);
    } finally {
      vi.useRealTimers();
      h.broker.close();
    }
  });
  it("says why another profile's control refuses an agent", () => {
    expect(new ComputerControlError({ _tag: "Busy", holder: "other-profile" }).message).toBe(
      "Busy: an agent in another F5 profile holds computer or Chrome control; wait or ask the user.",
    );
    expect(new ComputerControlError({ _tag: "Busy", holder: "same-profile" }).message).toBe(
      "Busy: Computer or Chrome control is in use in this F5 profile; wait and retry.",
    );
    expect(
      new ComputerControlError({
        _tag: "Busy",
        holder: "same-profile",
        resource: "chrome",
        holderThreadId: "t1",
        threadTitle: "Fix login",
        holderIdle: false,
      }).message,
    ).toBe(
      'Busy: Chrome is held by thread "Fix login" (working). F5 releases idle holders automatically; if it\'s working, wait or ask the user to stop it.',
    );
    expect(
      new ComputerControlError({
        _tag: "Busy",
        holder: "same-profile",
        resource: "computer",
        holderThreadId: "t1",
      }).message,
    ).toBe(
      "Busy: Computer control is held by another thread. F5 releases idle holders automatically; if it's working, wait or ask the user to stop it.",
    );
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
  it("cleans up a failed foreground handoff so browser_resume can succeed in the same turn", async () => {
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
      const initial = h.broker.invoke("t", "s", {
        op: "type",
        appId: "com.apple.TextEdit",
        text: "x",
      });
      await approveBackgroundSession(h);
      await initial;
      h.broker.registerCodexHandoff("t", "s", {
        native: async () => {
          throw new Error("Chrome call still running");
        },
        browser: (deadline, check) => h.broker.prepareCodexBrowser("t", "s", deadline, check),
        status: () => ({ state: "ready" }),
      });
      await expect(h.broker.requestForeground("t", "s", "TextEdit", "Drag")).rejects.toThrow(
        "Chrome call still running",
      );
      const acquire = vi.spyOn(h.broker, "acquireChromeLease").mockResolvedValue(undefined);
      await expect(h.broker.resumeCodexBrowser("t", "s")).resolves.toMatchObject({
        state: "ready",
      });
      expect(acquire).toHaveBeenCalledOnce();
    } finally {
      h.broker.close();
    }
  });
  async function backgroundHarness(platform: "darwin" | "win32" = "darwin") {
    const h = await harness(platform);
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
  it("negotiates Windows background control and forwards host metadata to remote clients", async () => {
    const h = await backgroundHarness("win32");
    try {
      expect(h.broker.backgroundStatus()).toEqual({ available: true });
      h.ipc.emit("message", {
        type: "status",
        status: {
          available: true,
          background: { available: true },
          hostPlatform: "win32",
          stopShortcut: "Ctrl+Alt+Shift+F12",
        },
      });
      expect(h.broker.computerUse()).toMatchObject({
        hostPlatform: "win32",
        stopShortcut: "Ctrl+Alt+Shift+F12",
      });
      const events: unknown[] = [];
      const off = h.broker.subscribe((event) => events.push(event));
      h.ipc.emit("message", {
        type: "status",
        status: {
          available: false,
          reason: "monitor-unhealthy",
          hostPlatform: "win32",
          stopShortcut: "Ctrl+Alt+Shift+F12",
        },
      });
      expect(
        events.filter((event) => (event as { channel: string }).channel === "computer.use.changed"),
      ).toHaveLength(0);
      h.ipc.emit("message", {
        type: "status",
        status: { available: true, hostPlatform: "win32", stopShortcut: "Updated shortcut" },
      });
      expect(
        events.filter((event) => (event as { channel: string }).channel === "computer.use.changed"),
      ).toHaveLength(1);
      off();
    } finally {
      h.broker.close();
    }
  });
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
  it("selects background events only with certification, capability and an app-local key or element target", async () => {
    const h = await backgroundHarness();
    try {
      await expect(
        h.broker.classify("t", "s", "key", "com.apple.TextEdit", { chords: ["Down"] }),
      ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
      const certified = vi
        .spyOn(computerApps, "computerBackgroundEventAppAllowed")
        .mockReturnValue(true);
      try {
        await expect(
          h.broker.classify("t", "s", "key", "com.apple.TextEdit", { chords: ["Down"] }),
        ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
        h.ipc.emit("message", {
          type: "hostCapabilities",
          capabilities: ["background-ax-v1", "background-events-v1"],
        });
        await expect(
          h.broker.classify("t", "s", "key", "com.apple.TextEdit", { chords: ["Down"] }),
        ).resolves.toBe("background");
        await expect(
          h.broker.classify("t", "s", "scroll", "com.apple.TextEdit", { elementRef: "element" }),
        ).resolves.toBe("background");
        for (const [op, input] of [
          ["key", { chords: ["Meta+Tab"] }],
          ["scroll", {}],
          ["click", {}],
        ] as const)
          await expect(
            h.broker.classify("t", "s", op, "com.apple.TextEdit", input),
          ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
      } finally {
        certified.mockRestore();
      }
    } finally {
      h.broker.close();
    }
  });
  it("reselects delivery after pre-dispatch admission contention and stops when it becomes foreground", async () => {
    const h = await backgroundHarness();
    try {
      const initial = h.broker.invoke("t", "s", {
        op: "type",
        appId: "com.apple.TextEdit",
        text: "x",
      });
      await approveBackgroundSession(h);
      await initial;
      h.ipc.messages.length = 0;
      const delivery = vi
        .spyOn(h.broker, "selectDelivery")
        .mockReturnValueOnce("background")
        .mockReturnValue("foreground");
      const acquire = vi
        .spyOn(h.broker.host, "correlated")
        .mockRejectedValueOnce(
          new ComputerControlError({ _tag: "TargetBlocked", kind: "foreground-busy" }),
        );
      try {
        await expect(
          h.broker.invoke("t", "s", { op: "type", appId: "com.apple.TextEdit", text: "x" }),
        ).rejects.toMatchObject({ error: { _tag: "ForegroundRequired" } });
        expect(delivery).toHaveBeenCalledTimes(2);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(h.ipc.messages.filter((message) => message.type === "request")).toEqual([]);
      } finally {
        delivery.mockRestore();
        acquire.mockRestore();
      }
    } finally {
      h.broker.close();
    }
  });
  it("waits for a takeover reservation before showing exactly one consent, and none on Busy", async () => {
    const h = await backgroundHarness();
    h.ipc.emit("message", {
      type: "hostCapabilities",
      capabilities: ["background-ax-v1", "computer-cooperation-v1", "takeover-reservation-v1"],
    });
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
      const initial = h.broker.invoke("t", "s", {
        op: "type",
        appId: "com.apple.TextEdit",
        text: "x",
      });
      await approveBackgroundSession(h);
      await initial;
      h.ipc.messages.length = 0;
      const failed = h.broker.requestForeground("t", "s", "TextEdit", "Drag");
      const rejected = expect(failed).rejects.toMatchObject({ error: { _tag: "Busy" } });
      await vi.waitFor(() =>
        expect(h.ipc.messages.some((m) => m.type === "foregroundTakeoverAcquire")).toBe(true),
      );
      const acquire = h.ipc.messages.findLast((m) => m.type === "foregroundTakeoverAcquire");
      if (acquire?.type !== "foregroundTakeoverAcquire") throw new Error("no acquire");
      expect(acquire.waitMs).toBe(20_000);
      expect(h.ipc.messages.filter((m) => m.type === "accessRequested")).toEqual([]);
      h.ipc.emit("message", {
        type: "response",
        requestId: acquire.requestId,
        error: { _tag: "Busy", holder: "other-profile" },
      });
      await rejected;
      expect(h.ipc.messages.filter((m) => m.type === "accessRequested")).toEqual([]);
      h.ipc.messages.length = 0;
      const approved = h.broker.requestForeground("t", "s", "TextEdit", "Drag");
      await vi.waitFor(() =>
        expect(h.ipc.messages.some((m) => m.type === "foregroundTakeoverAcquire")).toBe(true),
      );
      const next = h.ipc.messages.findLast((m) => m.type === "foregroundTakeoverAcquire");
      if (next?.type !== "foregroundTakeoverAcquire") throw new Error("no acquire");
      h.ipc.emit("message", { type: "takeoverReserved", requestId: next.requestId });
      await vi.waitFor(() =>
        expect(h.ipc.messages.filter((m) => m.type === "accessRequested")).toHaveLength(1),
      );
      h.ipc.emit("message", {
        type: "accessAnswer",
        answer: {
          requestId: next.approvalRequestId,
          backendIncarnation: "backend",
          decisions: [],
          allowForegroundTakeover: true,
        },
      });
      h.ipc.emit("message", {
        type: "response",
        requestId: next.requestId,
        result: { ...next.holder, executionGeneration: 9 },
      });
      await expect(approved).resolves.toMatchObject({ foreground: true });
    } finally {
      h.broker.close();
    }
  });
  it("names the thread holding Chrome when main refuses a takeover over it", async () => {
    const h = await backgroundHarness();
    h.ipc.emit("message", {
      type: "hostCapabilities",
      capabilities: ["background-ax-v1", "computer-cooperation-v1", "takeover-reservation-v1"],
    });
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
      const initial = h.broker.invoke("t", "s", {
        op: "type",
        appId: "com.apple.TextEdit",
        text: "x",
      });
      await approveBackgroundSession(h);
      await initial;
      h.ipc.emit("message", {
        type: "chromeLeaseChanged",
        holder: {
          profileId: "p",
          threadId: "chrome-thread",
          sessionGeneration: "chrome-gen",
          provider: "claude",
        },
      });
      h.broker.reportChromeCalls("chrome-thread", "chrome-gen", true);
      h.ipc.messages.length = 0;
      const failed = h.broker.requestForeground("t", "s", "TextEdit", "Drag");
      const rejected = expect(failed).rejects.toThrow(
        'Busy: Chrome is held by thread "Chrome work" (working).',
      );
      await vi.waitFor(() =>
        expect(h.ipc.messages.some((m) => m.type === "foregroundTakeoverAcquire")).toBe(true),
      );
      const acquire = h.ipc.messages.findLast((m) => m.type === "foregroundTakeoverAcquire");
      if (acquire?.type !== "foregroundTakeoverAcquire") throw new Error("no acquire");
      h.ipc.emit("message", {
        type: "response",
        requestId: acquire.requestId,
        error: {
          _tag: "Busy",
          holder: "same-profile",
          resource: "chrome",
          holderThreadId: "chrome-thread",
        },
      });
      await rejected;
    } finally {
      h.broker.close();
    }
  });
  it("abandons an acquisition waiting for another agent when the turn ends", async () => {
    const h = await harness();
    h.ipc.emit("message", { type: "hostCapabilities", capabilities: ["computer-cooperation-v1"] });
    h.ipc.holdAcquires = true;
    try {
      const pending = h.broker.invoke("t", "s", { op: "type", text: "x" }, 12_000);
      const rejected = expect(pending).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
      await vi.waitFor(() =>
        expect(h.ipc.messages.some((m) => m.type === "leaseAcquire")).toBe(true),
      );
      const acquire = h.ipc.messages.findLast((m) => m.type === "leaseAcquire");
      if (acquire?.type !== "leaseAcquire") throw new Error("no acquire");
      expect(acquire.waitMs).toBeGreaterThan(0);
      expect(acquire.waitMs).toBeLessThanOrEqual(7000);
      h.broker.endTurn("t", "turn", "s");
      await rejected;
      expect(h.ipc.messages).toContainEqual({ type: "cancel", requestId: acquire.requestId });
      expect(h.ipc.messages.filter((m) => m.type === "request")).toEqual([]);
    } finally {
      h.broker.close();
    }
  });
  it.each([7000, 12_000])(
    "keeps retry admission and dispatch inside the original invocation budget: admission=%s",
    async (admissionMs) => {
      const h = await backgroundHarness();
      try {
        const initial = h.broker.invoke("t", "s", {
          op: "type",
          appId: "com.apple.TextEdit",
          text: "x",
        });
        await approveBackgroundSession(h);
        await initial;
        h.ipc.emit("message", {
          type: "hostCapabilities",
          capabilities: ["background-ax-v1", "computer-cooperation-v1"],
        });
        h.ipc.messages.length = 0;
        let elapsed = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        const send = h.ipc.send.bind(h.ipc);
        let acquisitions = 0;
        const forwarding = vi.spyOn(h.ipc, "send").mockImplementation((raw, callback) => {
          const message = raw as DesktopComputerHostMessage;
          if (message.type === "request") elapsed = 19_000;
          if (message.type === "leaseAcquire" && ++acquisitions === 2) elapsed += admissionMs;
          return send(raw, callback);
        });
        try {
          h.ipc.requestErrors.push({ _tag: "TargetBlocked", kind: "foreground-busy" });
          const pending = h.broker.invoke(
            "t",
            "s",
            { op: "type", appId: "com.apple.TextEdit", text: "x" },
            30_000,
          );
          if (admissionMs === 7000) await expect(pending).resolves.toEqual({ ok: true });
          else await expect(pending).rejects.toMatchObject({ error: { _tag: "Execution" } });
          const acquires = h.ipc.messages.filter((m) => m.type === "leaseAcquire");
          expect(acquires.map((m) => (m.type === "leaseAcquire" ? m.waitMs : undefined))).toEqual([
            20_000, 6000,
          ]);
          const requests = h.ipc.messages.filter((m) => m.type === "request");
          expect(requests).toHaveLength(admissionMs === 7000 ? 2 : 1);
          if (admissionMs === 7000)
            expect(requests[1]!.request.deadlineAtMs - Date.now()).toBeLessThanOrEqual(4000);
        } finally {
          forwarding.mockRestore();
          clock.mockRestore();
        }
      } finally {
        h.broker.close();
      }
    },
  );
  it.each(["foreground-busy", "user-active"] as const)(
    "retries only a pre-write background foreground conflict: %s",
    async (kind) => {
      const h = await backgroundHarness();
      const dispatched = vi.fn();
      try {
        const initial = h.broker.invoke("t", "s", {
          op: "type",
          appId: "com.apple.TextEdit",
          text: "x",
        });
        await approveBackgroundSession(h);
        await initial;
        const invalidated = vi.fn();
        h.broker.subscribe((event) => {
          if (event.channel === "computer.observations.invalidated") invalidated();
        });
        h.ipc.messages.length = 0;
        h.ipc.requestErrors.push({ _tag: "TargetBlocked", kind });
        const pending = h.broker.invoke(
          "t",
          "s",
          { op: "type", appId: "com.apple.TextEdit", text: "x" },
          30_000,
          { onDispatch: dispatched },
        );
        if (kind === "user-active")
          await expect(pending).rejects.toMatchObject({ error: { kind } });
        else await expect(pending).resolves.toEqual({ ok: true });
        const requests = h.ipc.messages.filter((m) => m.type === "request");
        expect(requests).toHaveLength(kind === "user-active" ? 1 : 2);
        expect(new Set(requests.map((m) => m.type === "request" && m.request.requestId)).size).toBe(
          requests.length,
        );
        expect(dispatched).toHaveBeenCalledTimes(1);
        expect(invalidated).toHaveBeenCalledTimes(1);
      } finally {
        h.broker.close();
      }
    },
  );
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
        condition: { appId: "com.apple.TextEdit", role: "AXButton", name: "Ready" },
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
        condition: { appId: "com.apple.TextEdit", name: "Ready" },
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

it("keeps sent actions and pending consent through yielding, publishes the wait after release, and clears it on turn end", async () => {
  const h = await harness();
  try {
    h.ipc.emit("message", {
      type: "hostCapabilities",
      capabilities: ["background-ax-v1", "computer-cooperation-v1"],
    });
    h.ipc.holdRequests = true;
    const mutation = h.broker.invoke("t", "s", { op: "type", text: "confirmed once" });
    await vi.waitFor(() =>
      expect(
        h.ipc.messages.some(
          (message) => message.type === "request" && message.request.op === "type",
        ),
      ).toBe(true),
    );
    const requested = h.ipc.messages.findLast((message) => message.type === "request");
    const consent = h.broker.access.requestAccess(
      "t",
      "turn",
      [
        {
          appId: "com.apple.Notes",
          name: "Notes",
          tier: "full",
          running: true,
          frontmost: false,
        },
      ],
      "Access another app",
    );
    expect(h.broker.access.pendingRequests()).toHaveLength(1);
    h.ipc.emit("message", { type: "targetYielded", threadId: "t", sessionGeneration: "s" });
    h.ipc.emit("message", { type: "leasesChanged", holders: [], otherProfile: false });
    expect(h.broker.pause.has("t")).toBe(false);
    expect(h.broker.access.pendingRequests()).toHaveLength(1);
    expect(h.broker.computerUse().holders).toContainEqual(
      expect.objectContaining({
        threadId: "t",
        state: "waiting-user",
        leaseHeld: false,
      }),
    );
    expect(
      h.ipc.messages.some(
        (message) =>
          message.type === "cancel" &&
          requested?.type === "request" &&
          message.requestId === requested.request.requestId,
      ),
    ).toBe(false);
    h.ipc.finish({ actionCompleted: true, screenshotError: "Interrupted" });
    await expect(mutation).resolves.toMatchObject({ actionCompleted: true });
    h.broker.endTurn("t", "turn", "s");
    expect(h.ipc.messages).toContainEqual({
      type: "computerTurnEnded",
      threadId: "t",
      sessionGeneration: "s",
      turnId: "turn",
    });
    expect(h.broker.computerUse().holders).toEqual([]);
    expect(h.broker.access.pendingRequests()).toEqual([]);
    await consent;
  } finally {
    h.broker.close();
  }
});

it("uses the existing per-thread wait slot for foreground availability and validates app access without prompting", async () => {
  const h = await harness();
  try {
    h.broker.beginTurn("t", "turn");
    h.ipc.emit("message", {
      type: "hostCapabilities",
      capabilities: ["background-ax-v1", "computer-cooperation-v1"],
    });
    const pending = h.broker.waitForTarget("t", "s", { timeoutMs: 5000 });
    await vi.waitFor(() =>
      expect(h.ipc.messages.some((message) => message.type === "targetWait")).toBe(true),
    );
    await expect(h.broker.waitForTarget("t", "s", {})).rejects.toMatchObject({
      error: { _tag: "Busy" },
    });
    const request = h.ipc.messages.findLast((message) => message.type === "targetWait");
    if (request?.type !== "targetWait") throw new Error("Availability request missing");
    expect(request).not.toHaveProperty("appId");
    h.ipc.emit("message", {
      type: "response",
      requestId: request.requestId,
      result: { available: true, timedOut: false, requiresFreshObservation: true },
    });
    await expect(pending).resolves.toEqual({
      available: true,
      timedOut: false,
      requiresFreshObservation: true,
    });
    h.ipc.appResults = [
      { appId: "not-granted", name: "Other", tier: "full", running: true, frontmost: false },
    ];
    await expect(h.broker.waitForTarget("t", "s", { app: "Other" })).rejects.toMatchObject({
      error: { _tag: "NotGranted" },
    });
    expect(h.ipc.messages.some((message) => message.type === "accessRequested")).toBe(false);
    expect(
      h.ipc.messages.some(
        (message) =>
          message.type === "request" && ["screenshot", "inspect"].includes(message.request.op),
      ),
    ).toBe(false);
  } finally {
    h.broker.close();
  }
});

it("ends target waits at the deadline as timeouts, letting the desktop answer first with its reason", async () => {
  const h = await harness();
  try {
    h.broker.beginTurn("t", "turn");
    h.ipc.emit("message", {
      type: "hostCapabilities",
      capabilities: ["background-ax-v1", "computer-cooperation-v1"],
    });
    const targetWaits = () =>
      h.ipc.messages.flatMap((message) => (message.type === "targetWait" ? [message] : []));

    // The desktop gets less than the broker's budget and its timeout passes through intact.
    const answered = h.broker.waitForTarget("t", "s", { timeoutMs: 5000 });
    await vi.waitFor(() => expect(targetWaits()).toHaveLength(1));
    const first = targetWaits()[0]!;
    expect(first.timeoutMs).toBeLessThanOrEqual(5000 - COMPUTER_TARGET_WAIT_DESKTOP_MARGIN_MS);
    expect(first.timeoutMs).toBeGreaterThan(4000);
    h.ipc.emit("message", {
      type: "response",
      requestId: first.requestId,
      result: {
        available: false,
        timedOut: true,
        reason: "user-active",
        detail: "input-held",
        requiresFreshObservation: true,
      },
    });
    await expect(answered).resolves.toMatchObject({
      available: false,
      timedOut: true,
      reason: "user-active",
      detail: "input-held",
    });

    // A desktop that never answers still ends in a timeout, not an interruption. The budget
    // leaves slow runners ample time to dispatch the request before the broker deadline.
    const silent = h.broker.waitForTarget("t", "s", { timeoutMs: 2000 });
    await vi.waitFor(() => expect(targetWaits()).toHaveLength(2));
    const second = targetWaits()[1]!;
    await expect(silent).resolves.toMatchObject({ available: false, timedOut: true });
    expect(h.ipc.messages).toContainEqual({ type: "cancel", requestId: second.requestId });

    // A pause keeps its own cause instead of reading as a turn end.
    const paused = h.broker.waitForTarget("t", "s", { timeoutMs: 5000 });
    await vi.waitFor(() => expect(targetWaits()).toHaveLength(3));
    h.broker.setPaused("t", true);
    await expect(paused).rejects.toMatchObject({
      error: { _tag: "Interrupted", cause: "paused" },
    });
    h.broker.setPaused("t", false);

    // A turn that really ends still interrupts the wait.
    const ended = h.broker.waitForTarget("t", "s", { timeoutMs: 5000 });
    await vi.waitFor(() => expect(targetWaits()).toHaveLength(4));
    h.broker.endTurn("t", "turn", "s");
    await expect(ended).rejects.toMatchObject({
      error: { _tag: "Interrupted", cause: "turn-ended" },
    });
  } finally {
    h.broker.close();
  }
});
