import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DesktopComputerHost, type ComputerIpcProcess } from "./DesktopComputerHost";
class Ipc extends EventEmitter {
  connected = true;
  messages: unknown[] = [];
  send(message: unknown, callback: (error: Error | null) => void) {
    this.messages.push(message);
    callback(null);
    return true;
  }
}
describe("private desktop host", () => {
  it("has no host in web/headless mode", () => {
    const host = new DesktopComputerHost("p", "i", new Ipc(), false);
    expect(host.status()).toEqual({ available: false, reason: "no-host" });
  });
  it("notifies listeners only once when multiple owners close the host", () => {
    const host = new DesktopComputerHost("p", "i", new Ipc(), true);
    const listener = vi.fn();
    host.onMessage(listener);
    host.close();
    const calls = listener.mock.calls.length;
    host.close();
    expect(listener).toHaveBeenCalledTimes(calls);
  });
  it("sends an incarnation-bound hello and treats invalid host data as loss", () => {
    const ipc = new Ipc();
    const host = new DesktopComputerHost("p", "i", ipc, true);
    expect(ipc.messages[0]).toEqual({
      type: "hello",
      profileId: "p",
      backendIncarnation: "i",
      protocolVersion: 1,
      capabilities: [
        "scheduled-notifications-v1",
        "open-external-url-v1",
        "background-ax-v1",
        "computer-agent-identity-v1",
        "computer-activity-correlation-v1",
      ],
    });
    expect(host.backgroundCapable()).toBe(false);
    ipc.emit("message", { type: "hostCapabilities", capabilities: ["background-ax-v1"] });
    expect(host.backgroundCapable()).toBe(true);
    ipc.emit("message", { type: "response", requestId: 3 });
    expect(host.hasHost()).toBe(false);
    expect(host.backgroundCapable()).toBe(false);
    host.close();
  });
  it("reports ambiguity for mutations and interruption for observations on disconnect", async () => {
    const ipc = new Ipc();
    const host = new DesktopComputerHost("p", "i", ipc as ComputerIpcProcess, true);
    const mutation = host.correlated({ type: "cancel", requestId: "m" }, 1000, true);
    const observe = host.correlated({ type: "cancel", requestId: "o" }, 1000, false);
    ipc.emit("disconnect");
    await expect(mutation).rejects.toMatchObject({ error: { _tag: "OutcomeUnknown" } });
    await expect(observe).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
    host.close();
  });
  it("gates browser requests, correlates results, and resolves pending requests on disconnect", async () => {
    const ipc = new Ipc();
    const host = new DesktopComputerHost("p", "i", ipc, true);
    expect(await host.openExternalUrl("https://example.com")).toBe("unavailable");
    ipc.emit("message", { type: "hostCapabilities", capabilities: ["open-external-url-v1"] });
    const response = host.openExternalUrl("https://example.com");
    const message = ipc.messages.at(-1) as { id: string };
    expect(message).toMatchObject({ type: "openExternalUrlRequest", url: "https://example.com" });
    ipc.emit("message", { type: "openExternalUrlResult", id: "wrong", status: "denied" });
    ipc.emit("message", { type: "openExternalUrlResult", id: message.id, status: "copied" });
    expect(await response).toBe("copied");
    const lost = host.openExternalUrl("https://example.com");
    ipc.emit("disconnect");
    expect(await lost).toBe("unavailable");
    host.close();
  });
  it("bounds the wait for a capable but unresponsive host", async () => {
    vi.useFakeTimers();
    try {
      const ipc = new Ipc();
      const host = new DesktopComputerHost("p", "i", ipc, true);
      ipc.emit("message", { type: "hostCapabilities", capabilities: ["open-external-url-v1"] });
      const result = host.openExternalUrl("https://example.com");
      await vi.advanceTimersByTimeAsync(330_000);
      expect(await result).toBe("unavailable");
      host.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
