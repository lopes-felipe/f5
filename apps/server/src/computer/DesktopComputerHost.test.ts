import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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
  it("sends an incarnation-bound hello and treats invalid host data as loss", () => {
    const ipc = new Ipc();
    const host = new DesktopComputerHost("p", "i", ipc, true);
    expect(ipc.messages[0]).toEqual({
      type: "hello",
      profileId: "p",
      backendIncarnation: "i",
      protocolVersion: 1,
    });
    ipc.emit("message", { type: "response", requestId: 3 });
    expect(host.hasHost()).toBe(false);
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
});
