import path from "node:path";

import type {
  DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingStartResult,
  DesktopPreviewColorScheme,
  PreviewArtifact,
  PreviewViewportSize,
} from "@t3tools/contracts";
import type { WebContents } from "electron";

import { PreviewArtifactStore } from "./PreviewArtifactStore";

export interface PreviewTabEntry {
  webContentsId: number | null;
  zoomFactor: number;
  viewport: PreviewViewportSize | null;
  colorScheme: DesktopPreviewColorScheme;
  faviconDataUrl: string | null;
  faviconRequestGeneration: number;
  removeListeners: Array<() => void>;
}

interface ActiveRecording {
  readonly recordingId: string;
  readonly tabId: string;
  readonly guest: WebContents;
  readonly onDebuggerMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
  readonly detachDebuggerOnStop: boolean;
  readonly limitTimer: ReturnType<typeof setTimeout>;
  readonly removeGuestListeners: () => void;
  stopped: boolean;
}

export interface PreviewRuntimeOptions {
  readonly stateDirectory: string;
  readonly defaultZoomFactor: number;
  readonly getWebContents: (tabId: string) => WebContents | null;
  readonly emitRecordingFrame: (frame: DesktopPreviewRecordingFrame) => void;
  readonly onTabStateChanged?: (tabId: string) => void;
}

const RECORDING_FAILSAFE_TIMEOUT_MS = 5 * 60 * 1000 + 5_000;

export class PreviewRuntime {
  readonly tabs = new Map<string, PreviewTabEntry>();
  readonly #defaultZoomFactor: number;
  readonly #getWebContents: (tabId: string) => WebContents | null;
  readonly #emitRecordingFrame: (frame: DesktopPreviewRecordingFrame) => void;
  readonly #onTabStateChanged: (tabId: string) => void;
  readonly #artifactStore: PreviewArtifactStore;
  readonly #recordings = new Map<string, ActiveRecording>();

  constructor(options: PreviewRuntimeOptions) {
    this.#defaultZoomFactor = options.defaultZoomFactor;
    this.#getWebContents = options.getWebContents;
    this.#emitRecordingFrame = options.emitRecordingFrame;
    this.#onTabStateChanged = options.onTabStateChanged ?? (() => undefined);
    this.#artifactStore = new PreviewArtifactStore({
      directory: path.join(options.stateDirectory, "preview-artifacts"),
    });
  }

  initialize(): Promise<void> {
    return this.#artifactStore.initialize();
  }

  ensureTab(tabId: unknown): PreviewTabEntry | null {
    if (typeof tabId !== "string" || tabId.trim().length === 0) return null;
    let entry = this.tabs.get(tabId) ?? null;
    if (!entry) {
      entry = {
        webContentsId: null,
        zoomFactor: this.#defaultZoomFactor,
        viewport: null,
        colorScheme: "system",
        faviconDataUrl: null,
        faviconRequestGeneration: 0,
        removeListeners: [],
      };
      this.tabs.set(tabId, entry);
    }
    return entry;
  }

  lookupTab(tabId: unknown): PreviewTabEntry | null {
    if (typeof tabId !== "string" || tabId.trim().length === 0) return null;
    return this.tabs.get(tabId) ?? null;
  }

  setViewport(tabId: string, viewport: PreviewViewportSize | null): boolean {
    const entry = this.ensureTab(tabId);
    if (!entry) return false;
    if (viewport === null) {
      entry.viewport = null;
      this.#onTabStateChanged(tabId);
      return true;
    }
    if (viewport.width < 320 || viewport.height < 320) return false;
    if (entry.viewport && viewport.revision <= entry.viewport.revision) return false;
    entry.viewport = {
      width: Math.floor(viewport.width),
      height: Math.floor(viewport.height),
      revision: Math.floor(viewport.revision),
    };
    this.#onTabStateChanged(tabId);
    return true;
  }

  async setColorScheme(tabId: string, colorScheme: DesktopPreviewColorScheme): Promise<boolean> {
    const entry = this.ensureTab(tabId);
    if (!entry) return false;
    const guest = this.#getWebContents(tabId);
    if (!guest || guest.isDestroyed()) return false;
    const detachDebugger = !guest.debugger.isAttached();
    try {
      if (detachDebugger) guest.debugger.attach("1.3");
      await guest.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-color-scheme",
            value: colorScheme === "system" ? "" : colorScheme,
          },
        ],
      });
      entry.colorScheme = colorScheme;
      this.#onTabStateChanged(tabId);
      return true;
    } finally {
      if (detachDebugger && guest.debugger.isAttached()) guest.debugger.detach();
    }
  }

  async captureScreenshot(tabId: string): Promise<PreviewArtifact> {
    const guest = this.#requireGuest(tabId);
    const image = await guest.capturePage();
    const size = image.getSize();
    return this.#artifactStore.captureScreenshot({
      png: image.toPNG(),
      width: size.width,
      height: size.height,
    });
  }

  async startRecording(tabId: string): Promise<DesktopPreviewRecordingStartResult> {
    if ([...this.#recordings.values()].some((recording) => recording.tabId === tabId)) {
      throw new Error("This preview tab is already recording.");
    }
    const guest = this.#requireGuest(tabId);
    const viewport = this.lookupTab(tabId)?.viewport;
    const capture = await guest.capturePage();
    const captureSize = capture.getSize();
    const recordingHandle = await this.#artifactStore.beginRecording({
      tabId,
      width: viewport?.width ?? captureSize.width,
      height: viewport?.height ?? captureSize.height,
    });
    const detachDebuggerOnStop = !guest.debugger.isAttached();

    let recording!: ActiveRecording;
    const onGuestLost = () => {
      void this.discardRecording(recording.recordingId);
    };
    const limitTimer = setTimeout(() => {
      void this.discardRecording(recording.recordingId);
    }, RECORDING_FAILSAFE_TIMEOUT_MS);
    limitTimer.unref?.();
    recording = {
      recordingId: recordingHandle.recordingId,
      tabId,
      guest,
      detachDebuggerOnStop,
      limitTimer,
      removeGuestListeners: () => {
        guest.off("destroyed", onGuestLost);
        guest.off("render-process-gone", onGuestLost);
      },
      stopped: false,
      onDebuggerMessage: (_event, method, params) => {
        if (method !== "Page.screencastFrame" || recording.stopped) return;
        const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
        try {
          if (typeof params.data !== "string") return;
          const metadata =
            params.metadata && typeof params.metadata === "object"
              ? (params.metadata as Record<string, unknown>)
              : {};
          this.#emitRecordingFrame({
            recordingId: recording.recordingId,
            tabId,
            data: params.data,
            width:
              typeof metadata.deviceWidth === "number"
                ? Math.max(1, Math.floor(metadata.deviceWidth))
                : (viewport?.width ?? captureSize.width),
            height:
              typeof metadata.deviceHeight === "number"
                ? Math.max(1, Math.floor(metadata.deviceHeight))
                : (viewport?.height ?? captureSize.height),
          });
        } finally {
          if (sessionId !== null && guest.debugger.isAttached()) {
            void guest.debugger
              .sendCommand("Page.screencastFrameAck", { sessionId })
              .catch(() => undefined);
          }
        }
      },
    };
    this.#recordings.set(recording.recordingId, recording);
    guest.once("destroyed", onGuestLost);
    guest.once("render-process-gone", onGuestLost);
    guest.debugger.on("message", recording.onDebuggerMessage);
    try {
      if (detachDebuggerOnStop) guest.debugger.attach("1.3");
      await guest.debugger.sendCommand("Page.enable");
      await guest.debugger.sendCommand("Page.startScreencast", {
        format: "jpeg",
        quality: 75,
        everyNthFrame: 1,
      });
    } catch (cause) {
      await this.discardRecording(recording.recordingId);
      throw cause;
    }
    return recordingHandle;
  }

  appendRecordingChunk(recordingId: string, chunk: Uint8Array): Promise<void> {
    if (!this.#recordings.has(recordingId)) throw new Error("Unknown preview recording.");
    return this.#artifactStore.appendRecordingChunk(recordingId, chunk);
  }

  async stopRecording(recordingId: string): Promise<PreviewArtifact> {
    const recording = this.#recordings.get(recordingId);
    if (!recording) throw new Error("Unknown preview recording.");
    await this.#stopScreencast(recording);
    try {
      const artifact = await this.#artifactStore.commitRecording(recordingId);
      this.#recordings.delete(recordingId);
      return artifact;
    } catch (cause) {
      this.#recordings.delete(recordingId);
      await this.#artifactStore.discardRecording(recordingId).catch(() => undefined);
      throw cause;
    }
  }

  async discardRecording(recordingId: string): Promise<void> {
    const recording = this.#recordings.get(recordingId);
    if (recording) {
      await this.#stopScreencast(recording).catch(() => undefined);
      this.#recordings.delete(recordingId);
    }
    await this.#artifactStore.discardRecording(recordingId);
  }

  async discardRecordingsForTab(tabId: string): Promise<void> {
    await Promise.all(
      [...this.#recordings.values()]
        .filter((recording) => recording.tabId === tabId)
        .map((recording) => this.discardRecording(recording.recordingId)),
    );
  }

  async resetRendererOwnedResources(): Promise<void> {
    await Promise.all([...this.#recordings.keys()].map((id) => this.discardRecording(id)));
    for (const [tabId, entry] of this.tabs) {
      for (const removeListener of entry.removeListeners.splice(0)) {
        removeListener();
      }
      const guest = this.#getWebContents(tabId);
      entry.webContentsId = null;
      if (guest && !guest.isDestroyed()) {
        guest.close();
      }
    }
    this.tabs.clear();
  }

  async dispose(): Promise<void> {
    await this.resetRendererOwnedResources();
    await this.#artifactStore.dispose();
  }

  #requireGuest(tabId: string): WebContents {
    const guest = this.#getWebContents(tabId);
    if (!guest || guest.isDestroyed()) throw new Error("Preview webview is not attached.");
    return guest;
  }

  async #stopScreencast(recording: ActiveRecording): Promise<void> {
    if (recording.stopped) return;
    recording.stopped = true;
    clearTimeout(recording.limitTimer);
    recording.removeGuestListeners();
    recording.guest.debugger.off("message", recording.onDebuggerMessage);
    if (recording.guest.debugger.isAttached()) {
      await recording.guest.debugger.sendCommand("Page.stopScreencast").catch(() => undefined);
      if (recording.detachDebuggerOnStop && recording.guest.debugger.isAttached()) {
        recording.guest.debugger.detach();
      }
    }
  }
}
