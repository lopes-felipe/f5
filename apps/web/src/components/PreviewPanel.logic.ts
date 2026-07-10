export type PreviewWebviewReaderElement = {
  getWebContentsId?: () => number;
};

export function isPreviewWebviewNotReadyError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  // Electron 40 webview methods throw these messages before dom-ready/attachment.
  return message.includes("dom-ready") || message.includes("attached to the DOM");
}

export function readReadyWebviewValue<T>(read: () => T | undefined, fallback: T): T {
  try {
    const value = read();
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return value;
  } catch (cause) {
    if (isPreviewWebviewNotReadyError(cause)) {
      return fallback;
    }
    throw cause;
  }
}

export function readReadyWebContentsId(webview: PreviewWebviewReaderElement): number | null {
  const webContentsId = readReadyWebviewValue(() => webview.getWebContentsId?.(), 0);
  return webContentsId > 0 ? webContentsId : null;
}
