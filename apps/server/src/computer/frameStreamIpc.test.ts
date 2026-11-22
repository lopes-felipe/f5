import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BackendFrameDecoder, encodeBackendFrame } from "@t3tools/shared/backendFrames";
import { DesktopComputerHost } from "./DesktopComputerHost";
import { frameStreamIpc, reopenCloseOnExec } from "./frameStreamIpc";

function pair() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, ipc: frameStreamIpc(input, output) };
}

function written(output: PassThrough): unknown[] {
  const chunk = output.read() as Buffer | null;
  return chunk ? new BackendFrameDecoder().push(chunk) : [];
}

describe("frameStreamIpc", () => {
  it("carries messages both ways as frames", async () => {
    const { input, output, ipc } = pair();
    const received: unknown[] = [];
    ipc.on("message", (message: unknown) => received.push(message));
    const frame = encodeBackendFrame({ type: "status", ok: true });
    input.write(frame.subarray(0, 3));
    input.write(frame.subarray(3));
    await vi.waitFor(() => expect(received).toEqual([{ type: "status", ok: true }]));
    const callback = vi.fn();
    ipc.send!({ type: "hello" }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null));
    expect(written(output)).toEqual([{ type: "hello" }]);
  });

  it("disconnects on malformed input and refuses further sends", async () => {
    const { input, ipc } = pair();
    const disconnected = vi.fn();
    ipc.on("disconnect", disconnected);
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(4, 0);
    bad.write("{{{{", 4);
    input.write(bad);
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    expect(ipc.connected).toBe(false);
    const callback = vi.fn();
    expect(ipc.send!({ type: "late" }, callback)).toBe(false);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
  });

  it("disconnects once at end of stream", async () => {
    const { input, ipc } = pair();
    const disconnected = vi.fn();
    ipc.on("disconnect", disconnected);
    input.end();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
    input.destroy();
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
});

describe("reopenCloseOnExec", () => {
  it("reopens the inherited fd through /proc and closes the original", () => {
    const fs = { openSync: vi.fn(() => 41), closeSync: vi.fn() };
    expect(reopenCloseOnExec(3, "read", fs as never)).toBe(41);
    expect(fs.openSync).toHaveBeenCalledWith(
      "/proc/self/fd/3",
      FS.constants.O_RDONLY | FS.constants.O_NONBLOCK,
    );
    expect(fs.closeSync).toHaveBeenCalledWith(3);
    reopenCloseOnExec(4, "write", fs as never);
    expect(fs.openSync).toHaveBeenLastCalledWith(
      "/proc/self/fd/4",
      FS.constants.O_WRONLY | FS.constants.O_NONBLOCK,
    );
  });

  it("keeps the inherited fd where /proc isn't available", () => {
    const fs = {
      openSync: vi.fn(() => {
        throw new Error("ENOENT");
      }),
      closeSync: vi.fn(),
    };
    expect(reopenCloseOnExec(3, "read", fs as never)).toBe(3);
    expect(fs.closeSync).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "linux")("reopens real pipe ends on Linux", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-frames-"));
    try {
      const fifo = Path.join(dir, "channel");
      execFileSync("mkfifo", [fifo]);
      const read = FS.openSync(fifo, FS.constants.O_RDONLY | FS.constants.O_NONBLOCK);
      const write = FS.openSync(fifo, FS.constants.O_WRONLY | FS.constants.O_NONBLOCK);
      const privateRead = reopenCloseOnExec(read, "read");
      const privateWrite = reopenCloseOnExec(write, "write");
      expect(privateRead).not.toBe(read);
      expect(() => FS.fstatSync(read)).toThrow();
      expect(() => FS.fstatSync(write)).toThrow();
      FS.writeSync(privateWrite, "frame");
      const buffer = Buffer.alloc(5);
      expect(FS.readSync(privateRead, buffer)).toBe(5);
      expect(buffer.toString()).toBe("frame");
      FS.closeSync(privateRead);
      FS.closeSync(privateWrite);
    } finally {
      FS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DesktopComputerHost.fromEnvironment", () => {
  const hostProfileId = "0123456789abcdef0123456789abcdef";
  const incarnation = "11111111-2222-4333-8444-555555555555";

  it("says hello over frames with the profile main launched, not the guest's own", async () => {
    const { output, ipc } = pair();
    const host = DesktopComputerHost.fromEnvironment(
      "guest-local-default",
      {
        F5_DESKTOP_COMPUTER_HOST: "frames",
        F5_DESKTOP_PROFILE_ID: hostProfileId,
        F5_DESKTOP_BACKEND_INCARNATION: incarnation,
      },
      () => ipc,
    );
    expect(host.profileId).toBe(hostProfileId);
    await vi.waitFor(() =>
      expect(written(output)).toEqual([
        expect.objectContaining({
          type: "hello",
          profileId: hostProfileId,
          backendIncarnation: incarnation,
        }),
      ]),
    );
    host.close();
  });

  it("stays disconnected without a valid host profile id", () => {
    const guestIpc = vi.fn();
    const host = DesktopComputerHost.fromEnvironment(
      "default",
      { F5_DESKTOP_COMPUTER_HOST: "frames", F5_DESKTOP_PROFILE_ID: "../x" },
      guestIpc,
    );
    expect(guestIpc).not.toHaveBeenCalled();
    expect(host.status()).toEqual({ available: false, reason: "no-host" });
  });
});
