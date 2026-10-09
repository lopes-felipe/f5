import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ComputerHostChannel } from "./ComputerHostChannel";
import type { ComputerController } from "./ComputerController";
function setup() {
  const controller = { disconnect: vi.fn(), lease: { current: () => null }, invoke: vi.fn() };
  const channel = new ComputerHostChannel(
    controller as unknown as ComputerController,
    () => ({ available: true }),
    vi.fn(),
  );
  const process = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
    disconnect: vi.fn(),
  });
  channel.register("profile", "incarnation", process as unknown as ChildProcess);
  const hello = () =>
    process.emit("message", {
      type: "hello",
      profileId: "profile",
      backendIncarnation: "incarnation",
      protocolVersion: 1,
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
    };
    h.channel.publishLease(holder);
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
    expect(() => h.channel.answerAccess("other", answer)).toThrow();
    expect(() =>
      h.channel.answerAccess("profile", { ...answer, backendIncarnation: "old" }),
    ).toThrow();
    h.channel.answerAccess("profile", answer);
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
