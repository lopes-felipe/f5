import { decodeTaggedAutomationErrorMessage } from "@t3tools/shared/preview";
import { describe, expect, it } from "vitest";

import {
  PreviewAutomationControl,
  PreviewDiagnostics,
  PREVIEW_CONTROL_INTERRUPTED_MESSAGE,
  PREVIEW_DIAGNOSTIC_BUFFER_SIZE,
  boundSnapshotPageData,
  chunkTypedText,
  encodeBoundedPreviewImage,
  type EncodableImage,
} from "./automationControl";

function tagOf(cause: unknown): string | undefined {
  return decodeTaggedAutomationErrorMessage(cause instanceof Error ? cause.message : "")?.tag;
}

function fakeImage(width: number, pngBytes: number, jpegBytes: (quality: number) => number) {
  const image: EncodableImage = {
    getSize: () => ({ width, height: width / 2 }),
    toPNG: () => Buffer.alloc(pngBytes),
    toJPEG: (quality) => Buffer.alloc(jpegBytes(quality)),
    resize: ({ width: next }) => fakeImage(next ?? width, pngBytes / 4, (q) => jpegBytes(q) / 4),
  };
  return image;
}

describe("PreviewAutomationControl", () => {
  it("serializes actions per tab in FIFO order", async () => {
    const control = new PreviewAutomationControl();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = control.run("tab", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push("first:end");
    });
    const second = control.run("tab", async () => {
      order.push("second");
    });
    const otherTab = control.run("other", async () => {
      order.push("other");
    });
    await otherTab;
    expect(control.isActive("tab")).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
    expect(control.isActive("tab")).toBe(false);
  });

  it("interrupts the running action at its next checkpoint and fails queued ones", async () => {
    const control = new PreviewAutomationControl();
    let reachedCheckpoint!: () => void;
    const started = new Promise<void>((resolve) => (reachedCheckpoint = resolve));
    let resume!: () => void;
    const running = control.run("tab", async (checkpoint) => {
      reachedCheckpoint();
      await new Promise<void>((resolve) => (resume = resolve));
      checkpoint.check();
      return "not reached";
    });
    const queued = control.run("tab", async () => "queued ran");
    await started;
    control.cancel("tab");
    resume();
    await expect(running).rejects.toSatisfy(
      (cause) => tagOf(cause) === "PreviewAutomationControlInterruptedError",
    );
    await expect(queued).rejects.toSatisfy(
      (cause) => tagOf(cause) === "PreviewAutomationControlInterruptedError",
    );
    // Actions enqueued after the take-over run normally.
    await expect(control.run("tab", async () => "fresh")).resolves.toBe("fresh");
  });

  it("interrupts a standalone checkpoint without blocking queued actions", async () => {
    const control = new PreviewAutomationControl();
    // A wait holds a checkpoint but not the queue, so an action can run meanwhile.
    const wait = control.checkpoint("tab");
    await expect(control.run("tab", async () => "click ran")).resolves.toBe("click ran");
    expect(() => wait.check()).not.toThrow();
    control.cancel("tab");
    expect(() => wait.check()).toThrow(PREVIEW_CONTROL_INTERRUPTED_MESSAGE);
  });
});

describe("bounded snapshot encoding", () => {
  it("keeps PNG when it fits and falls back to JPEG, then smaller dimensions", () => {
    expect(
      encodeBoundedPreviewImage(
        fakeImage(100, 10, () => 5),
        100,
      ).mimeType,
    ).toBe("image/png");
    const jpeg = encodeBoundedPreviewImage(
      fakeImage(100, 1000, (q) => q),
      80,
    );
    expect(jpeg).toMatchObject({ mimeType: "image/jpeg", width: 100 });
    expect(jpeg.bytes.length).toBe(70);
    const resized = encodeBoundedPreviewImage(
      fakeImage(2000, 4000, () => 400),
      150,
    );
    expect(resized.width).toBe(1000);
  });

  it("caps the longest edge at 2560 px even when the image fits the byte limit", () => {
    expect(
      encodeBoundedPreviewImage(
        fakeImage(5120, 10, () => 5),
        1_000,
      ).width,
    ).toBe(2560);
  });

  it("returns a typed too-large error instead of an unbounded image", () => {
    expect(() =>
      encodeBoundedPreviewImage(
        fakeImage(100, 1e9, () => 1e9),
        10,
      ),
    ).toThrow(/PreviewAutomationResultTooLargeError/);
  });

  it("trims structured snapshot data to its budget", () => {
    const page = {
      url: "http://localhost:3000/",
      title: "t",
      loading: false,
      visibleText: "x".repeat(400_000),
      interactiveElements: [],
      accessibilityTree: null,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    };
    const bounded = boundSnapshotPageData(page, 64 * 1024);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(64 * 1024);
    expect(bounded.visibleText.length).toBeGreaterThan(0);
  });
});

describe("PreviewDiagnostics", () => {
  it("keeps bounded console, network, and action rings per tab", () => {
    const diagnostics = new PreviewDiagnostics();
    for (let index = 0; index < PREVIEW_DIAGNOSTIC_BUFFER_SIZE + 5; index += 1) {
      diagnostics.recordConsole("tab", { level: "error", text: `message ${index}` });
    }
    diagnostics.recordNetwork("tab", {
      url: "http://localhost:3000/api",
      method: "GET",
      status: null,
      failed: true,
      errorText: "ERR_CONNECTION_REFUSED",
    });
    const complete = diagnostics.startAction("tab", "click");
    expect(diagnostics.read("tab").actionTimeline[0]?.status).toBe("running");
    complete("interrupted", "user took over");
    const read = diagnostics.read("tab");
    expect(read.consoleEntries).toHaveLength(PREVIEW_DIAGNOSTIC_BUFFER_SIZE);
    expect(read.consoleEntries[0]?.text).toBe("message 5");
    expect(read.networkEntries[0]).toMatchObject({ failed: true });
    expect(read.actionTimeline[0]).toMatchObject({ action: "click", status: "interrupted" });
    expect(diagnostics.read("other").consoleEntries).toEqual([]);
    diagnostics.forget("tab");
    expect(diagnostics.read("tab").consoleEntries).toEqual([]);
  });

  it("chunks typed text without splitting surrogate pairs", () => {
    expect(chunkTypedText("ab😀cd", 3)).toEqual(["ab😀", "cd"]);
    expect(chunkTypedText("")).toEqual([]);
  });
});
