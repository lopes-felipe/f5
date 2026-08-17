import type {
  DesktopPreviewColorScheme,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewViewportSize,
} from "@t3tools/contracts";
import type { IpcMain } from "electron";

export const PREVIEW_IPC_CHANNELS = {
  getConfig: "desktop-preview:get-config",
  createTab: "desktop-preview:create-tab",
  closeTab: "desktop-preview:close-tab",
  registerWebview: "desktop-preview:register-webview",
  navigate: "desktop-preview:navigate",
  goBack: "desktop-preview:go-back",
  goForward: "desktop-preview:go-forward",
  refresh: "desktop-preview:refresh",
  hardReload: "desktop-preview:hard-reload",
  openDevTools: "desktop-preview:open-devtools",
  pickElement: "desktop-preview:pick-element",
  cancelPickElement: "desktop-preview:cancel-pick-element",
  automationStatus: "desktop-preview:automation-status",
  automationSnapshot: "desktop-preview:automation-snapshot",
  automationClick: "desktop-preview:automation-click",
  automationType: "desktop-preview:automation-type",
  automationPress: "desktop-preview:automation-press",
  automationScroll: "desktop-preview:automation-scroll",
  automationEvaluate: "desktop-preview:automation-evaluate",
  automationWaitFor: "desktop-preview:automation-wait-for",
  setViewport: "desktop-preview:set-viewport",
  setColorScheme: "desktop-preview:set-color-scheme",
  captureScreenshot: "desktop-preview:capture-screenshot",
  recordingStart: "desktop-preview:recording-start",
  recordingAppend: "desktop-preview:recording-append",
  recordingStop: "desktop-preview:recording-stop",
  recordingDiscard: "desktop-preview:recording-discard",
} as const;

export interface PreviewIpcOperations {
  readonly getConfig: () => unknown;
  readonly createTab: (tabId: string) => unknown;
  readonly closeTab: (tabId: string) => unknown;
  readonly registerWebview: (tabId: string, webContentsId: number) => unknown;
  readonly navigate: (tabId: string, url: string) => unknown;
  readonly goBack: (tabId: string) => unknown;
  readonly goForward: (tabId: string) => unknown;
  readonly refresh: (tabId: string) => unknown;
  readonly hardReload: (tabId: string) => unknown;
  readonly openDevTools: (tabId: string) => unknown;
  readonly pickElement: (tabId: string) => unknown;
  readonly cancelPickElement: (tabId: string) => unknown;
  readonly automationStatus: (tabId: string) => unknown;
  readonly automationSnapshot: (tabId: string) => unknown;
  readonly automationClick: (tabId: string, input: PreviewAutomationClickInput) => unknown;
  readonly automationType: (tabId: string, input: PreviewAutomationTypeInput) => unknown;
  readonly automationPress: (tabId: string, input: PreviewAutomationPressInput) => unknown;
  readonly automationScroll: (tabId: string, input: PreviewAutomationScrollInput) => unknown;
  readonly automationEvaluate: (tabId: string, input: PreviewAutomationEvaluateInput) => unknown;
  readonly automationWaitFor: (tabId: string, input: PreviewAutomationWaitForInput) => unknown;
  readonly setViewport: (tabId: string, viewport: PreviewViewportSize | null) => unknown;
  readonly setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => unknown;
  readonly captureScreenshot: (tabId: string) => unknown;
  readonly recordingStart: (tabId: string) => unknown;
  readonly recordingAppend: (recordingId: string, chunk: Uint8Array) => unknown;
  readonly recordingStop: (recordingId: string) => unknown;
  readonly recordingDiscard: (recordingId: string) => unknown;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function replaceHandler(
  ipcMain: IpcMain,
  channel: string,
  handler: (...args: unknown[]) => unknown,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (_event, ...args) => handler(...args));
}

export function registerPreviewIpc(ipcMain: IpcMain, operations: PreviewIpcOperations): void {
  const channels = PREVIEW_IPC_CHANNELS;
  replaceHandler(ipcMain, channels.getConfig, () => operations.getConfig());
  replaceHandler(ipcMain, channels.createTab, (tabId) =>
    operations.createTab(nonEmptyString(tabId, "Preview tab id")),
  );
  replaceHandler(ipcMain, channels.closeTab, (tabId) =>
    operations.closeTab(nonEmptyString(tabId, "Preview tab id")),
  );
  replaceHandler(ipcMain, channels.registerWebview, (tabId, webContentsId) => {
    if (
      typeof webContentsId !== "number" ||
      !Number.isInteger(webContentsId) ||
      webContentsId <= 0
    ) {
      return false;
    }
    return operations.registerWebview(nonEmptyString(tabId, "Preview tab id"), webContentsId);
  });
  replaceHandler(ipcMain, channels.navigate, (tabId, url) =>
    operations.navigate(
      nonEmptyString(tabId, "Preview tab id"),
      nonEmptyString(url, "Preview URL"),
    ),
  );
  for (const [channel, operation] of [
    [channels.goBack, operations.goBack],
    [channels.goForward, operations.goForward],
    [channels.refresh, operations.refresh],
    [channels.hardReload, operations.hardReload],
    [channels.openDevTools, operations.openDevTools],
    [channels.pickElement, operations.pickElement],
    [channels.cancelPickElement, operations.cancelPickElement],
    [channels.automationStatus, operations.automationStatus],
    [channels.automationSnapshot, operations.automationSnapshot],
    [channels.captureScreenshot, operations.captureScreenshot],
    [channels.recordingStart, operations.recordingStart],
  ] as const) {
    replaceHandler(ipcMain, channel, (tabId) => operation(nonEmptyString(tabId, "Preview tab id")));
  }
  replaceHandler(ipcMain, channels.automationClick, (tabId, input) =>
    operations.automationClick(
      nonEmptyString(tabId, "Preview tab id"),
      input as PreviewAutomationClickInput,
    ),
  );
  replaceHandler(ipcMain, channels.automationType, (tabId, input) =>
    operations.automationType(
      nonEmptyString(tabId, "Preview tab id"),
      input as PreviewAutomationTypeInput,
    ),
  );
  replaceHandler(ipcMain, channels.automationPress, (tabId, input) =>
    operations.automationPress(
      nonEmptyString(tabId, "Preview tab id"),
      input as PreviewAutomationPressInput,
    ),
  );
  replaceHandler(ipcMain, channels.automationScroll, (tabId, input) =>
    operations.automationScroll(
      nonEmptyString(tabId, "Preview tab id"),
      input as PreviewAutomationScrollInput,
    ),
  );
  replaceHandler(ipcMain, channels.automationEvaluate, (tabId, input) =>
    operations.automationEvaluate(
      nonEmptyString(tabId, "Preview tab id"),
      input as PreviewAutomationEvaluateInput,
    ),
  );
  replaceHandler(ipcMain, channels.automationWaitFor, (tabId, input) =>
    operations.automationWaitFor(
      nonEmptyString(tabId, "Preview tab id"),
      input as PreviewAutomationWaitForInput,
    ),
  );
  replaceHandler(ipcMain, channels.setViewport, (tabId, viewport) => {
    if (viewport === null) {
      return operations.setViewport(nonEmptyString(tabId, "Preview tab id"), null);
    }
    if (!viewport || typeof viewport !== "object") return false;
    const candidate = viewport as Partial<PreviewViewportSize>;
    if (
      typeof candidate.width !== "number" ||
      typeof candidate.height !== "number" ||
      typeof candidate.revision !== "number"
    ) {
      return false;
    }
    return operations.setViewport(nonEmptyString(tabId, "Preview tab id"), {
      width: candidate.width,
      height: candidate.height,
      revision: candidate.revision,
    });
  });
  replaceHandler(ipcMain, channels.setColorScheme, (tabId, colorScheme) => {
    if (colorScheme !== "system" && colorScheme !== "light" && colorScheme !== "dark") {
      return false;
    }
    return operations.setColorScheme(
      nonEmptyString(tabId, "Preview tab id"),
      colorScheme as DesktopPreviewColorScheme,
    );
  });
  replaceHandler(ipcMain, channels.recordingAppend, (recordingId, chunk) => {
    const bytes: Uint8Array | null =
      chunk instanceof ArrayBuffer
        ? new Uint8Array(chunk)
        : ArrayBuffer.isView(chunk)
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice()
          : null;
    if (!bytes) throw new Error("Preview recording chunk is invalid.");
    return operations.recordingAppend(nonEmptyString(recordingId, "Preview recording id"), bytes);
  });
  replaceHandler(ipcMain, channels.recordingStop, (recordingId) =>
    operations.recordingStop(nonEmptyString(recordingId, "Preview recording id")),
  );
  replaceHandler(ipcMain, channels.recordingDiscard, (recordingId) =>
    operations.recordingDiscard(nonEmptyString(recordingId, "Preview recording id")),
  );
}
