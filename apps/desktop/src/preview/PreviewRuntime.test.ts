import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewRuntime } from "./PreviewRuntime";

const directories: string[] = [];

function makeGuest(options?: { attachFailures?: number }) {
  const commands: Array<{ method: string; params?: unknown }> = [];
  const emitter = new EventEmitter();
  const guestEvents = new EventEmitter();
  let attached = false;
  let attachFailures = options?.attachFailures ?? 0;
  const debuggerApi = Object.assign(emitter, {
    attach: () => {
      if (attachFailures > 0) {
        attachFailures -= 1;
        throw new Error("Another debugger is already attached");
      }
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    isAttached: () => attached,
    sendCommand: async (method: string, params?: unknown) => {
      commands.push({ method, params });
      return {};
    },
  });
  const guest = Object.assign(guestEvents, {
    debugger: debuggerApi,
    isDestroyed: () => false,
    close: vi.fn(),
    capturePage: async () => ({
      getSize: () => ({ width: 640, height: 480 }),
      toPNG: () => Buffer.from([137, 80, 78, 71]),
    }),
  }) as unknown as WebContents;
  return { guest, guestEvents, debuggerApi, commands };
}

function makeRuntime(options?: { attachFailures?: number }) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-preview-runtime-"));
  directories.push(stateDirectory);
  const mock = makeGuest(options);
  const frames: unknown[] = [];
  const tabStateChanges: string[] = [];
  const runtime = new PreviewRuntime({
    stateDirectory,
    defaultZoomFactor: 1,
    getWebContents: () => mock.guest,
    emitRecordingFrame: (frame) => frames.push(frame),
    onTabStateChanged: (tabId) => tabStateChanges.push(tabId),
  });
  return { runtime, mock, frames, tabStateChanges, stateDirectory };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PreviewRuntime", () => {
  it("rejects stale viewport revisions", async () => {
    const { runtime, tabStateChanges } = makeRuntime();
    await runtime.initialize();

    expect(runtime.setViewport("tab-1", { width: 375, height: 812, revision: 2 })).toBe(true);
    expect(runtime.setViewport("tab-1", { width: 800, height: 600, revision: 1 })).toBe(false);
    expect(runtime.lookupTab("tab-1")?.viewport).toEqual({ width: 375, height: 812, revision: 2 });
    expect(runtime.setViewport("tab-1", null)).toBe(true);
    expect(runtime.lookupTab("tab-1")?.viewport).toBeNull();
    expect(tabStateChanges).toEqual(["tab-1", "tab-1"]);
  });

  it("captures opaque screenshot artifacts", async () => {
    const { runtime } = makeRuntime();
    await runtime.initialize();

    const artifact = await runtime.captureScreenshot("tab-1");

    expect(artifact).toMatchObject({
      kind: "screenshot",
      mimeType: "image/png",
      width: 640,
      height: 480,
    });
    expect(artifact).not.toHaveProperty("path");
  });

  it("emulates and retains a per-tab color scheme without keeping the debugger attached", async () => {
    const { runtime, mock } = makeRuntime();
    await runtime.initialize();

    await expect(runtime.setColorScheme("tab-1", "dark")).resolves.toBe(true);

    expect(runtime.lookupTab("tab-1")?.colorScheme).toBe("dark");
    expect(mock.commands).toContainEqual({
      method: "Emulation.setEmulatedMedia",
      params: {
        features: [{ name: "prefers-color-scheme", value: "dark" }],
      },
    });
    expect(mock.debuggerApi.isAttached()).toBe(false);
  });

  it("acks every screencast frame and finalizes streamed recordings", async () => {
    const { runtime, mock, frames } = makeRuntime();
    await runtime.initialize();
    const started = await runtime.startRecording("tab-1");

    mock.debuggerApi.emit("message", {}, "Page.screencastFrame", {
      sessionId: 7,
      data: "jpeg-base64",
      metadata: { deviceWidth: 640, deviceHeight: 480 },
    });
    await Promise.resolve();
    await runtime.appendRecordingChunk(started.recordingId, new Uint8Array([1, 2, 3]));
    const artifact = await runtime.stopRecording(started.recordingId);

    expect(frames).toHaveLength(1);
    expect(mock.commands).toContainEqual({
      method: "Page.screencastFrameAck",
      params: { sessionId: 7 },
    });
    expect(mock.commands.some((command) => command.method === "Page.stopScreencast")).toBe(true);
    expect(artifact).toMatchObject({ kind: "recording", bytes: 3 });
  });

  it("discards the recording artifact when debugger attachment fails", async () => {
    const { runtime, stateDirectory } = makeRuntime({ attachFailures: 1 });
    await runtime.initialize();

    await expect(runtime.startRecording("tab-1")).rejects.toThrow(
      "Another debugger is already attached",
    );
    expect(fs.readdirSync(path.join(stateDirectory, "preview-artifacts"))).toEqual([]);

    const started = await runtime.startRecording("tab-1");
    await runtime.discardRecording(started.recordingId);
  });

  it("discards partial recordings when a preview renderer crashes", async () => {
    const { runtime, mock, stateDirectory } = makeRuntime();
    await runtime.initialize();
    const started = await runtime.startRecording("tab-1");
    await runtime.appendRecordingChunk(started.recordingId, new Uint8Array([1, 2, 3]));

    mock.guestEvents.emit("render-process-gone");
    await vi.waitFor(() => {
      const artifactDirectory = path.join(stateDirectory, "preview-artifacts");
      expect(fs.readdirSync(artifactDirectory).some((name) => name.endsWith(".tmp"))).toBe(false);
    });

    await expect(runtime.stopRecording(started.recordingId)).rejects.toThrow(
      "Unknown preview recording",
    );
    expect(mock.commands.some((command) => command.method === "Page.stopScreencast")).toBe(true);
  });

  it("discards every recording for a tab when it closes or loses recording capability", async () => {
    const { runtime } = makeRuntime();
    await runtime.initialize();
    const started = await runtime.startRecording("tab-1");
    await runtime.appendRecordingChunk(started.recordingId, new Uint8Array([1, 2, 3]));

    await runtime.discardRecordingsForTab("tab-1");

    await expect(runtime.stopRecording(started.recordingId)).rejects.toThrow(
      "Unknown preview recording",
    );
  });

  it("clears renderer-owned guests, listeners, and partial recordings before main reload", async () => {
    const { runtime, mock, stateDirectory } = makeRuntime();
    await runtime.initialize();
    const entry = runtime.ensureTab("tab-1");
    const removeListener = vi.fn();
    entry?.removeListeners.push(removeListener);
    const started = await runtime.startRecording("tab-1");
    await runtime.appendRecordingChunk(started.recordingId, new Uint8Array([1, 2, 3]));

    await runtime.resetRendererOwnedResources();

    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(mock.guest.close).toHaveBeenCalledTimes(1);
    expect(runtime.tabs.size).toBe(0);
    expect(fs.readdirSync(path.join(stateDirectory, "preview-artifacts"))).toEqual([]);
    await expect(runtime.stopRecording(started.recordingId)).rejects.toThrow(
      "Unknown preview recording",
    );
  });

  it("fails safe by discarding recordings that exceed the five-minute lifecycle limit", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    await runtime.initialize();
    const started = await runtime.startRecording("tab-1");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5_000);

    await expect(runtime.stopRecording(started.recordingId)).rejects.toThrow(
      "Unknown preview recording",
    );
  });
});
