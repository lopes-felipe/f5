import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { BackendFrameDecoder, encodeBackendFrame } from "@t3tools/shared/backendFrames";
import { describe, expect, it, vi } from "vitest";
import { childProcessBackendChannel, streamBackendChannel } from "./BackendChannel";

function streams() {
  const fromGuest = new PassThrough();
  const toGuest = new PassThrough();
  const channel = streamBackendChannel({ input: fromGuest, output: toGuest });
  const decoder = new BackendFrameDecoder();
  const sent: unknown[] = [];
  toGuest.on("data", (chunk: Buffer) => sent.push(...decoder.push(chunk)));
  return { fromGuest, toGuest, channel, sent };
}

describe("stream backend channel", () => {
  it("carries framed messages both ways and has no host pid", async () => {
    const { fromGuest, channel, sent } = streams();
    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));
    const frame = encodeBackendFrame({ type: "hello" });
    fromGuest.write(frame.subarray(0, 3));
    fromGuest.write(frame.subarray(3));
    channel.send({ type: "response", requestId: "r" });
    await vi.waitFor(() => expect(received).toEqual([{ type: "hello" }]));
    await vi.waitFor(() => expect(sent).toEqual([{ type: "response", requestId: "r" }]));
    expect(channel.hostPid).toBeUndefined();
    expect(channel.connected).toBe(true);
  });

  it("closes on malformed input and stops delivering, ending the guest's stdin", async () => {
    const { fromGuest, toGuest, channel } = streams();
    const received: unknown[] = [];
    const disconnected = vi.fn();
    channel.onMessage((message) => received.push(message));
    channel.onDisconnect(disconnected);
    const ended = new Promise<void>((resolve) => toGuest.once("finish", () => resolve()));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(5);
    fromGuest.write(Buffer.concat([header, Buffer.from("{nope")]));
    fromGuest.write(encodeBackendFrame({ type: "late" }));
    await ended;
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
    expect(channel.connected).toBe(false);
    channel.send({ type: "dropped" });
  });

  it("disconnects a guest that stops reading once its queue passes the bound", () => {
    const fromGuest = new PassThrough();
    // Nobody reads this side, and its buffers are small, so writes queue up.
    const toGuest = new PassThrough({ highWaterMark: 16 });
    const channel = streamBackendChannel({
      input: fromGuest,
      output: toGuest,
      maxPendingBytes: 1024,
    });
    const disconnected = vi.fn();
    channel.onDisconnect(disconnected);
    const message = { type: "activity", data: "y".repeat(200) };
    let sent = 0;
    while (channel.connected && sent < 100) {
      channel.send(message);
      sent++;
    }
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(channel.connected).toBe(false);
    // Disconnected well before the cap was exceeded by more than one frame.
    expect(sent).toBeLessThan(10);
  });

  it("keeps frames up to the per-frame maximum flowing to a reading guest", async () => {
    const { channel, sent } = streams();
    const large = { type: "screenshot", data: "z".repeat(1024 * 1024) };
    channel.send(large);
    channel.send(large);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(channel.connected).toBe(true);
  });

  it("disconnects once at end of stream, and late listeners still hear it", async () => {
    const { fromGuest, channel } = streams();
    const first = vi.fn();
    channel.onDisconnect(first);
    fromGuest.end();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    channel.disconnect();
    const late = vi.fn();
    channel.onDisconnect(late);
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe("child process backend channel", () => {
  it("reports the host pid and disconnects once for disconnect and exit", () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      connected: true,
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    const channel = childProcessBackendChannel(child as unknown as ChildProcess);
    const disconnected = vi.fn();
    channel.onDisconnect(disconnected);
    channel.send({ type: "x" });
    expect(child.send).toHaveBeenCalledWith({ type: "x" }, expect.any(Function));
    expect(channel.hostPid).toBe(42);
    child.emit("disconnect");
    child.emit("exit", 0, null);
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
});
