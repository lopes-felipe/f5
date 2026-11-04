import { EventEmitter } from "node:events";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { describe, expect, it } from "vitest";
import type { ChromeLeaseHolder, DesktopComputerHostMessage } from "@t3tools/contracts";
import { ComputerAutomationBrokerRuntime } from "./ComputerAutomationBroker";
import { DesktopComputerHost } from "./DesktopComputerHost";

const holderA: ChromeLeaseHolder = {
  profileId: "p",
  threadId: "a",
  sessionGeneration: "gen-a",
  provider: "claude",
};
const holderB: ChromeLeaseHolder = { ...holderA, threadId: "b", sessionGeneration: "gen-b" };

/** Main's side: one Chrome lease, refused with an attributed `Busy` while held. */
class Ipc extends EventEmitter {
  connected = true;
  messages: DesktopComputerHostMessage[] = [];
  chrome: ChromeLeaseHolder | null = null;
  send(raw: unknown, callback: (error: Error | null) => void) {
    const message = raw as DesktopComputerHostMessage;
    this.messages.push(message);
    callback(null);
    if (message.type === "hello")
      queueMicrotask(() => this.emit("message", { type: "status", status: { available: true } }));
    if (message.type === "chromeLeaseAcquire")
      queueMicrotask(() => {
        const held = this.chrome;
        if (held && held.threadId !== message.holder.threadId) {
          this.emit("message", {
            type: "response",
            requestId: message.requestId,
            error: {
              _tag: "Busy",
              holder: "same-profile",
              resource: "chrome",
              holderThreadId: held.threadId,
            },
          });
          return;
        }
        this.setChrome(message.holder);
        this.emit("message", { type: "response", requestId: message.requestId, result: true });
      });
    return true;
  }
  setChrome(holder: ChromeLeaseHolder | null) {
    this.chrome = holder;
    this.emit("message", { type: "chromeLeaseChanged", holder });
  }
  acquires() {
    return this.messages.filter((message) => message.type === "chromeLeaseAcquire").length;
  }
}

async function harness() {
  const ipc = new Ipc();
  const host = new DesktopComputerHost("p", "backend", ipc, true);
  const broker = new ComputerAutomationBrokerRuntime(host, {
    resolve: async () => {
      throw new Error("unused");
    },
    threadTitle: async (threadId) => (threadId === "a" ? "Thread A" : undefined),
    platform: "darwin",
    storage: { load: async () => [], save: async () => {} },
  });
  await broker.initialize();
  ipc.setChrome(holderA);
  return { ipc, broker };
}

async function refusal(promise: Promise<unknown>): Promise<ComputerControlError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ComputerControlError);
  return error as ComputerControlError;
}

describe("Chrome lease preemption", () => {
  it("releases an idle holder in this profile and retries once", async () => {
    const { ipc, broker } = await harness();
    let asked = 0;
    broker.registerChromeReleaser("a", "gen-a", () => {
      asked += 1;
      // Main observes the stopped CLI exit, then reports the lease gone.
      setTimeout(() => ipc.setChrome(null), 10);
      return true;
    });
    await broker.acquireChromeLease(holderB);
    expect(asked).toBe(1);
    expect(ipc.acquires()).toBe(2);
    expect(ipc.chrome?.threadId).toBe("b");
  });

  it("names a working holder instead of preempting it", async () => {
    const { ipc, broker } = await harness();
    let asked = 0;
    broker.registerChromeReleaser("a", "gen-a", () => {
      asked += 1;
      return true;
    });
    broker.reportChromeCalls("a", "gen-a", true);
    const error = await refusal(broker.acquireChromeLease(holderB));
    expect(asked).toBe(0);
    expect(ipc.acquires()).toBe(1);
    expect(error.error).toMatchObject({
      _tag: "Busy",
      resource: "chrome",
      holderThreadId: "a",
      threadTitle: "Thread A",
      holderIdle: false,
    });
    expect(error.message).toBe(
      'Busy: Chrome is held by thread "Thread A" (working). F5 releases idle holders automatically; if it\'s working, wait or ask the user to stop it.',
    );
  });

  it("never preempts a holder that is mid-turn", async () => {
    const { ipc, broker } = await harness();
    broker.bindSession("a", "gen-a", "claude");
    broker.beginTurn("a", "turn-1");
    let asked = 0;
    broker.registerChromeReleaser("a", "gen-a", () => {
      asked += 1;
      return true;
    });
    const error = await refusal(broker.acquireChromeLease(holderB));
    expect(asked).toBe(0);
    expect(ipc.acquires()).toBe(1);
    expect(error.error).toMatchObject({ holderIdle: false });
    // Once the turn ends, the same holder is idle and gives way.
    broker.endTurn("a", "turn-1");
    broker.registerChromeReleaser("a", "gen-a", () => {
      asked += 1;
      setTimeout(() => ipc.setChrome(null), 10);
      return true;
    });
    await broker.acquireChromeLease(holderB);
    expect(asked).toBe(1);
  });

  it("returns the attributed refusal when the holder refuses or doesn't release in time", async () => {
    const { ipc, broker } = await harness();
    broker.registerChromeReleaser("a", "gen-a", () => false);
    const refused = await refusal(broker.acquireChromeLease(holderB));
    expect(refused.error).toMatchObject({ holderIdle: true, threadTitle: "Thread A" });
    expect(ipc.acquires()).toBe(1);

    broker.registerChromeReleaser("a", "gen-a", () => true);
    expect(await broker.releaseChromeHolder("a", 20)).toBe(false);
    expect(ipc.chrome?.threadId).toBe("a");
  });

  it("leaves other profiles' holders anonymous and alone", async () => {
    const { ipc, broker } = await harness();
    ipc.setChrome({ ...holderA, profileId: "other" });
    let asked = 0;
    broker.registerChromeReleaser("a", "gen-a", () => {
      asked += 1;
      return true;
    });
    expect(await broker.releaseChromeHolder("a", 20)).toBe(false);
    expect(asked).toBe(0);
    const anonymous = await broker.attributeBusy(
      new ComputerControlError({ _tag: "Busy", holder: "other-profile", resource: "chrome" }),
    );
    expect((anonymous as ComputerControlError).error).toEqual({
      _tag: "Busy",
      holder: "other-profile",
      resource: "chrome",
    });
  });
});
