import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { watchLauncher } from "./activation";

describe("launcher shutdown IPC", () => {
  it("routes launcher loss and stop through orderly shutdown, ignoring other messages", () => {
    const host = Object.assign(new EventEmitter(), { env: { F5_LAUNCHER_CHILD: "1" } });
    const stop = vi.fn();
    watchLauncher(host, stop);
    host.emit("message", { type: "activate" });
    host.emit("message", null);
    expect(stop).not.toHaveBeenCalled();
    host.emit("message", { type: "stop" });
    expect(stop).toHaveBeenCalledTimes(1);
    host.emit("disconnect");
    expect(stop).toHaveBeenCalledTimes(2);
  });
  it("does not let an unmanaged process consume shutdown messages", () => {
    const host = Object.assign(new EventEmitter(), { env: {} });
    const stop = vi.fn();
    watchLauncher(host, stop);
    host.emit("message", { type: "stop" });
    host.emit("disconnect");
    expect(stop).not.toHaveBeenCalled();
  });
});
