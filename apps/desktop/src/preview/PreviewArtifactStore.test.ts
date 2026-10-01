import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreviewArtifactStore } from "./PreviewArtifactStore";

const directories: string[] = [];

function makeStore(options?: { quotaBytes?: number; now?: () => number }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-preview-artifacts-"));
  directories.push(directory);
  return {
    directory,
    store: new PreviewArtifactStore({ directory, ...options }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PreviewArtifactStore", () => {
  it("applies a shorter retention from settings and removes expired artifacts", async () => {
    const now = Date.UTC(2026, 0, 10);
    const { directory, store } = makeStore({ now: () => now });
    await store.initialize();
    await store.captureScreenshot({ png: new Uint8Array([1]), width: 1, height: 1 });
    const [file] = fs.readdirSync(directory);
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(directory, file!), threeDaysAgo, threeDaysAgo);

    const artifacts = () => fs.readdirSync(directory).filter((name) => !name.startsWith("."));
    await store.setRetention("profile-a", null);
    expect(artifacts()).toHaveLength(1);
    await store.setRetention("profile-a", 2);
    expect(artifacts()).toHaveLength(0);
    await expect(store.setRetention("profile-a", 0)).rejects.toThrow(/between 1 and 3650/);
  });

  it("applies the longest retention across profiles so one cannot expire another's", async () => {
    const now = Date.UTC(2026, 0, 10);
    const { directory, store } = makeStore({ now: () => now });
    await store.initialize();
    await store.captureScreenshot({ png: new Uint8Array([1]), width: 1, height: 1 });
    const artifact = fs.readdirSync(directory).find((name) => !name.startsWith("."))!;
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(directory, artifact), tenDaysAgo, tenDaysAgo);

    await store.setRetention("profile-a", 30);
    // Profile B keeps the 7-day default; profile A's 30 days still applies.
    await store.setRetention("profile-b", null);
    expect(fs.readdirSync(directory)).toContain(artifact);
    // Once A shortens its own retention, the default is the longest left.
    await store.setRetention("profile-a", 3);
    expect(fs.readdirSync(directory)).not.toContain(artifact);
  });

  it("keeps a configured retention across restarts", async () => {
    const now = Date.UTC(2026, 0, 10);
    const { directory, store } = makeStore({ now: () => now });
    await store.initialize();
    await store.setRetention("profile-a", 30);
    await store.captureScreenshot({ png: new Uint8Array([1]), width: 1, height: 1 });
    const artifact = fs.readdirSync(directory).find((name) => !name.startsWith("."))!;
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(directory, artifact), tenDaysAgo, tenDaysAgo);

    const restarted = new PreviewArtifactStore({ directory, now: () => now });
    await restarted.initialize();
    expect(fs.readdirSync(directory)).toContain(artifact);
  });

  it("atomically stores screenshots behind opaque ids", async () => {
    const { directory, store } = makeStore();
    await store.initialize();

    const artifact = await store.captureScreenshot({
      png: new Uint8Array([137, 80, 78, 71]),
      width: 800,
      height: 600,
    });

    expect(artifact).toMatchObject({
      kind: "screenshot",
      mimeType: "image/png",
      bytes: 4,
      width: 800,
      height: 600,
    });
    expect(artifact).not.toHaveProperty("path");
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".png"))).toBe(true);
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("streams recording chunks and deletes partial files on discard", async () => {
    const { directory, store } = makeStore();
    await store.initialize();
    const recording = await store.beginRecording({ tabId: "tab-1", width: 640, height: 480 });
    await Promise.all([
      store.appendRecordingChunk(recording.recordingId, new Uint8Array([1, 2])),
      store.appendRecordingChunk(recording.recordingId, new Uint8Array([3, 4, 5])),
    ]);

    const artifact = await store.commitRecording(recording.recordingId);

    expect(artifact).toMatchObject({ kind: "recording", bytes: 5, width: 640, height: 480 });
    const recordingFile = fs.readdirSync(directory).find((name) => name.endsWith(".webm"));
    expect(recordingFile).toBeDefined();
    expect([...fs.readFileSync(path.join(directory, recordingFile!))]).toEqual([1, 2, 3, 4, 5]);

    const partial = await store.beginRecording({ tabId: "tab-2", width: 640, height: 480 });
    await store.appendRecordingChunk(partial.recordingId, new Uint8Array([1]));
    await store.discardRecording(partial.recordingId);
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("waits for an in-flight chunk before committing a recording", async () => {
    const { directory, store } = makeStore();
    await store.initialize();
    const recording = await store.beginRecording({ tabId: "tab-1", width: 640, height: 480 });

    const append = store.appendRecordingChunk(recording.recordingId, new Uint8Array([1, 2, 3]));
    const commit = store.commitRecording(recording.recordingId);
    const [, artifact] = await Promise.all([append, commit]);

    expect(artifact).toMatchObject({ kind: "recording", bytes: 3 });
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("cleans incomplete artifacts at startup and enforces the shared quota", async () => {
    const { directory, store } = makeStore({ quotaBytes: 6 });
    fs.writeFileSync(path.join(directory, "stale.tmp"), "partial");
    await store.initialize();
    expect(fs.existsSync(path.join(directory, "stale.tmp"))).toBe(false);

    await store.captureScreenshot({ png: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 });
    await store.captureScreenshot({ png: new Uint8Array([5, 6, 7, 8]), width: 1, height: 1 });

    const finalized = fs.readdirSync(directory).filter((name) => !name.endsWith(".tmp"));
    expect(finalized).toHaveLength(1);
  });

  it("counts active recording bytes against the shared quota", async () => {
    const { directory, store } = makeStore({ quotaBytes: 6 });
    await store.initialize();
    const recording = await store.beginRecording({ tabId: "tab-1", width: 640, height: 480 });
    await store.appendRecordingChunk(recording.recordingId, new Uint8Array([1, 2, 3, 4]));

    await expect(
      store.captureScreenshot({ png: new Uint8Array([5, 6, 7]), width: 1, height: 1 }),
    ).rejects.toThrow("shared artifact quota");
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);

    await store.discardRecording(recording.recordingId);
    await expect(
      store.captureScreenshot({ png: new Uint8Array([5, 6, 7]), width: 1, height: 1 }),
    ).resolves.toMatchObject({ kind: "screenshot", bytes: 3 });
  });

  it("serializes concurrent quota reservations across recordings", async () => {
    const { store } = makeStore({ quotaBytes: 6 });
    await store.initialize();
    const first = await store.beginRecording({ tabId: "tab-1", width: 640, height: 480 });
    const second = await store.beginRecording({ tabId: "tab-2", width: 640, height: 480 });

    const results = await Promise.allSettled([
      store.appendRecordingChunk(first.recordingId, new Uint8Array([1, 2, 3, 4])),
      store.appendRecordingChunk(second.recordingId, new Uint8Array([5, 6, 7, 8])),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await store.dispose();
  });
});
