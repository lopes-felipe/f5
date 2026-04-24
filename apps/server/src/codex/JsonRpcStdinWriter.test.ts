import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createJsonRpcStdinWriter } from "./JsonRpcStdinWriter.ts";

class ControlledWritable extends Writable {
  readonly writes: string[] = [];
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  constructor() {
    super({ decodeStrings: false, highWaterMark: 1 });
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    this.callbacks.push(callback);
  }

  completeNext(error?: Error): void {
    const callback = this.callbacks.shift();
    if (!callback) {
      throw new Error("No pending write callback to complete.");
    }
    callback(error ?? null);
  }

  emitDrainNow(): void {
    this.emit("drain");
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

describe("JsonRpcStdinWriter", () => {
  it("waits for drain before resolving backpressured writes", async () => {
    const stdin = new ControlledWritable();
    const writer = createJsonRpcStdinWriter({
      stdin,
      closedMessage: "writer closed",
    });

    let settled = false;
    const pending = writer.write({ id: 1 }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(stdin.writes).toHaveLength(1);
    expect(settled).toBe(false);

    stdin.completeNext();
    await Promise.resolve();
    expect(settled).toBe(false);

    stdin.emitDrainNow();
    await pending;
    expect(settled).toBe(true);
  });

  it("serializes concurrent writes to preserve request ordering", async () => {
    const stdin = new ControlledWritable();
    const writer = createJsonRpcStdinWriter({
      stdin,
      closedMessage: "writer closed",
    });

    const first = writer.write({ id: 1 });
    const second = writer.write({ id: 2 });

    await Promise.resolve();
    expect(stdin.writes).toEqual(['{"id":1}\n']);

    stdin.completeNext();
    stdin.emitDrainNow();
    await first;
    await Promise.resolve();
    expect(stdin.writes).toEqual(['{"id":1}\n', '{"id":2}\n']);

    stdin.completeNext();
    stdin.emitDrainNow();

    await second;
  });

  it("rejects pending and queued writes when the stream errors", async () => {
    const stdin = new ControlledWritable();
    const writer = createJsonRpcStdinWriter({
      stdin,
      closedMessage: "writer closed",
    });

    const first = writer.write({ id: 1 });
    const second = writer.write({ id: 2 });

    await Promise.resolve();
    expect(stdin.writes).toHaveLength(1);

    stdin.fail(new Error("boom"));

    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
  });
});
