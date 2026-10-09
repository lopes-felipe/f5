import { EventEmitter } from "node:events";
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
  busy = false;
  send(raw: unknown, callback: (error: Error | null) => void) {
    const message = raw as DesktopComputerHostMessage;
    this.messages.push(message);
    callback(null);
    if (message.type === "hello")
      queueMicrotask(() => this.emit("message", { type: "status", status: { available: true } }));
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
    if (message.type === "request" && !this.holdRequests)
      queueMicrotask(() =>
        this.emit("message", {
          type: "response",
          requestId: message.request.requestId,
          result:
            message.request.op === "resolveApps" && this.appResults
              ? this.appResults
              : { ok: true },
        }),
      );
    return true;
  }
  finish() {
    const request = this.messages.findLast((message) => message.type === "request");
    if (request?.type === "request")
      this.emit("message", {
        type: "response",
        requestId: request.request.requestId,
        result: { ok: true },
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
  it("restores anonymous contention and paused controls in a reconnect snapshot", async () => {
    const h = await harness();
    try {
      h.ipc.emit("message", { type: "leaseChanged", holder: null, otherProfile: true });
      h.broker.setPaused("t", true);
      expect(h.broker.snapshot()).toMatchObject({
        holder: null,
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
      h.ipc.emit("message", {
        type: "killSwitch",
        threadId: "t",
        sessionGeneration: "old",
        turnId: "turn",
      });
      expect(events).toEqual([]);
      h.broker.endTurn("t", "turn", "s");
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
