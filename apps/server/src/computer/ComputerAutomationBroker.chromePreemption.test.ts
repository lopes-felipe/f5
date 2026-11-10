import { EventEmitter } from "node:events";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { describe, expect, it } from "vitest";
import type { ChromeLeaseHolder, DesktopComputerHostMessage } from "@t3tools/contracts";
import { ComputerAutomationBrokerRuntime, type ChromeReleaser } from "./ComputerAutomationBroker";
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

/** A session's releaser; counts how often it is asked to release. */
function releaser(
  release: () => boolean | Promise<boolean>,
  idle: () => boolean = () => true,
): ChromeReleaser & { asked: () => number } {
  let asked = 0;
  return {
    idle,
    release: () => {
      asked += 1;
      return release();
    },
    asked: () => asked,
  };
}

describe("Chrome lease preemption", () => {
  it("releases an idle holder in this profile and retries once", async () => {
    const { ipc, broker } = await harness();
    // Main observes the stopped CLI exit, then reports the lease gone.
    const a = releaser(async () => {
      setTimeout(() => ipc.setChrome(null), 10);
      return true;
    });
    broker.registerChromeReleaser("a", "gen-a", a);
    await broker.acquireChromeLease(holderB);
    expect(a.asked()).toBe(1);
    expect(ipc.acquires()).toBe(2);
    expect(ipc.chrome?.threadId).toBe("b");
  });

  it("names a working holder instead of preempting it", async () => {
    const { ipc, broker } = await harness();
    const a = releaser(() => true);
    broker.registerChromeReleaser("a", "gen-a", a);
    broker.reportChromeCalls("a", "gen-a", true);
    const error = await refusal(broker.acquireChromeLease(holderB));
    expect(a.asked()).toBe(0);
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

  it("never preempts a holder whose own work (background tasks, compaction) is running", async () => {
    const { ipc, broker } = await harness();
    let busy = true;
    const a = releaser(
      () => true,
      () => !busy,
    );
    broker.registerChromeReleaser("a", "gen-a", a);
    expect(broker.chromeHolderIdle("a", "gen-a")).toBe(false);
    const error = await refusal(broker.acquireChromeLease(holderB));
    expect(a.asked()).toBe(0);
    expect(ipc.acquires()).toBe(1);
    expect(error.error).toMatchObject({ holderIdle: false });
    busy = false;
    expect(broker.chromeHolderIdle("a", "gen-a")).toBe(true);
  });

  it("never preempts a holder that is mid-turn", async () => {
    const { ipc, broker } = await harness();
    broker.bindSession("a", "gen-a", "claude");
    broker.beginTurn("a", "turn-1");
    const a = releaser(() => true);
    broker.registerChromeReleaser("a", "gen-a", a);
    const error = await refusal(broker.acquireChromeLease(holderB));
    expect(a.asked()).toBe(0);
    expect(ipc.acquires()).toBe(1);
    expect(error.error).toMatchObject({ holderIdle: false });
    // Once the turn ends, the same holder is idle and gives way.
    broker.endTurn("a", "turn-1");
    const later = releaser(() => {
      setTimeout(() => ipc.setChrome(null), 10);
      return true;
    });
    broker.registerChromeReleaser("a", "gen-a", later);
    await broker.acquireChromeLease(holderB);
    expect(later.asked()).toBe(1);
  });

  it("gives up at once when the holder refuses under its lock, without waiting out the timeout", async () => {
    const { ipc, broker } = await harness();
    // Idle when asked, but a turn started before the session took its lock.
    broker.registerChromeReleaser(
      "a",
      "gen-a",
      releaser(async () => false),
    );
    const started = Date.now();
    expect(await broker.releaseChromeHolderOutcome("a", 5_000)).toBe("working");
    expect(Date.now() - started).toBeLessThan(1_000);
    const refused = await refusal(broker.acquireChromeLease(holderB));
    expect(refused.error).toMatchObject({ holderIdle: true, threadTitle: "Thread A" });
    expect(ipc.acquires()).toBe(1);
  });

  it("reports why a release didn't happen", async () => {
    const { ipc, broker } = await harness();
    // No releaser registered: nothing can give the lease up.
    expect(await broker.releaseChromeHolderOutcome("a", 20)).toBe("not-holder");
    // Accepted, but main never reports the lease gone.
    broker.registerChromeReleaser(
      "a",
      "gen-a",
      releaser(() => true),
    );
    expect(await broker.releaseChromeHolderOutcome("a", 20)).toBe("timeout");
    expect(ipc.chrome?.threadId).toBe("a");
    // Another thread holds Chrome.
    expect(await broker.releaseChromeHolderOutcome("b", 20)).toBe("not-holder");
  });

  it("leaves the holder's state unstated when this broker hasn't seen it yet", async () => {
    const { broker } = await harness();
    const error = await broker.attributeBusy(
      new ComputerControlError({
        _tag: "Busy",
        holder: "same-profile",
        resource: "chrome",
        holderThreadId: "not-reported-yet",
      }),
    );
    expect((error as ComputerControlError).error).not.toHaveProperty("holderIdle");
    expect((error as ComputerControlError).message).toBe(
      "Busy: Chrome is held by another thread. F5 releases idle holders automatically; if it's working, wait or ask the user to stop it.",
    );
  });

  it("frees Chrome before a native lease it would block, so main's queue doesn't wait on it", async () => {
    const { ipc, broker } = await harness();
    const a = releaser(() => {
      setTimeout(() => ipc.setChrome(null), 10);
      return true;
    });
    broker.registerChromeReleaser("a", "gen-a", a);
    // A background lease on an app that isn't a browser coexists with Chrome.
    await broker.preemptChromeFor("b", { kind: "app", appId: "com.apple.TextEdit" });
    expect(a.asked()).toBe(0);
    // The holder's own native work never preempts itself.
    await broker.preemptChromeFor("a", { kind: "foreground" });
    expect(a.asked()).toBe(0);
    // A working holder keeps Chrome; main queues the request behind it.
    broker.reportChromeCalls("a", "gen-a", true);
    await broker.preemptChromeFor("b", { kind: "foreground" });
    expect(a.asked()).toBe(0);
    broker.reportChromeCalls("a", "gen-a", false);
    await broker.preemptChromeFor("b", { kind: "foreground" });
    expect(a.asked()).toBe(1);
    expect(ipc.chrome).toBeNull();
  });

  it("leaves other profiles' holders anonymous and alone", async () => {
    const { ipc, broker } = await harness();
    ipc.setChrome({ ...holderA, profileId: "other" });
    const a = releaser(() => true);
    broker.registerChromeReleaser("a", "gen-a", a);
    expect(await broker.releaseChromeHolderOutcome("a", 20)).toBe("not-holder");
    expect(a.asked()).toBe(0);
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

/** Main with another profile holding Chrome, which lets go when asked while idle. */
class CrossProfileIpc extends Ipc {
  otherHeld = true;
  otherAnswer: "released" | "working" = "released";
  override send(raw: unknown, callback: (error: Error | null) => void) {
    const message = raw as DesktopComputerHostMessage;
    if (message.type === "hello") {
      this.messages.push(message);
      callback(null);
      queueMicrotask(() => {
        this.emit("message", { type: "hostCapabilities", capabilities: ["chrome-release-v1"] });
        this.emit("message", { type: "status", status: { available: true } });
      });
      return true;
    }
    if (message.type === "chromeLeaseAcquire" && this.otherHeld) {
      this.messages.push(message);
      callback(null);
      queueMicrotask(() =>
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          error: {
            _tag: "Busy",
            holder: "other-profile",
            resource: "chrome",
            activity: "chrome-session",
          },
        }),
      );
      return true;
    }
    if (message.type === "chromeHolderRelease") {
      this.messages.push(message);
      callback(null);
      queueMicrotask(() => {
        if (this.otherAnswer === "released") this.otherHeld = false;
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          result: this.otherAnswer,
        });
      });
      return true;
    }
    return super.send(raw, callback);
  }
}

describe("Chrome lease preemption across profiles", () => {
  async function crossHarness() {
    const ipc = new CrossProfileIpc();
    const host = new DesktopComputerHost("p", "backend", ipc, true);
    const broker = new ComputerAutomationBrokerRuntime(host, {
      resolve: async () => {
        throw new Error("unused");
      },
      platform: "darwin",
      storage: { load: async () => [], save: async () => {} },
    });
    await broker.initialize();
    return { ipc, broker };
  }

  it("asks main to release another profile's idle holder and retries once", async () => {
    const { ipc, broker } = await crossHarness();
    await broker.acquireChromeLease(holderB);
    expect(ipc.messages.filter((message) => message.type === "chromeHolderRelease")).toHaveLength(
      1,
    );
    expect(ipc.acquires()).toBe(2);
    expect(ipc.chrome?.threadId).toBe("b");
    broker.close();
  });

  it("keeps the refusal when the other profile's holder is working", async () => {
    const { ipc, broker } = await crossHarness();
    ipc.otherAnswer = "working";
    const error = await refusal(broker.acquireChromeLease(holderB));
    expect(error.error).toMatchObject({ _tag: "Busy", holder: "other-profile" });
    expect(ipc.acquires()).toBe(1);
    broker.close();
  });

  it("answers main's release request for this profile's idle holder", async () => {
    const { ipc, broker } = await harness();
    const a = releaser(async () => {
      setTimeout(() => ipc.setChrome(null), 10);
      return true;
    });
    broker.registerChromeReleaser("a", "gen-a", a);
    const results = () => ipc.messages.filter((message) => message.type === "chromeReleaseResult");
    ipc.emit("message", {
      type: "chromeReleaseRequest",
      requestId: "stale",
      threadId: "a",
      sessionGeneration: "old",
    });
    ipc.emit("message", {
      type: "chromeReleaseRequest",
      requestId: "live",
      threadId: "a",
      sessionGeneration: "gen-a",
    });
    await expect.poll(() => results().length).toBe(2);
    expect(results()).toEqual(
      expect.arrayContaining([
        { type: "chromeReleaseResult", requestId: "stale", outcome: "not-holder" },
        { type: "chromeReleaseResult", requestId: "live", outcome: "released" },
      ]),
    );
    expect(a.asked()).toBe(1);
    broker.close();
  });
});
