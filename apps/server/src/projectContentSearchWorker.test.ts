import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

import { PROJECT_CONTENT_SEARCH_WORKER_SOURCE } from "./projectContentSearchWorker";

function workerHarness(initiallyScanning = false) {
  let scanning = initiallyScanning;
  let failProgress = false;
  let timestamp = 0;
  const finder = {
    destroy: vi.fn(),
    scanFiles: vi.fn(() => {
      scanning = true;
      return { ok: true, value: undefined };
    }),
    getScanProgress: () =>
      failProgress
        ? { ok: false, error: "scan failed" }
        : {
            ok: true,
            value: { scannedFilesCount: 1, isScanning: scanning, isWarmupComplete: true },
          },
    grep: () => ({
      ok: true,
      value: {
        items: [
          {
            relativePath: "minified.js",
            lineNumber: 1,
            lineContent: "x".repeat(512),
            matchRanges: [],
          },
        ],
        nextCursor: null,
      },
    }),
  };
  const create = vi.fn(() => ({ ok: true, value: finder }));
  const process = Object.assign(new EventEmitter(), { send: vi.fn(), env: {}, exit: vi.fn() });
  runInNewContext(PROJECT_CONTENT_SEARCH_WORKER_SOURCE, {
    process,
    Buffer,
    performance,
    Date: { now: () => timestamp },
    setTimeout: (callback: () => void) => {
      timestamp += 15_000;
      callback();
    },
    require: (name: string) => (name === "node:fs" ? { realpathSync: (p: string) => p } : {}),
    Function: function () {
      return async () => ({ FileFinder: { create } });
    },
  });
  let id = 0;
  return {
    create,
    failProgress: () => {
      failProgress = true;
    },
    call: async (message: Record<string, unknown>) => {
      const requestId = ++id;
      process.emit("message", { ...message, id: requestId });
      await vi.waitFor(() =>
        expect(process.send).toHaveBeenCalledWith(expect.objectContaining({ id: requestId })),
      );
      return process.send.mock.calls.find(([response]) => response.id === requestId)![0];
    },
  };
}

it("retains range-less regex hits unless whole-word verification is requested", async () => {
  const worker = workerHarness();
  await worker.call({ type: "initialize", rootPath: "/workspace" });
  for (const wholeWord of [false, true]) {
    const result = await worker.call({
      type: "search",
      query: "needle.*",
      limit: 100,
      caseSensitive: true,
      wholeWord,
      useRegex: true,
    });
    expect(result.type).toBe("result");
    expect(result.value.matches).toHaveLength(wholeWord ? 0 : 1);
    if (!wholeWord) expect(result.value.matches[0].matchRanges).toEqual([]);
  }
});

it("keeps the live finder after a refresh timeout but propagates scan failures", async () => {
  const worker = workerHarness();
  expect((await worker.call({ type: "initialize", rootPath: "/workspace" })).type).toBe("result");
  expect((await worker.call({ type: "refresh" })).type).toBe("result");
  const result = await worker.call({
    type: "search",
    query: "needle.*",
    limit: 100,
    caseSensitive: true,
    wholeWord: false,
    useRegex: true,
  });
  expect(result.value.matches).toHaveLength(1);
  expect(worker.create).toHaveBeenCalledTimes(1);
  worker.failProgress();
  expect(await worker.call({ type: "refresh" })).toMatchObject({
    type: "error",
    error: "scan failed",
  });
});

it("still fails initial indexing when no usable index is ready before the deadline", async () => {
  const worker = workerHarness(true);
  expect(await worker.call({ type: "initialize", rootPath: "/workspace" })).toMatchObject({
    type: "error",
    error: "Project content index scan timed out after 15 seconds.",
  });
});
