import { describe, expect, it } from "vitest";
import { BackendFrameDecoder, BackendFrameError, encodeBackendFrame } from "./backendFrames";

describe("backend frames", () => {
  it("round-trips messages split and coalesced across chunks", () => {
    const messages = [{ type: "hello", n: 1 }, "ünïcode ✓", [1, 2, 3], null];
    const bytes = Uint8Array.from(messages.flatMap((m) => [...encodeBackendFrame(m)]));
    const decoder = new BackendFrameDecoder();
    const received: unknown[] = [];
    // One byte at a time exercises every split point, including inside the length prefix.
    for (const byte of bytes) received.push(...decoder.push(Uint8Array.of(byte)));
    expect(received).toEqual(messages);
    expect(decoder.pendingBytes).toBe(0);
    expect(new BackendFrameDecoder().push(bytes)).toEqual(messages);
  });

  it("reassembles a large frame from many small chunks, next to coalesced frames", () => {
    const large = { type: "screenshot", data: "x".repeat(4 * 1024 * 1024) };
    const bytes = Uint8Array.from([
      ...encodeBackendFrame({ type: "before" }),
      ...encodeBackendFrame(large),
      ...encodeBackendFrame({ type: "after" }),
    ]);
    const decoder = new BackendFrameDecoder();
    const received: unknown[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 4096)
      received.push(...decoder.push(bytes.subarray(offset, offset + 4096)));
    expect(received).toEqual([{ type: "before" }, large, { type: "after" }]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("reports a truncated trailing frame as pending bytes", () => {
    const frame = encodeBackendFrame({ a: 1 });
    const decoder = new BackendFrameDecoder();
    expect(decoder.push(frame.subarray(0, frame.byteLength - 1))).toEqual([]);
    expect(decoder.pendingBytes).toBe(frame.byteLength - 1);
  });

  it("fails permanently on oversized, invalid UTF-8 or invalid JSON frames", () => {
    const header = (length: number) => {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, length, false);
      return bytes;
    };
    const oversized = new BackendFrameDecoder(8);
    expect(() => oversized.push(header(9))).toThrow(BackendFrameError);
    expect(() => oversized.push(encodeBackendFrame(1))).toThrow(/already failed/);

    const badUtf8 = new BackendFrameDecoder();
    expect(() => badUtf8.push(Uint8Array.from([...header(1), 0xff]))).toThrow(/UTF-8/);

    const badJson = new BackendFrameDecoder();
    const text = new TextEncoder().encode("{nope");
    expect(() => badJson.push(Uint8Array.from([...header(text.byteLength), ...text]))).toThrow(
      /JSON/,
    );
  });

  it("refuses to encode unserializable payloads", () => {
    expect(() => encodeBackendFrame(undefined)).toThrow(BackendFrameError);
  });
});
