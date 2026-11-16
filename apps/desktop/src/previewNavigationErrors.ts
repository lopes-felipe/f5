const PREVIEW_NAVIGATION_ABORT_ERROR_CODE = -3; // Chromium net::ERR_ABORTED.

interface PreviewNavigationContents {
  loadURL(url: string): Promise<void>;
  on(event: "will-prevent-unload", listener: () => void): unknown;
  removeListener(event: "will-prevent-unload", listener: () => void): unknown;
}

export async function loadPreviewURL(
  contents: PreviewNavigationContents,
  url: string,
): Promise<void> {
  let unloadPrevented = false;
  const onPreventUnload = () => {
    unloadPrevented = true;
  };
  contents.on("will-prevent-unload", onPreventUnload);
  try {
    await contents.loadURL(url);
  } catch (error) {
    // Superseding navigations and blocked unloads both reject with ERR_ABORTED.
    if (unloadPrevented || !isPreviewNavigationAbortError(error)) throw error;
  } finally {
    contents.removeListener("will-prevent-unload", onPreventUnload);
  }
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isPreviewNavigationAbortError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  if (message.includes("ERR_ABORTED")) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  return (
    record.code === "ERR_ABORTED" ||
    record.errno === PREVIEW_NAVIGATION_ABORT_ERROR_CODE ||
    record.errorCode === PREVIEW_NAVIGATION_ABORT_ERROR_CODE
  );
}
