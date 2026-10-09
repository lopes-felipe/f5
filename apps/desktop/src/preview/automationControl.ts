import type {
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import { encodeTaggedAutomationErrorMessage } from "@t3tools/shared/preview";

export const PREVIEW_SNAPSHOT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PREVIEW_SNAPSHOT_MAX_PAGE_DATA_BYTES = 256 * 1024;
export const PREVIEW_SNAPSHOT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PREVIEW_DIAGNOSTIC_BUFFER_SIZE = 50;
export const PREVIEW_TYPE_CHUNK_SIZE = 64;
const DIAGNOSTIC_TEXT_LIMIT = 500;
const JPEG_QUALITIES = [85, 70, 55, 40] as const;

export const PREVIEW_CONTROL_INTERRUPTED_MESSAGE =
  "The user took control of the browser preview. Ask the user before continuing, then take a fresh preview_snapshot.";

export function taggedAutomationError(tag: string, message: string): Error {
  return new Error(encodeTaggedAutomationErrorMessage(tag, message));
}

export interface PreviewAutomationCheckpoint {
  /** Throws a tagged interruption when the user took over since this action started. */
  readonly check: () => void;
}

/**
 * Serializes automation per tab and lets the user interrupt the running and queued actions.
 * Cancelling bumps the tab generation; every poll loop and input step re-checks it.
 */
export class PreviewAutomationControl {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, number>();

  /** True while an automation action is executing on the tab. */
  isActive(tabId: string): boolean {
    return (this.active.get(tabId) ?? 0) > 0;
  }

  generation(tabId: string): number {
    return this.generations.get(tabId) ?? 0;
  }

  cancel(tabId: string): void {
    this.generations.set(tabId, this.generation(tabId) + 1);
  }

  forget(tabId: string): void {
    this.cancel(tabId);
    this.tails.delete(tabId);
  }

  run<T>(
    tabId: string,
    action: (checkpoint: PreviewAutomationCheckpoint) => Promise<T>,
  ): Promise<T> {
    const enqueuedGeneration = this.generation(tabId);
    const checkpoint: PreviewAutomationCheckpoint = {
      check: () => {
        if (this.generation(tabId) !== enqueuedGeneration) {
          throw taggedAutomationError(
            "PreviewAutomationControlInterruptedError",
            PREVIEW_CONTROL_INTERRUPTED_MESSAGE,
          );
        }
      },
    };
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    const result = previous.then(async () => {
      checkpoint.check();
      this.active.set(tabId, (this.active.get(tabId) ?? 0) + 1);
      try {
        return await action(checkpoint);
      } finally {
        const remaining = (this.active.get(tabId) ?? 1) - 1;
        if (remaining > 0) this.active.set(tabId, remaining);
        else this.active.delete(tabId);
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(tabId, tail);
    void tail.then(() => {
      if (this.tails.get(tabId) === tail) this.tails.delete(tabId);
    });
    return result;
  }
}

export function chunkTypedText(text: string, size = PREVIEW_TYPE_CHUNK_SIZE): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(""));
  }
  return chunks;
}

export interface EncodableImage {
  readonly getSize: () => { width: number; height: number };
  readonly toPNG: () => Buffer;
  readonly toJPEG: (quality: number) => Buffer;
  readonly resize: (options: { width?: number; height?: number }) => EncodableImage;
}

export interface EncodedPreviewImage {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Longest edge of a snapshot image; larger captures (HiDPI, tall pages) are scaled down. */
export const PREVIEW_SNAPSHOT_MAX_IMAGE_EDGE = 2560;

/**
 * At most 2560 px on the longest edge; PNG when it fits, otherwise progressively lossier
 * JPEG, then smaller dimensions.
 */
export function encodeBoundedPreviewImage(
  image: EncodableImage,
  maxBytes = PREVIEW_SNAPSHOT_MAX_IMAGE_BYTES,
): EncodedPreviewImage {
  let current = image;
  const initial = current.getSize();
  if (Math.max(initial.width, initial.height) > PREVIEW_SNAPSHOT_MAX_IMAGE_EDGE) {
    current =
      initial.width >= initial.height
        ? current.resize({ width: PREVIEW_SNAPSHOT_MAX_IMAGE_EDGE })
        : current.resize({ height: PREVIEW_SNAPSHOT_MAX_IMAGE_EDGE });
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const size = current.getSize();
    const png = current.toPNG();
    if (png.length <= maxBytes) return { mimeType: "image/png", bytes: png, ...size };
    for (const quality of JPEG_QUALITIES) {
      const jpeg = current.toJPEG(quality);
      if (jpeg.length <= maxBytes) return { mimeType: "image/jpeg", bytes: jpeg, ...size };
    }
    current =
      size.width >= size.height
        ? current.resize({ width: Math.max(1, Math.floor(size.width / 2)) })
        : current.resize({ height: Math.max(1, Math.floor(size.height / 2)) });
  }
  throw resultTooLarge("Preview screenshot", maxBytes);
}

function resultTooLarge(subject: string, maximumBytes: number): Error {
  return taggedAutomationError(
    "PreviewAutomationResultTooLargeError",
    `${subject} exceeds ${maximumBytes} bytes.`,
  );
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

type SnapshotPageData = Omit<PreviewAutomationSnapshot, "screenshot" | "savedScreenshot">;

/** Trims page text and element lists until the structured part fits its budget. */
export function boundSnapshotPageData(
  page: SnapshotPageData,
  maxBytes = PREVIEW_SNAPSHOT_MAX_PAGE_DATA_BYTES,
): SnapshotPageData {
  let bounded = page;
  for (let attempt = 0; attempt < 12 && jsonBytes(bounded) > maxBytes; attempt += 1) {
    bounded = {
      ...bounded,
      visibleText: bounded.visibleText.slice(0, Math.floor(bounded.visibleText.length / 2)),
      interactiveElements: bounded.interactiveElements.slice(
        0,
        Math.floor(bounded.interactiveElements.length * 0.75),
      ),
      consoleEntries: bounded.consoleEntries.slice(-Math.floor(bounded.consoleEntries.length / 2)),
      networkEntries: bounded.networkEntries.slice(-Math.floor(bounded.networkEntries.length / 2)),
      accessibilityTree: null,
    };
  }
  if (jsonBytes(bounded) > maxBytes) throw resultTooLarge("Preview snapshot data", maxBytes);
  return bounded;
}

export function assertSnapshotResponseSize(
  snapshot: PreviewAutomationSnapshot,
  maxBytes = PREVIEW_SNAPSHOT_MAX_RESPONSE_BYTES,
): PreviewAutomationSnapshot {
  if (jsonBytes(snapshot) > maxBytes) throw resultTooLarge("Preview snapshot", maxBytes);
  return snapshot;
}

function boundedText(text: string): string {
  return text.length > DIAGNOSTIC_TEXT_LIMIT ? `${text.slice(0, DIAGNOSTIC_TEXT_LIMIT)}…` : text;
}

function pushBounded<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > PREVIEW_DIAGNOSTIC_BUFFER_SIZE)
    buffer.splice(0, buffer.length - PREVIEW_DIAGNOSTIC_BUFFER_SIZE);
}

/** Per-tab ring buffers surfaced in snapshots so the agent sees console errors and failed requests. */
export class PreviewDiagnostics {
  private readonly console = new Map<string, PreviewAutomationConsoleEntry[]>();
  private readonly network = new Map<string, PreviewAutomationNetworkEntry[]>();
  private readonly actions = new Map<string, PreviewAutomationActionEvent[]>();
  private nextActionId = 0;

  private buffer<T>(map: Map<string, T[]>, tabId: string): T[] {
    let entries = map.get(tabId);
    if (!entries) {
      entries = [];
      map.set(tabId, entries);
    }
    return entries;
  }

  recordConsole(tabId: string, entry: Omit<PreviewAutomationConsoleEntry, "timestamp">): void {
    pushBounded(this.buffer(this.console, tabId), {
      ...entry,
      text: boundedText(entry.text),
      timestamp: new Date().toISOString(),
    });
  }

  recordNetwork(tabId: string, entry: Omit<PreviewAutomationNetworkEntry, "timestamp">): void {
    pushBounded(this.buffer(this.network, tabId), {
      ...entry,
      url: boundedText(entry.url),
      ...(entry.errorText !== undefined ? { errorText: boundedText(entry.errorText) } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  /** Records an action as running and returns a completion callback. */
  startAction(
    tabId: string,
    action: string,
  ): (status: "succeeded" | "failed" | "interrupted", error?: string) => void {
    const event: PreviewAutomationActionEvent = {
      id: `action-${++this.nextActionId}`,
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    const buffer = this.buffer(this.actions, tabId);
    pushBounded(buffer, event);
    return (status, error) => {
      const index = buffer.findIndex((candidate) => candidate.id === event.id);
      if (index < 0) return;
      buffer[index] = {
        ...event,
        status,
        completedAt: new Date().toISOString(),
        ...(error ? { error: boundedText(error) } : {}),
      };
    };
  }

  read(tabId: string): {
    consoleEntries: PreviewAutomationConsoleEntry[];
    networkEntries: PreviewAutomationNetworkEntry[];
    actionTimeline: PreviewAutomationActionEvent[];
  } {
    return {
      consoleEntries: [...(this.console.get(tabId) ?? [])],
      networkEntries: [...(this.network.get(tabId) ?? [])],
      actionTimeline: [...(this.actions.get(tabId) ?? [])],
    };
  }

  forget(tabId: string): void {
    this.console.delete(tabId);
    this.network.delete(tabId);
    this.actions.delete(tabId);
  }
}
