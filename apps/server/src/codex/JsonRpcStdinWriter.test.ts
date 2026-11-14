import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createJsonRpcStdinWriter, jsonRpcWriteLane } from "./JsonRpcStdinWriter.ts";

it("sends sample cancellation through the control lane", () => {
  expect(jsonRpcWriteLane({ method: "thread/sample/cancel", params: { requestId: 1 } })).toBe(
    "control",
  );
});

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

it("reports transport failures once and rejects subsequent writes", async () => {
  const stdin = new ControlledWritable();
  const onFailure = vi.fn();
  const writer = createJsonRpcStdinWriter({ stdin, closedMessage: "closed", onFailure });
  const pending = writer.write({ id: 1 });
  const rejected = expect(pending).rejects.toThrow("EPIPE");
  await Promise.resolve();
  stdin.completeNext(new Error("EPIPE"));
  await rejected;
  await expect(writer.write({ id: 2 })).rejects.toThrow("EPIPE");
  expect(onFailure).toHaveBeenCalledTimes(1);
});

it("does not report explicit shutdown as a transport failure", () => {
  const onFailure = vi.fn();
  const writer = createJsonRpcStdinWriter({
    stdin: new ControlledWritable(),
    closedMessage: "closed",
    onFailure,
  });
  writer.close();
  expect(onFailure).not.toHaveBeenCalled();
});

describe("JsonRpcStdinWriter", () => {
  it("preserves start/steer/interrupt order for one thread while bypassing other threads", async () => {
    const stdin = new ControlledWritable();
    const writer = createJsonRpcStdinWriter({ stdin, closedMessage: "closed" });
    const active = writer.write({ id: 0 });
    await Promise.resolve();
    const other = writer.write({ id: 1, method: "turn/start", params: { threadId: "other" } });
    const start = writer.write({ id: 2, method: "turn/start", params: { threadId: "target" } });
    const steer = writer.write({ id: 3, method: "turn/steer", params: { threadId: "target" } });
    const stop = writer.write(
      { id: 4, method: "turn/interrupt", params: { threadId: "target" } },
      { lane: "control" },
    );
    for (const [id, completion] of [
      [0, active],
      [2, start],
      [3, steer],
      [4, stop],
      [1, other],
    ] as const) {
      expect(JSON.parse(stdin.writes.at(-1)!).id).toBe(id);
      stdin.completeNext();
      stdin.emitDrainNow();
      await completion;
      await Promise.resolve();
    }
    writer.close();
  });

  for (const lane of ["ordinary", "control"] as const)
    it(`rejects permanently oversized ${lane} frames without writing or consuming capacity`, async () => {
      const stdin = new ControlledWritable();
      const writer = createJsonRpcStdinWriter({
        stdin,
        closedMessage: "closed",
        maxBytes: 32,
        controlBytes: 32,
      });
      await expect(writer.write({ text: "🙂".repeat(10) }, { lane })).rejects.toMatchObject({
        reason: "too_large",
        deliveryCertainty: "not_sent",
        deliveryRetryable: false,
      });
      expect(stdin.writes).toEqual([]);
      const next = writer.write({ id: 1 }, { lane });
      await Promise.resolve();
      stdin.completeNext();
      stdin.emitDrainNow();
      await next;
      writer.close();
    });

  it("waits for drain before resolving backpressured writes", async () => {
    const stdin = new ControlledWritable();
    const originalEmit = stdin.emit.bind(stdin);
    const emit = vi
      .spyOn(stdin, "emit")
      .mockImplementation((name, ...args) =>
        name === "drain" ? true : originalEmit(name, ...args),
      );
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

    emit.mockRestore();
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

it("closing settles active and queued writes without a callback or drain", async () => {
  const stdin = new ControlledWritable();
  const writer = createJsonRpcStdinWriter({ stdin, closedMessage: "closed" });
  const active = writer.write({ id: 1 });
  const queued = writer.write({ id: 2 });
  const settled = Promise.allSettled([active, queued]);
  await Promise.resolve();
  writer.close(new Error("provider exited"));
  expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(stdin.writes).toHaveLength(1);
  expect(stdin.listenerCount("drain")).toBe(0);
  expect(stdin.listenerCount("close")).toBe(0);
  expect(stdin.listenerCount("error")).toBe(0);
  stdin.completeNext();
  stdin.emitDrainNow();
});

describe("bounded write admission and cancellation", () => {
  it("never writes a queued request after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new ControlledWritable();
      const writer = createJsonRpcStdinWriter({ stdin, closedMessage: "closed" });
      const first = writer.write({ id: 1 });
      const queued = writer.write({ id: 2 }, { deadline: Date.now() + 10 });
      const rejected = expect(queued).rejects.toMatchObject({
        deliveryCertainty: "not_sent",
        deliveryRetryable: true,
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      stdin.completeNext();
      stdin.emitDrainNow();
      await first;
      await Promise.resolve();
      expect(stdin.writes).toEqual(['{"id":1}\n']);
      writer.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("aborting an active write reports unknown and preserves its pipe lease", async () => {
    const stdin = new ControlledWritable();
    const writer = createJsonRpcStdinWriter({ stdin, closedMessage: "closed" });
    const controller = new AbortController();
    const active = writer.write({ id: 1 }, { signal: controller.signal });
    const rejected = expect(active).rejects.toMatchObject({
      deliveryCertainty: "unknown",
      deliveryRetryable: false,
    });
    await Promise.resolve();
    expect(stdin.writes[0]).toContain('"id":1');
    const control = writer.write({ id: 2 }, { lane: "control" });
    controller.abort();
    await rejected;
    expect(stdin.writes).toHaveLength(1);
    stdin.completeNext();
    stdin.emitDrainNow();
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(2);
    stdin.completeNext();
    stdin.emitDrainNow();
    await control;
    writer.close();
  });
  it("reserves control admission, bounds entries and bytes, and keeps FIFO per lane", async () => {
    const stdin = new ControlledWritable();
    const writer = createJsonRpcStdinWriter({
      stdin,
      closedMessage: "closed",
      maxEntries: 2,
      maxBytes: 32,
      controlEntries: 2,
    });
    const first = writer.write({ id: 1 });
    await Promise.resolve();
    const bulk = writer.write({ id: 2 });
    await expect(writer.write({ id: 3 })).rejects.toMatchObject({
      deliveryCertainty: "not_sent",
      deliveryRetryable: true,
    });
    const stop = writer.write({ id: 4 }, { lane: "control" });
    const answer = writer.write({ id: 5 }, { lane: "control" });
    stdin.completeNext();
    stdin.emitDrainNow();
    await first;
    await Promise.resolve();
    expect(stdin.writes[1]).toContain('"id":4');
    stdin.completeNext();
    stdin.emitDrainNow();
    await stop;
    await Promise.resolve();
    expect(stdin.writes[2]).toContain('"id":5');
    stdin.completeNext();
    stdin.emitDrainNow();
    await answer;
    await Promise.resolve();
    expect(stdin.writes[3]).toContain('"id":2');
    stdin.completeNext();
    stdin.emitDrainNow();
    await bulk;
    await expect(writer.write({ text: "x".repeat(40) })).rejects.toMatchObject({
      deliveryCertainty: "not_sent",
    });
    writer.close();
  });
});
