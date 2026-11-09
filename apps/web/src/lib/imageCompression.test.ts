import { afterEach, expect, it, vi } from "vitest";

import {
  processComposerImageBounded,
  processComposerImageTaskBounded,
  withImageCompressionTimeout,
} from "./imageCompression";

afterEach(() => vi.useRealTimers());

it("releases both shared slots after stalled requests time out", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const signal = new AbortController().signal;
  const stalled = () =>
    withImageCompressionTimeout(
      (child) => {
        signals.push(child);
        return new Promise(() => undefined);
      },
      signal,
      100,
    );
  const first = processComposerImageTaskBounded(stalled, signal);
  const second = processComposerImageTaskBounded(stalled, signal);
  const next = processComposerImageTaskBounded(
    async () => ({ ok: false, reason: "unsupported" }),
    signal,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await first).toEqual({ ok: false, reason: "timed-out" });
  expect(await second).toEqual({ ok: false, reason: "timed-out" });
  expect(await next).toEqual({ ok: false, reason: "unsupported" });
  expect(signals).toHaveLength(2);
  expect(signals.every((child) => child.aborted)).toBe(true);
});

it("propagates parent cancellation without waiting for the deadline", async () => {
  const parent = new AbortController();
  let child!: AbortSignal;
  const pending = withImageCompressionTimeout((signal) => {
    child = signal;
    return new Promise(() => undefined);
  }, parent.signal);
  await Promise.resolve();
  parent.abort();
  expect(await pending).toEqual({ ok: false, reason: "cancelled" });
  expect(child.aborted).toBe(true);
});

it("releases a conversion slot when the processor throws synchronously", async () => {
  const file = new File(["x"], "photo.png", { type: "image/png" });
  const signal = new AbortController().signal;
  const throwing = () => {
    throw new Error("worker unavailable");
  };
  // More throwing jobs than slots: each must settle and hand its slot on.
  const results = await Promise.all(
    Array.from({ length: 4 }, () => processComposerImageBounded(throwing, file, signal)),
  );
  expect(results).toEqual(Array(4).fill({ ok: false, reason: "unreadable" }));

  const converted = await processComposerImageBounded(
    async (input) => ({
      ok: true,
      file: input,
      recompressed: false,
      originalSizeBytes: input.size,
      finalSizeBytes: input.size,
    }),
    file,
    signal,
  );
  expect(converted).toMatchObject({ ok: true });
});
